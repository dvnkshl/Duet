import fs from "fs";
import path from "path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  AgentName,
  Config,
  DecisionMode,
  RunContext,
  RunMode,
} from "./types.js";
import { loadConfig, ensureConfigDir } from "./config.js";
import { runAgentPhase } from "./agents.js";
import { runCommand } from "./exec.js";
import {
  ensureDir,
  extractJson,
  readText,
  timestampId,
  writeText,
} from "./utils.js";
import { copyWorkspace, syncWorkspace } from "./workspace.js";
import { ensureWorktree, gitDiff, gitStatusFiles, isGitRepo } from "./git.js";
import {
  formatVerification,
  verifyAgents,
  verificationFailures,
} from "./verify.js";
import { buildContextPack } from "./context.js";
import { createMemoryStore, MemoryEntry, MemoryStore } from "./memory.js";
import { appendTranscript } from "./transcript.js";
import type { TranscriptStreamOptions } from "./transcript.js";

export type OrchestrateOptions = {
  task: string;
  sessionId?: string;
  branchFrom?: string;
  branchPrompt?: string;
  applyPatch?: boolean;
  decisionMode?: DecisionMode;
  mode?: RunMode;
  stream?: boolean;
  ui?: boolean;
  interactive?: boolean;
};

type Decision = {
  mode: DecisionMode;
  winner: AgentName | "neither";
  rationale: string;
  judgeAgent?: AgentName;
  executionDriver?: AgentName;
};

export async function orchestrate(options: OrchestrateOptions): Promise<void> {
  const rootDir = process.cwd();
  ensureConfigDir(rootDir);

  const config = loadConfig(rootDir);
  const effectiveConfig: Config = options.interactive
    ? {
        ...config,
        decision: options.decisionMode
          ? config.decision
          : {
              ...(config.decision ?? { mode: "debate" }),
              mode: "debate",
            },
        implementation: {
          ...(config.implementation ?? {}),
          mode: "joint",
          maxRounds: config.implementation?.maxRounds ?? 2,
          swapDriverEachRound: true,
        },
      }
    : config;

  const isGit = await isGitRepo(rootDir);
  const orchestratorDir = path.join(rootDir, ".orchestrator");
  const sessionsDir = path.join(orchestratorDir, "sessions");

  if (options.branchFrom && !options.sessionId) {
    throw new Error("Branching requires --session to be set.");
  }
  if (options.branchFrom && !options.branchPrompt) {
    throw new Error("Branching requires --branch-prompt to be set.");
  }

  const sessionId = options.sessionId ?? timestampId("session");
  const sessionDir = path.join(sessionsDir, sessionId);
  const sessionFile = path.join(sessionDir, "session.json");

  let sessionTask = options.task;
  if (fs.existsSync(sessionFile)) {
    const existing = JSON.parse(fs.readFileSync(sessionFile, "utf8")) as {
      task: string;
    };
    sessionTask = existing.task;
  } else {
    ensureDir(sessionDir);
    writeText(
      sessionFile,
      JSON.stringify(
        {
          sessionId,
          task: options.task,
          createdAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
  }

  const runId = timestampId("run");
  const runDir = path.join(sessionDir, "runs", runId);
  ensureDir(runDir);

  const context: RunContext = {
    sessionId,
    runId,
    task: sessionTask,
    createdAt: new Date().toISOString(),
    parentRunId: options.branchFrom,
    branchPrompt: options.branchPrompt,
    runMode: options.mode ?? "full",
  };

  writeText(
    path.join(runDir, "context.json"),
    JSON.stringify(context, null, 2)
  );

  writeText(
    path.join(runDir, "task.md"),
    renderTask(sessionTask, options.branchPrompt)
  );

  const verification = await verifyAgents(effectiveConfig);
  writeText(
    path.join(runDir, "verify.json"),
    JSON.stringify(verification, null, 2)
  );
  const failures = verificationFailures(verification);
  if (failures.length > 0) {
    const report = formatVerification(failures);
    throw new Error(`Agent verification failed:\n${report}`);
  }

  const agentMeta = verification.reduce(
    (acc, item) => {
      acc[item.agent] = {
        version: item.version,
        capabilities: item.capabilities ?? [],
      };
      return acc;
    },
    {} as Record<AgentName, { version?: string; capabilities?: string[] }>
  );

  const memoryStore = createMemoryStore(effectiveConfig.memory, rootDir);
  const memoryQuery = [context.task, context.branchPrompt].filter(Boolean).join(" ");
  const memoryEntries =
    memoryStore && memoryQuery
      ? memoryStore.query(memoryQuery, effectiveConfig.memory?.maxResults ?? 5)
      : [];

  if (options.branchFrom) {
    const parentRun = path.join(sessionDir, "runs", options.branchFrom);
    if (!fs.existsSync(parentRun)) {
      throw new Error(`Parent run not found: ${options.branchFrom}`);
    }
  }

  const parentSummary = options.branchFrom
    ? readText(
        path.join(sessionDir, "runs", options.branchFrom, "final", "summary.md")
      )
    : null;

  const sharedContext = await buildContextPack(
    rootDir,
    runDir,
    context,
    effectiveConfig,
    memoryEntries,
    isGit
  );

  const transcriptStream: TranscriptStreamOptions = {
    jsonl: Boolean(options.stream),
    ui: Boolean(options.ui),
    uiShowPrompts: Boolean(options.ui),
    uiMaxChars: options.ui ? 200000 : undefined,
  };
  const agentTimeoutMs = effectiveConfig.limits?.agentTimeoutMs;
  const judgeTimeoutMs = effectiveConfig.limits?.judgeTimeoutMs ?? agentTimeoutMs;

  const analysisWorktrees = await ensureAnalysisWorktrees(
    rootDir,
    context.runId,
    isGit,
    effectiveConfig
  );

  await runPlanPhase(
    effectiveConfig,
    context,
    runDir,
    parentSummary,
    agentMeta,
    sharedContext.summary,
    analysisWorktrees,
    transcriptStream,
    agentTimeoutMs
  );
  await runProposePhase(
    effectiveConfig,
    context,
    runDir,
    parentSummary,
    agentMeta,
    sharedContext.summary,
    analysisWorktrees,
    transcriptStream,
    agentTimeoutMs
  );

  const decisionMode =
    options.decisionMode ?? (options.interactive ? "debate" : undefined);
  const decision = await runDecisionPhase(
    effectiveConfig,
    context,
    runDir,
    decisionMode,
    agentMeta,
    sharedContext.summary,
    analysisWorktrees,
    transcriptStream,
    judgeTimeoutMs
  );

  const executionPlan = await runExecutionPlanPhase(
    effectiveConfig,
    context,
    runDir,
    decision,
    agentMeta,
    sharedContext.summary,
    analysisWorktrees,
    transcriptStream,
    agentTimeoutMs
  );

  if (options.interactive) {
    appendTranscript(
      runDir,
      {
        timestamp: new Date().toISOString(),
        phase: "interactive",
        role: "system",
        kind: "note",
        content:
          "Execution plan generated. Waiting for your approval to execute implementation.",
      },
      transcriptStream
    );

    let shouldExecute = true;
    let driverChoice: "auto" | "codex" | "claude" = "auto";

    if (process.stdin.isTTY) {
      const rl = readline.createInterface({ input, output });
      try {
        shouldExecute = await askYesNo(
          rl,
          "Execute the implementation now? (y/N) ",
          false
        );
        appendTranscript(
          runDir,
          {
            timestamp: new Date().toISOString(),
            phase: "interactive",
            role: "system",
            kind: "note",
            content: `User approval: ${shouldExecute ? "yes" : "no"}`,
          },
          transcriptStream
        );

        if (shouldExecute) {
          driverChoice = await askChoice(
            rl,
            "Pick implementation driver: [1] auto (decision)  [2] codex  [3] claude  > ",
            ["auto", "codex", "claude"],
            0
          );
          appendTranscript(
            runDir,
            {
              timestamp: new Date().toISOString(),
              phase: "interactive",
              role: "system",
              kind: "note",
              content: `Driver choice: ${driverChoice}`,
            },
            transcriptStream
          );
        }
      } finally {
        rl.close();
      }
    } else {
      // Non-interactive stdin (piped/CI): avoid hanging and proceed with defaults.
      appendTranscript(
        runDir,
        {
          timestamp: new Date().toISOString(),
          phase: "interactive",
          role: "system",
          kind: "note",
          content:
            "Non-TTY stdin detected; auto-approving execution and using auto driver.",
        },
        transcriptStream
      );
    }

    if (!shouldExecute) {
      appendTranscript(
        runDir,
        {
          timestamp: new Date().toISOString(),
          phase: "interactive",
          role: "system",
          kind: "note",
          content: "Execution skipped by user.",
        },
        transcriptStream
      );
      await runFinalPhase(runDir, decision, effectiveConfig);
      persistRunMemory(memoryStore, runDir, context, decision);
      appendTranscript(
        runDir,
        {
          timestamp: new Date().toISOString(),
          phase: "final",
          role: "system",
          kind: "note",
          content: [
            `Winner: ${decision.winner}`,
            `Summary: ${path.join(runDir, "final", "summary.md")}`,
            `Patch: ${path.join(runDir, "final", "final.patch")}`,
            "Execution was skipped; no changes were applied.",
          ].join("\n"),
        },
        transcriptStream
      );
      return;
    }

    if (driverChoice === "codex" || driverChoice === "claude") {
      decision.executionDriver = driverChoice;
      appendTranscript(
        runDir,
        {
          timestamp: new Date().toISOString(),
          phase: "interactive",
          role: "system",
          kind: "note",
          content: `Execution driver overridden to: ${driverChoice}`,
        },
        transcriptStream
      );
    }
  }

  appendTranscript(
    runDir,
    {
      timestamp: new Date().toISOString(),
      phase: "implement",
      role: "system",
      kind: "note",
      content: "Starting implementation phase.",
    },
    transcriptStream
  );

  await runImplementationPhase(
    effectiveConfig,
    context,
    runDir,
    decision,
    isGit,
    rootDir,
    agentMeta,
    sharedContext.summary,
    executionPlan,
    transcriptStream,
    agentTimeoutMs
  );

  await runReviewPhase(
    effectiveConfig,
    context,
    runDir,
    decision,
    rootDir,
    agentMeta,
    sharedContext.summary,
    transcriptStream,
    agentTimeoutMs
  );

  await runConvergePhase(
    effectiveConfig,
    context,
    runDir,
    decision,
    isGit,
    rootDir,
    agentMeta,
    sharedContext.summary,
    transcriptStream,
    agentTimeoutMs
  );
  await runFinalPhase(runDir, decision, effectiveConfig);
  persistRunMemory(memoryStore, runDir, context, decision);

  if (options.applyPatch) {
    await applyWinnerPatch(rootDir, runDir, decision, isGit, effectiveConfig);
  }

  appendTranscript(
    runDir,
    {
      timestamp: new Date().toISOString(),
      phase: "final",
      role: "system",
      kind: "note",
      content: [
        `Winner: ${decision.winner}`,
        `Summary: ${path.join(runDir, "final", "summary.md")}`,
        `Patch: ${path.join(runDir, "final", "final.patch")}`,
        options.applyPatch ? `Apply log: ${path.join(runDir, "final", "apply.log")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
    transcriptStream
  );
}

function renderTask(task: string, branchPrompt?: string): string {
  if (!branchPrompt) {
    return task;
  }
  return `${task}\n\nBranch prompt:\n${branchPrompt}`;
}

async function runPlanPhase(
  config: Config,
  context: RunContext,
  runDir: string,
  parentSummary: string | null,
  agentMeta: Record<AgentName, { version?: string; capabilities?: string[] }>,
  sharedContext: string,
  analysisWorktrees: Partial<Record<AgentName, string>>,
  transcriptStream: TranscriptStreamOptions,
  timeoutMs?: number
): Promise<void> {
  const phaseDir = path.join(runDir, "plan");
  ensureDir(phaseDir);

  const basePrompt = buildPlanPrompt(context, parentSummary, sharedContext);
  appendTranscript(
    runDir,
    {
      timestamp: new Date().toISOString(),
      phase: "plan",
      role: "system",
      kind: "prompt",
      content: basePrompt,
    },
    transcriptStream
  );

  const codexResult = await runAgentPhase({
    agentName: "codex",
    agentConfig: config.agents.codex,
    phase: "plan",
    prompt: basePrompt,
    cwd: analysisWorktrees.codex ?? process.cwd(),
    outputPath: path.join(phaseDir, "codex.md"),
    logDir: path.join(phaseDir, "codex"),
    context,
    agentVersion: agentMeta.codex?.version,
    capabilities: agentMeta.codex?.capabilities,
    timeoutMs,
  });
  appendTranscript(
    runDir,
    {
      timestamp: new Date().toISOString(),
      phase: "plan",
      role: "agent",
      agent: "codex",
      kind: "response",
      content: formatAgentOutput(codexResult),
    },
    transcriptStream
  );

  const claudeResult = await runAgentPhase({
    agentName: "claude",
    agentConfig: config.agents.claude,
    phase: "plan",
    prompt: basePrompt,
    cwd: analysisWorktrees.claude ?? process.cwd(),
    outputPath: path.join(phaseDir, "claude.md"),
    logDir: path.join(phaseDir, "claude"),
    context,
    agentVersion: agentMeta.claude?.version,
    capabilities: agentMeta.claude?.capabilities,
    timeoutMs,
  });
  appendTranscript(
    runDir,
    {
      timestamp: new Date().toISOString(),
      phase: "plan",
      role: "agent",
      agent: "claude",
      kind: "response",
      content: formatAgentOutput(claudeResult),
    },
    transcriptStream
  );
}

async function runProposePhase(
  config: Config,
  context: RunContext,
  runDir: string,
  parentSummary: string | null,
  agentMeta: Record<AgentName, { version?: string; capabilities?: string[] }>,
  sharedContext: string,
  analysisWorktrees: Partial<Record<AgentName, string>>,
  transcriptStream: TranscriptStreamOptions,
  timeoutMs?: number
): Promise<void> {
  const phaseDir = path.join(runDir, "propose");
  ensureDir(phaseDir);

  const basePrompt = buildProposePrompt(context, parentSummary, sharedContext);
  appendTranscript(
    runDir,
    {
      timestamp: new Date().toISOString(),
      phase: "propose",
      role: "system",
      kind: "prompt",
      content: basePrompt,
    },
    transcriptStream
  );

  const codexResult = await runAgentPhase({
    agentName: "codex",
    agentConfig: config.agents.codex,
    phase: "propose",
    prompt: basePrompt,
    cwd: analysisWorktrees.codex ?? process.cwd(),
    outputPath: path.join(phaseDir, "codex.md"),
    logDir: path.join(phaseDir, "codex"),
    context,
    agentVersion: agentMeta.codex?.version,
    capabilities: agentMeta.codex?.capabilities,
    timeoutMs,
  });
  appendTranscript(
    runDir,
    {
      timestamp: new Date().toISOString(),
      phase: "propose",
      role: "agent",
      agent: "codex",
      kind: "response",
      content: formatAgentOutput(codexResult),
    },
    transcriptStream
  );

  const claudeResult = await runAgentPhase({
    agentName: "claude",
    agentConfig: config.agents.claude,
    phase: "propose",
    prompt: basePrompt,
    cwd: analysisWorktrees.claude ?? process.cwd(),
    outputPath: path.join(phaseDir, "claude.md"),
    logDir: path.join(phaseDir, "claude"),
    context,
    agentVersion: agentMeta.claude?.version,
    capabilities: agentMeta.claude?.capabilities,
    timeoutMs,
  });
  appendTranscript(
    runDir,
    {
      timestamp: new Date().toISOString(),
      phase: "propose",
      role: "agent",
      agent: "claude",
      kind: "response",
      content: formatAgentOutput(claudeResult),
    },
    transcriptStream
  );
}

async function runDecisionPhase(
  config: Config,
  context: RunContext,
  runDir: string,
  overrideMode?: DecisionMode,
  agentMeta?: Record<AgentName, { version?: string; capabilities?: string[] }>,
  sharedContext?: string,
  analysisWorktrees: Partial<Record<AgentName, string>> = {},
  transcriptStream?: TranscriptStreamOptions,
  timeoutMs?: number
): Promise<Decision> {
  const phaseDir = path.join(runDir, "decide");
  ensureDir(phaseDir);

  const planCodex = readText(path.join(runDir, "plan", "codex.md")) ?? "";
  const planClaude = readText(path.join(runDir, "plan", "claude.md")) ?? "";
  const propCodex = readText(path.join(runDir, "propose", "codex.md")) ?? "";
  const propClaude = readText(path.join(runDir, "propose", "claude.md")) ?? "";

  const decisionConfig = config.decision ?? { mode: "neither" };
  const mode = overrideMode ?? decisionConfig.mode;

  if (mode === "judge") {
    const judgeAgent = decisionConfig.judgeAgent ?? "codex";
    const prompt = buildJudgePrompt(
      context,
      planCodex,
      planClaude,
      propCodex,
      propClaude,
      sharedContext,
      "independent"
    );
    appendTranscript(
      runDir,
      {
        timestamp: new Date().toISOString(),
        phase: "judge",
        role: "system",
        kind: "prompt",
        content: prompt,
      },
      transcriptStream
    );

    const judgeOutput = path.join(phaseDir, "judge.md");
    const judgeResult = await runAgentPhase({
      agentName: judgeAgent,
      agentConfig: config.agents[judgeAgent],
      phase: "judge",
      prompt,
      cwd: analysisWorktrees[judgeAgent] ?? process.cwd(),
      outputPath: judgeOutput,
      logDir: path.join(phaseDir, "judge"),
      context,
      agentVersion: agentMeta?.[judgeAgent]?.version,
      capabilities: agentMeta?.[judgeAgent]?.capabilities,
      timeoutMs,
    });
    appendTranscript(
      runDir,
      {
        timestamp: new Date().toISOString(),
        phase: "judge",
        role: "agent",
        agent: judgeAgent,
        kind: "response",
      content: formatAgentOutput(judgeResult),
      },
      transcriptStream
    );

    const judgeText = readText(judgeOutput) ?? "";
    const parsed = extractJson<{ winner: Decision["winner"]; rationale: string }>(
      judgeText
    );

    const decision: Decision = {
      mode,
      winner: parsed?.winner ?? "neither",
      rationale:
        parsed?.rationale ??
        "Judge output was not parseable. Defaulting to neither.",
      judgeAgent,
    };

    writeText(
      path.join(phaseDir, "decision.json"),
      JSON.stringify(decision, null, 2)
    );
    appendTranscript(
      runDir,
      {
        timestamp: new Date().toISOString(),
        phase: "judge",
        role: "system",
        kind: "decision",
        content: JSON.stringify(decision, null, 2),
      },
      transcriptStream
    );
    return decision;
  }

  if (mode === "debate") {
    const judgeAgents: AgentName[] = ["codex", "claude"];
    const initialPrompt = buildJudgePrompt(
      context,
      planCodex,
      planClaude,
      propCodex,
      propClaude,
      sharedContext,
      "independent"
    );
    appendTranscript(
      runDir,
      {
        timestamp: new Date().toISOString(),
        phase: "debate",
        role: "system",
        kind: "prompt",
        content: initialPrompt,
        round: 0,
      },
      transcriptStream
    );

    const initialOutputs: Record<AgentName, string> = {
      codex: "",
      claude: "",
    };

    for (const judge of judgeAgents) {
      const outputPath = path.join(phaseDir, `${judge}.md`);
      const judgeResult = await runAgentPhase({
        agentName: judge,
        agentConfig: config.agents[judge],
        phase: "judge",
        prompt: initialPrompt,
        cwd: analysisWorktrees[judge] ?? process.cwd(),
        outputPath,
        logDir: path.join(phaseDir, judge),
        context,
        agentVersion: agentMeta?.[judge]?.version,
        capabilities: agentMeta?.[judge]?.capabilities,
        timeoutMs,
      });
      initialOutputs[judge] = readText(outputPath) ?? "";
      appendTranscript(
        runDir,
        {
          timestamp: new Date().toISOString(),
          phase: "debate",
          role: "agent",
          agent: judge,
          kind: "response",
        content: formatAgentOutput(judgeResult),
          round: 0,
        },
        transcriptStream
      );
    }

    let codexPick = extractJson<{ winner: Decision["winner"]; rationale: string }>(
      initialOutputs.codex
    );
    let claudePick = extractJson<{ winner: Decision["winner"]; rationale: string }>(
      initialOutputs.claude
    );

    if (codexPick?.winner && claudePick?.winner && codexPick.winner === claudePick.winner) {
      const decision: Decision = {
        mode,
        winner: codexPick.winner,
        rationale: `Consensus after initial judgment. Codex: ${codexPick.rationale} Claude: ${claudePick.rationale}`,
      };
      writeText(
        path.join(phaseDir, "decision.json"),
        JSON.stringify(decision, null, 2)
      );
      return decision;
    }

    const rounds = decisionConfig.debateRounds ?? 1;
    let finalDecision: Decision | null = null;
    let priorOutputs = { ...initialOutputs };
    for (let round = 1; round <= rounds; round += 1) {
      const debateDir = path.join(phaseDir, `debate_round_${round}`);
      ensureDir(debateDir);
      const debatePrompt = buildJudgeDebatePrompt(
        context,
        planCodex,
        planClaude,
        propCodex,
        propClaude,
        sharedContext,
        priorOutputs
      );
      appendTranscript(
        runDir,
        {
          timestamp: new Date().toISOString(),
          phase: "debate",
          role: "system",
          kind: "prompt",
          content: debatePrompt,
          round,
        },
        transcriptStream
      );

      const roundOutputs: Record<AgentName, string> = { codex: "", claude: "" };
      for (const judge of judgeAgents) {
        const outputPath = path.join(debateDir, `${judge}.md`);
        const judgeResult = await runAgentPhase({
          agentName: judge,
          agentConfig: config.agents[judge],
          phase: "judge",
          prompt: debatePrompt,
          cwd: analysisWorktrees[judge] ?? process.cwd(),
          outputPath,
          logDir: path.join(debateDir, judge),
          context,
          agentVersion: agentMeta?.[judge]?.version,
          capabilities: agentMeta?.[judge]?.capabilities,
          timeoutMs,
        });
        roundOutputs[judge] = readText(outputPath) ?? "";
        appendTranscript(
          runDir,
          {
            timestamp: new Date().toISOString(),
            phase: "debate",
            role: "agent",
            agent: judge,
            kind: "response",
            content: formatAgentOutput(judgeResult),
            round,
          },
          transcriptStream
        );
      }

      codexPick = extractJson<{ winner: Decision["winner"]; rationale: string }>(
        roundOutputs.codex
      );
      claudePick = extractJson<{ winner: Decision["winner"]; rationale: string }>(
        roundOutputs.claude
      );

      if (codexPick?.winner && claudePick?.winner && codexPick.winner === claudePick.winner) {
        finalDecision = {
          mode,
          winner: codexPick.winner,
          rationale: `Consensus after debate round ${round}. Codex: ${codexPick.rationale} Claude: ${claudePick.rationale}`,
        };
        break;
      }

      priorOutputs = roundOutputs;
    }

    if (!finalDecision) {
      finalDecision = {
        mode,
        winner: "neither",
        rationale: "Judges did not converge after debate rounds.",
      };
    }

    writeText(
      path.join(phaseDir, "decision.json"),
      JSON.stringify(finalDecision, null, 2)
    );
    appendTranscript(
      runDir,
      {
        timestamp: new Date().toISOString(),
        phase: "debate",
        role: "system",
        kind: "decision",
        content: JSON.stringify(finalDecision, null, 2),
      },
      transcriptStream
    );
    return finalDecision;
  }

  const decision: Decision = {
    mode,
    winner: mode === "prefer-codex" ? "codex" : mode === "prefer-claude" ? "claude" : "neither",
    rationale:
      mode === "prefer-codex"
        ? "Rule-based decision: prefer codex."
        : mode === "prefer-claude"
          ? "Rule-based decision: prefer claude."
          : "Rule-based decision: neither.",
  };

  writeText(path.join(phaseDir, "decision.json"), JSON.stringify(decision, null, 2));
  appendTranscript(
    runDir,
    {
      timestamp: new Date().toISOString(),
      phase: "decide",
      role: "system",
      kind: "decision",
      content: JSON.stringify(decision, null, 2),
    },
    transcriptStream
  );
  return decision;
}

async function runExecutionPlanPhase(
  config: Config,
  context: RunContext,
  runDir: string,
  decision: Decision,
  agentMeta: Record<AgentName, { version?: string; capabilities?: string[] }>,
  sharedContext: string,
  analysisWorktrees: Partial<Record<AgentName, string>>,
  transcriptStream: TranscriptStreamOptions,
  timeoutMs?: number
): Promise<string> {
  const phaseDir = path.join(runDir, "execution_plan");
  ensureDir(phaseDir);

  const planCodex = readText(path.join(runDir, "plan", "codex.md")) ?? "";
  const planClaude = readText(path.join(runDir, "plan", "claude.md")) ?? "";
  const propCodex = readText(path.join(runDir, "propose", "codex.md")) ?? "";
  const propClaude = readText(path.join(runDir, "propose", "claude.md")) ?? "";

  const planner: AgentName = decision.winner === "neither" ? "codex" : decision.winner;
  const reviewer: AgentName = otherAgent(planner);

  const plannerPrompt = buildExecutionPlanPrompt(
    context,
    decision,
    planner,
    reviewer,
    sharedContext,
    planCodex,
    planClaude,
    propCodex,
    propClaude
  );
  appendTranscript(
    runDir,
    {
      timestamp: new Date().toISOString(),
      phase: "execution-plan",
      role: "system",
      kind: "prompt",
      content: plannerPrompt,
    },
    transcriptStream
  );
  const plannerOut = path.join(phaseDir, `${planner}_draft.md`);
  const plannerResult = await runAgentPhase({
    agentName: planner,
    agentConfig: config.agents[planner],
    phase: "execution-plan",
    prompt: plannerPrompt,
    cwd: analysisWorktrees[planner] ?? process.cwd(),
    outputPath: plannerOut,
    logDir: path.join(phaseDir, planner),
    context,
    agentVersion: agentMeta[planner]?.version,
    capabilities: agentMeta[planner]?.capabilities,
    timeoutMs,
  });
  appendTranscript(
    runDir,
    {
      timestamp: new Date().toISOString(),
      phase: "execution-plan",
      role: "agent",
      agent: planner,
      kind: "response",
      content: formatAgentOutput(plannerResult),
    },
    transcriptStream
  );

  const plannerText = readText(plannerOut) ?? "";
  const reviewerPrompt = buildExecutionPlanReviewPrompt(
    context,
    decision,
    planner,
    reviewer,
    sharedContext,
    plannerText
  );
  appendTranscript(
    runDir,
    {
      timestamp: new Date().toISOString(),
      phase: "execution-plan",
      role: "system",
      kind: "prompt",
      content: reviewerPrompt,
    },
    transcriptStream
  );
  const reviewerOut = path.join(phaseDir, `${reviewer}_review.md`);
  const reviewerResult = await runAgentPhase({
    agentName: reviewer,
    agentConfig: config.agents[reviewer],
    phase: "execution-plan-review",
    prompt: reviewerPrompt,
    cwd: analysisWorktrees[reviewer] ?? process.cwd(),
    outputPath: reviewerOut,
    logDir: path.join(phaseDir, reviewer),
    context,
    agentVersion: agentMeta[reviewer]?.version,
    capabilities: agentMeta[reviewer]?.capabilities,
    timeoutMs,
  });
  appendTranscript(
    runDir,
    {
      timestamp: new Date().toISOString(),
      phase: "execution-plan",
      role: "agent",
      agent: reviewer,
      kind: "response",
      content: formatAgentOutput(reviewerResult),
    },
    transcriptStream
  );

  const reviewerText = readText(reviewerOut) ?? "";
  const finalPrompt = buildExecutionPlanFinalizePrompt(
    context,
    decision,
    planner,
    reviewer,
    sharedContext,
    plannerText,
    reviewerText
  );
  appendTranscript(
    runDir,
    {
      timestamp: new Date().toISOString(),
      phase: "execution-plan",
      role: "system",
      kind: "prompt",
      content: finalPrompt,
    },
    transcriptStream
  );
  const finalOut = path.join(phaseDir, "final.md");
  const finalResult = await runAgentPhase({
    agentName: planner,
    agentConfig: config.agents[planner],
    phase: "execution-plan-final",
    prompt: finalPrompt,
    cwd: analysisWorktrees[planner] ?? process.cwd(),
    outputPath: finalOut,
    logDir: path.join(phaseDir, `${planner}_final`),
    context,
    agentVersion: agentMeta[planner]?.version,
    capabilities: agentMeta[planner]?.capabilities,
    timeoutMs,
  });
  appendTranscript(
    runDir,
    {
      timestamp: new Date().toISOString(),
      phase: "execution-plan",
      role: "agent",
      agent: planner,
      kind: "response",
      content: formatAgentOutput(finalResult),
    },
    transcriptStream
  );

  const finalText = readText(finalOut) ?? "";
  writeText(
    path.join(phaseDir, "meta.json"),
    JSON.stringify({ planner, reviewer }, null, 2)
  );
  return finalText;
}

async function runImplementationPhase(
  config: Config,
  context: RunContext,
  runDir: string,
  decision: Decision,
  isGit: boolean,
  rootDir: string,
  agentMeta: Record<AgentName, { version?: string; capabilities?: string[] }>,
  sharedContext: string,
  executionPlan: string,
  transcriptStream: TranscriptStreamOptions,
  timeoutMs?: number
): Promise<void> {
  const mode = config.implementation?.mode ?? "parallel";
  if (mode === "joint") {
    await runImplementationPhaseJoint(
      config,
      context,
      runDir,
      decision,
      isGit,
      rootDir,
      agentMeta,
      sharedContext,
      executionPlan,
      transcriptStream,
      timeoutMs
    );
    return;
  }
  await runImplementationPhaseParallel(
    config,
    context,
    runDir,
    decision,
    isGit,
    rootDir,
    agentMeta,
    sharedContext,
    executionPlan,
    transcriptStream,
    timeoutMs
  );
}

async function runImplementationPhaseParallel(
  config: Config,
  context: RunContext,
  runDir: string,
  decision: Decision,
  isGit: boolean,
  rootDir: string,
  agentMeta: Record<AgentName, { version?: string; capabilities?: string[] }>,
  sharedContext: string,
  executionPlan: string,
  transcriptStream: TranscriptStreamOptions,
  timeoutMs?: number
): Promise<void> {
  const phaseDir = path.join(runDir, "implement");
  ensureDir(phaseDir);

  const agents: AgentName[] = ["codex", "claude"];

  for (const agent of agents) {
    const agentDir = path.join(phaseDir, agent);
    ensureDir(agentDir);
    const worktreePath = path.join(rootDir, ".orchestrator", "worktrees", context.runId, agent);

    if (isGit) {
      await ensureWorktree(rootDir, worktreePath);
    } else {
      copyWorkspace(rootDir, worktreePath);
    }

    const planText = readText(path.join(runDir, "plan", `${agent}.md`)) ?? "";
    const proposeText = readText(path.join(runDir, "propose", `${agent}.md`)) ?? "";
    const prompt = buildImplementPrompt(
      context,
      decision,
      planText,
      proposeText,
      sharedContext,
      executionPlan
    );
    appendTranscript(
      runDir,
      {
        timestamp: new Date().toISOString(),
        phase: "implement",
        role: "system",
        kind: "prompt",
        content: prompt,
      },
      transcriptStream
    );

    const result = await runAgentPhase({
      agentName: agent,
      agentConfig: config.agents[agent],
      phase: "implement",
      prompt,
      cwd: worktreePath,
      outputPath: path.join(agentDir, "output.md"),
      logDir: agentDir,
      context,
      agentVersion: agentMeta[agent]?.version,
      capabilities: agentMeta[agent]?.capabilities,
      timeoutMs,
    });
    appendTranscript(
      runDir,
      {
        timestamp: new Date().toISOString(),
        phase: "implement",
        role: "agent",
        agent,
        kind: "response",
        content: formatAgentOutput(result),
      },
      transcriptStream
    );

    const diff = isGit
      ? await gitDiff(worktreePath)
      : await diffDirs(rootDir, worktreePath);

    writeText(path.join(agentDir, "diff.patch"), diff);

    const changedFiles = isGit ? await gitStatusFiles(worktreePath) : [];

    const meta = {
      agent,
      exitCode: result.exitCode,
      changedFiles,
      diffStats: summarizeDiff(diff),
    };

    writeText(path.join(agentDir, "meta.json"), JSON.stringify(meta, null, 2));

    await runAuxCommands(config, worktreePath, agentDir);
  }
}

async function runImplementationPhaseJoint(
  config: Config,
  context: RunContext,
  runDir: string,
  decision: Decision,
  isGit: boolean,
  rootDir: string,
  agentMeta: Record<AgentName, { version?: string; capabilities?: string[] }>,
  sharedContext: string,
  executionPlan: string,
  transcriptStream: TranscriptStreamOptions,
  timeoutMs?: number
): Promise<void> {
  const phaseDir = path.join(runDir, "implement", "joint");
  ensureDir(phaseDir);

  const implConfig = config.implementation ?? {};
  let driver = resolveDriver(implConfig.driver, decision);
  let navigator = otherAgent(driver);

  const maxRounds = implConfig.maxRounds ?? 1;
  const testsDuringLoop = implConfig.testsDuringLoop ?? false;
  const applyNavigatorPatch = implConfig.applyNavigatorPatch ?? "auto";
  const swapDriverOnFail = implConfig.swapDriverOnFail ?? false;
  const swapDriverEachRound = implConfig.swapDriverEachRound ?? false;

  const worktreesRoot = path.join(rootDir, ".orchestrator", "worktrees", context.runId);
  const driverWorktree = path.join(worktreesRoot, "driver");

  if (!fs.existsSync(driverWorktree)) {
    if (isGit) {
      await ensureWorktree(rootDir, driverWorktree);
    } else {
      copyWorkspace(rootDir, driverWorktree);
    }
  }

  let lastTestExit: number | null = null;
  let lastNavigatorNotes = "";
  let lastApplyOk = true;

  for (let round = 1; round <= maxRounds; round += 1) {
    const roundDir = path.join(phaseDir, `round_${round}`);
    ensureDir(roundDir);

    const driverDir = path.join(roundDir, "driver");
    const navigatorDir = path.join(roundDir, "navigator");
    ensureDir(driverDir);
    ensureDir(navigatorDir);

    const driverPlan = readText(path.join(runDir, "plan", `${driver}.md`)) ?? "";
    const driverPropose = readText(path.join(runDir, "propose", `${driver}.md`)) ?? "";

    const driverPrompt = buildJointDriverPrompt(
      context,
      decision,
      driver,
      navigator,
      driverPlan,
      driverPropose,
      sharedContext,
      executionPlan,
      lastNavigatorNotes,
      lastTestExit,
      round,
      maxRounds
    );

    appendTranscript(
      runDir,
      {
        timestamp: new Date().toISOString(),
        phase: "implement",
        role: "system",
        kind: "prompt",
        content: driverPrompt,
        round,
      },
      transcriptStream
    );

    const driverResult = await runAgentPhase({
      agentName: driver,
      agentConfig: config.agents[driver],
      phase: "implement",
      prompt: driverPrompt,
      cwd: driverWorktree,
      outputPath: path.join(driverDir, "output.md"),
      logDir: driverDir,
      context,
      agentVersion: agentMeta[driver]?.version,
      capabilities: agentMeta[driver]?.capabilities,
      timeoutMs,
    });

    appendTranscript(
      runDir,
      {
        timestamp: new Date().toISOString(),
        phase: "implement",
        role: "agent",
        agent: driver,
        kind: "response",
        content: formatAgentOutput(driverResult),
        round,
      },
      transcriptStream
    );

    const driverDiff = isGit
      ? await gitDiff(driverWorktree)
      : await diffDirs(rootDir, driverWorktree);
    writeText(path.join(driverDir, "diff.patch"), driverDiff);

    let testExit: number | null = null;
    if (testsDuringLoop && config.tests?.enabled) {
      const testResult = await runTestsOnce(
        config,
        driverWorktree,
        path.join(driverDir, "test.log"),
        timeoutMs
      );
      testExit = testResult.exitCode;
      appendTranscript(
        runDir,
        {
          timestamp: new Date().toISOString(),
          phase: "implement",
          role: "system",
          kind: "note",
          content: `Driver tests exit code: ${testResult.exitCode}`,
          round,
        },
        transcriptStream
      );
    }

    const navigatorWorktree = path.join(worktreesRoot, `navigator_round_${round}`);
    copyWorkspace(driverWorktree, navigatorWorktree);

    const navigatorPrompt = buildJointNavigatorPrompt(
      context,
      decision,
      driver,
      navigator,
      sharedContext,
      executionPlan,
      driverDiff,
      testExit,
      round,
      maxRounds
    );

    appendTranscript(
      runDir,
      {
        timestamp: new Date().toISOString(),
        phase: "implement",
        role: "system",
        kind: "prompt",
        content: navigatorPrompt,
        round,
      },
      transcriptStream
    );

    const navigatorResult = await runAgentPhase({
      agentName: navigator,
      agentConfig: config.agents[navigator],
      phase: "collab",
      prompt: navigatorPrompt,
      cwd: navigatorWorktree,
      outputPath: path.join(navigatorDir, "output.md"),
      logDir: navigatorDir,
      context,
      agentVersion: agentMeta[navigator]?.version,
      capabilities: agentMeta[navigator]?.capabilities,
      timeoutMs,
    });

    appendTranscript(
      runDir,
      {
        timestamp: new Date().toISOString(),
        phase: "implement",
        role: "agent",
        agent: navigator,
        kind: "response",
        content: formatAgentOutput(navigatorResult),
        round,
      },
      transcriptStream
    );

    const navigatorPatch = await diffDirsBetween(driverWorktree, navigatorWorktree);
    writeText(path.join(navigatorDir, "navigator.patch"), navigatorPatch);

    let applied = false;
    if (applyNavigatorPatch === "auto" && navigatorPatch.trim()) {
      const applyResult = await applyPatchToWorktree(
        driverWorktree,
        path.join(navigatorDir, "navigator.patch"),
        isGit
      );
      applied = applyResult.applied;
      writeText(
        path.join(navigatorDir, "apply.log"),
        `${applyResult.stdout}${applyResult.stderr}`
      );
      appendTranscript(
        runDir,
        {
          timestamp: new Date().toISOString(),
          phase: "implement",
          role: "system",
          kind: "note",
          content: `Navigator patch apply: ${applied ? "ok" : "failed"}`,
          round,
        },
        transcriptStream
      );
    }

    if (testsDuringLoop && config.tests?.enabled) {
      const testResult = await runTestsOnce(
        config,
        driverWorktree,
        path.join(navigatorDir, "post_test.log"),
        timeoutMs
      );
      testExit = testResult.exitCode;
      appendTranscript(
        runDir,
        {
          timestamp: new Date().toISOString(),
          phase: "implement",
          role: "system",
          kind: "note",
          content: `Post-patch tests exit code: ${testResult.exitCode}`,
          round,
        },
        transcriptStream
      );
    }

    lastNavigatorNotes = formatAgentOutput(navigatorResult);
    lastTestExit = testExit;
    lastApplyOk = applied || !navigatorPatch.trim();

    if (!navigatorPatch.trim() && (testExit === null || testExit === 0)) {
      appendTranscript(
        runDir,
        {
          timestamp: new Date().toISOString(),
          phase: "implement",
          role: "system",
          kind: "note",
          content:
            testExit === 0
              ? "Stopping early: tests passing and no navigator changes."
              : "Stopping early: no navigator changes.",
          round,
        },
        transcriptStream
      );
      break;
    }

    if (!lastApplyOk) {
      appendTranscript(
        runDir,
        {
          timestamp: new Date().toISOString(),
          phase: "implement",
          role: "system",
          kind: "note",
          content: "Stopping early: navigator patch failed to apply.",
          round,
        },
        transcriptStream
      );
      break;
    }

    if (swapDriverOnFail && testExit && testExit !== 0) {
      const previousDriver = driver;
      driver = navigator;
      navigator = otherAgent(driver);
      appendTranscript(
        runDir,
        {
          timestamp: new Date().toISOString(),
          phase: "implement",
          role: "system",
          kind: "note",
          content: `Swapping driver role from ${previousDriver} to ${driver} due to failing tests.`,
          round,
        },
        transcriptStream
      );
    } else if (swapDriverEachRound && round < maxRounds) {
      const previousDriver = driver;
      driver = navigator;
      navigator = otherAgent(driver);
      appendTranscript(
        runDir,
        {
          timestamp: new Date().toISOString(),
          phase: "implement",
          role: "system",
          kind: "note",
          content: `Swapping driver role from ${previousDriver} to ${driver} for next round.`,
          round,
        },
        transcriptStream
      );
    }
  }

  const finalPatch = isGit
    ? await gitDiff(driverWorktree)
    : await diffDirs(rootDir, driverWorktree);
  writeText(path.join(phaseDir, "final.patch"), finalPatch);
  const changedFiles = isGit ? await gitStatusFiles(driverWorktree) : [];
  writeText(
    path.join(phaseDir, "meta.json"),
    JSON.stringify(
      {
        driver,
        navigator,
        rounds: maxRounds,
        changedFiles,
        diffStats: summarizeDiff(finalPatch),
      },
      null,
      2
    )
  );
}

async function runAuxCommands(
  config: Config,
  cwd: string,
  agentDir: string
): Promise<void> {
  if (config.tests?.enabled) {
    const result = await runCommand({
      command: config.tests.command,
      args: config.tests.args ?? [],
      cwd,
      captureStdout: true,
      captureStderr: true,
    });
    writeText(
      path.join(agentDir, "test.log"),
      `${result.stdout}${result.stderr}`
    );
    writeText(
      path.join(agentDir, "test.meta.json"),
      JSON.stringify({ exitCode: result.exitCode }, null, 2)
    );
  }

  if (config.lint?.enabled) {
    const result = await runCommand({
      command: config.lint.command,
      args: config.lint.args ?? [],
      cwd,
      captureStdout: true,
      captureStderr: true,
    });
    writeText(
      path.join(agentDir, "lint.log"),
      `${result.stdout}${result.stderr}`
    );
    writeText(
      path.join(agentDir, "lint.meta.json"),
      JSON.stringify({ exitCode: result.exitCode }, null, 2)
    );
  }
}

async function runReviewPhase(
  config: Config,
  context: RunContext,
  runDir: string,
  decision: Decision,
  rootDir: string,
  agentMeta: Record<AgentName, { version?: string; capabilities?: string[] }>,
  sharedContext: string,
  transcriptStream: TranscriptStreamOptions,
  timeoutMs?: number
): Promise<void> {
  if (!config.review?.enabled) {
    return;
  }

  const implementationMode = config.implementation?.mode ?? "parallel";
  if (implementationMode !== "joint" && decision.winner === "neither") {
    return;
  }

  const phaseDir = path.join(runDir, "review");
  ensureDir(phaseDir);

  let patchAuthor = decision.winner === "neither" ? "joint" : decision.winner;
  let diffPath =
    implementationMode === "joint"
      ? path.join(runDir, "implement", "joint", "final.patch")
      : path.join(runDir, "implement", patchAuthor, "diff.patch");
  const reviewCwd =
    implementationMode === "joint"
      ? path.join(rootDir, ".orchestrator", "worktrees", context.runId, "driver")
      : decision.winner === "neither"
        ? process.cwd()
        : path.join(rootDir, ".orchestrator", "worktrees", context.runId, decision.winner);

  if (implementationMode === "joint") {
    const metaPath = path.join(runDir, "implement", "joint", "meta.json");
    const metaText = readText(metaPath);
    if (metaText) {
      try {
        const meta = JSON.parse(metaText) as { driver?: string };
        if (meta.driver) {
          patchAuthor = `joint (driver: ${meta.driver})`;
        }
      } catch {
        patchAuthor = "joint";
      }
    }
  }

  const diffText = readText(diffPath);
  if (!diffText) {
    return;
  }

  const reviewers =
    config.review.reviewer === "both"
      ? (["codex", "claude"] as AgentName[])
      : ([config.review.reviewer] as AgentName[]);

  for (const reviewer of reviewers) {
    const prompt = buildReviewPrompt(
      context,
      patchAuthor,
      diffText,
      sharedContext
    );
    appendTranscript(
      runDir,
      {
        timestamp: new Date().toISOString(),
        phase: "review",
        role: "system",
        kind: "prompt",
        content: prompt,
      },
      transcriptStream
    );
    await runAgentPhase({
      agentName: reviewer,
      agentConfig: config.agents[reviewer],
      phase: "review",
      prompt,
      cwd: reviewCwd,
      outputPath: path.join(phaseDir, `${reviewer}.md`),
      logDir: path.join(phaseDir, reviewer),
      context,
      agentVersion: agentMeta[reviewer]?.version,
      capabilities: agentMeta[reviewer]?.capabilities,
      timeoutMs,
    });
    const reviewText = readText(path.join(phaseDir, `${reviewer}.md`)) ?? "";
    appendTranscript(
      runDir,
      {
        timestamp: new Date().toISOString(),
        phase: "review",
        role: "agent",
        agent: reviewer,
        kind: "response",
        content: reviewText,
      },
      transcriptStream
    );
  }
}

async function runConvergePhase(
  config: Config,
  context: RunContext,
  runDir: string,
  decision: Decision,
  isGit: boolean,
  rootDir: string,
  agentMeta: Record<AgentName, { version?: string; capabilities?: string[] }>,
  sharedContext: string,
  transcriptStream: TranscriptStreamOptions,
  timeoutMs?: number
): Promise<void> {
  if (!config.converge?.enabled) {
    return;
  }
  if (!config.review?.enabled) {
    return;
  }

  const implementationMode = config.implementation?.mode ?? "parallel";
  if (implementationMode !== "joint" && decision.winner === "neither") {
    return;
  }

  const phaseDir = path.join(runDir, "converge");
  ensureDir(phaseDir);

  const worktreesRoot = path.join(rootDir, ".orchestrator", "worktrees", context.runId);
  const canonicalWorktree =
    implementationMode === "joint"
      ? path.join(worktreesRoot, "driver")
      : path.join(worktreesRoot, decision.winner);

  if (!fs.existsSync(canonicalWorktree)) {
    return;
  }

  // Determine who "implemented" (fixer) vs who "critiques" (critic).
  let fixer: AgentName =
    implementationMode === "joint"
      ? resolveDriver(config.implementation?.driver, decision)
      : (decision.winner as AgentName);

  if (implementationMode === "joint") {
    const metaPath = path.join(runDir, "implement", "joint", "meta.json");
    const metaText = readText(metaPath);
    if (metaText) {
      try {
        const meta = JSON.parse(metaText) as { driver?: AgentName };
        if (meta.driver) {
          fixer = meta.driver;
        }
      } catch {
        // ignore
      }
    }
  }

  let critic: AgentName = otherAgent(fixer);

  const reviewers =
    config.review.reviewer === "both"
      ? (["codex", "claude"] as AgentName[])
      : ([config.review.reviewer] as AgentName[]);

  const initialReview = readReviewSummaries(runDir, reviewers);

  const executionPlan = readText(path.join(runDir, "execution_plan", "final.md")) ?? "";

  // Compute current diff + tests (CI decides).
  let currentDiff = isGit
    ? await gitDiff(canonicalWorktree)
    : await diffDirs(rootDir, canonicalWorktree);
  let currentStats = summarizeDiff(currentDiff);
  let currentFiles = extractChangedFilesFromDiff(currentDiff, rootDir, canonicalWorktree);

  let lastTestExit: number | null = null;
  if (config.tests?.enabled) {
    const testResult = await runTestsOnce(
      config,
      canonicalWorktree,
      path.join(phaseDir, "pre_test.log"),
      timeoutMs
    );
    lastTestExit = testResult.exitCode;
    appendTranscript(
      runDir,
      {
        timestamp: new Date().toISOString(),
        phase: "converge",
        role: "system",
        kind: "note",
        content: `Pre-converge tests exit code: ${testResult.exitCode}`,
      },
      transcriptStream
    );
  }

  const needsConverge =
    initialReview.blockers.length > 0 ||
    (lastTestExit !== null && lastTestExit !== 0);

  if (!needsConverge) {
    return;
  }

  const maxRounds = Math.max(1, config.converge.maxRounds ?? 1);
  let finalReview = initialReview;

  for (let round = 1; round <= maxRounds; round += 1) {
    const roundDir = path.join(phaseDir, `round_${round}`);
    ensureDir(roundDir);

    const fixPrompt = buildConvergeFixPrompt(
      context,
      decision,
      fixer,
      critic,
      sharedContext,
      executionPlan,
      finalReview,
      currentFiles,
      currentStats,
      lastTestExit,
      round,
      maxRounds
    );

    appendTranscript(
      runDir,
      {
        timestamp: new Date().toISOString(),
        phase: "converge",
        role: "system",
        kind: "prompt",
        content: fixPrompt,
        round,
      },
      transcriptStream
    );

    const fixerResult = await runAgentPhase({
      agentName: fixer,
      agentConfig: config.agents[fixer],
      phase: "converge",
      prompt: fixPrompt,
      cwd: canonicalWorktree,
      outputPath: path.join(roundDir, "fixer.md"),
      logDir: path.join(roundDir, "fixer"),
      context,
      agentVersion: agentMeta[fixer]?.version,
      capabilities: agentMeta[fixer]?.capabilities,
      timeoutMs,
    });
    appendTranscript(
      runDir,
      {
        timestamp: new Date().toISOString(),
        phase: "converge",
        role: "agent",
        agent: fixer,
        kind: "response",
        content: formatAgentOutput(fixerResult),
        round,
      },
      transcriptStream
    );

    currentDiff = isGit
      ? await gitDiff(canonicalWorktree)
      : await diffDirs(rootDir, canonicalWorktree);
    currentStats = summarizeDiff(currentDiff);
    currentFiles = extractChangedFilesFromDiff(currentDiff, rootDir, canonicalWorktree);
    writeText(path.join(roundDir, "diff.patch"), currentDiff);

    if (config.tests?.enabled) {
      const testResult = await runTestsOnce(
        config,
        canonicalWorktree,
        path.join(roundDir, "test.log"),
        timeoutMs
      );
      lastTestExit = testResult.exitCode;
      appendTranscript(
        runDir,
        {
          timestamp: new Date().toISOString(),
          phase: "converge",
          role: "system",
          kind: "note",
          content: `Round ${round} tests exit code: ${testResult.exitCode}`,
          round,
        },
        transcriptStream
      );
    }

    // Re-review with the other agent (critic). Structured JSON output lets us decide quickly.
    const reviewPrompt = buildReviewPrompt(
      context,
      `converge (fixer: ${fixer})`,
      currentDiff,
      sharedContext
    );
    appendTranscript(
      runDir,
      {
        timestamp: new Date().toISOString(),
        phase: "converge",
        role: "system",
        kind: "prompt",
        content: reviewPrompt,
        round,
      },
      transcriptStream
    );

    const criticResult = await runAgentPhase({
      agentName: critic,
      agentConfig: config.agents[critic],
      phase: "review",
      prompt: reviewPrompt,
      cwd: canonicalWorktree,
      outputPath: path.join(roundDir, "critic.json"),
      logDir: path.join(roundDir, "critic"),
      context,
      agentVersion: agentMeta[critic]?.version,
      capabilities: agentMeta[critic]?.capabilities,
      timeoutMs,
    });

    const criticText = readText(path.join(roundDir, "critic.json")) ?? "";
    appendTranscript(
      runDir,
      {
        timestamp: new Date().toISOString(),
        phase: "converge",
        role: "agent",
        agent: critic,
        kind: "response",
        content: criticText || formatAgentOutput(criticResult),
        round,
      },
      transcriptStream
    );

    finalReview = mergeReviewSummaries([parseReviewSummary(criticText)].filter(Boolean) as ReviewSummary[]);
    writeText(path.join(roundDir, "review.json"), JSON.stringify(finalReview, null, 2));

    const okByReview = finalReview.blockers.length === 0;
    const okByTests = lastTestExit === null || lastTestExit === 0;
    if (okByReview && okByTests) {
      appendTranscript(
        runDir,
        {
          timestamp: new Date().toISOString(),
          phase: "converge",
          role: "system",
          kind: "note",
          content: "Converge complete: no blockers and tests passing (if enabled).",
          round,
        },
        transcriptStream
      );
      break;
    }

    if (round < maxRounds) {
      // Swap roles for next round to get the "panel" feel (bounded).
      const previousFixer = fixer;
      fixer = critic;
      critic = otherAgent(fixer);
      appendTranscript(
        runDir,
        {
          timestamp: new Date().toISOString(),
          phase: "converge",
          role: "system",
          kind: "note",
          content: `Swapping fixer role from ${previousFixer} to ${fixer} for next converge round.`,
          round,
        },
        transcriptStream
      );
    }
  }

  writeText(path.join(phaseDir, "final.patch"), currentDiff);
  writeText(
    path.join(phaseDir, "meta.json"),
    JSON.stringify(
      {
        canonicalWorktree,
        final: finalReview,
        diffStats: currentStats,
        files: currentFiles,
      },
      null,
      2
    )
  );
}

async function runFinalPhase(
  runDir: string,
  decision: Decision,
  config: Config
): Promise<void> {
  const finalDir = path.join(runDir, "final");
  ensureDir(finalDir);

  writeText(path.join(finalDir, "winner.json"), JSON.stringify(decision, null, 2));

  const convergePatch = path.join(runDir, "converge", "final.patch");
  const implementationMode = config.implementation?.mode ?? "parallel";
  const patchPath = fs.existsSync(convergePatch)
    ? convergePatch
    : implementationMode === "joint"
      ? path.join(runDir, "implement", "joint", "final.patch")
      : decision.winner === "neither"
        ? null
        : path.join(runDir, "implement", decision.winner, "diff.patch");

  if (patchPath) {
    const patch = readText(patchPath);
    if (patch) {
      writeText(path.join(finalDir, "final.patch"), patch);
    }
  }

  const summary = buildSummary(runDir, decision);
  writeText(path.join(finalDir, "summary.md"), summary);
}

type ReviewSummary = {
  blockers: Array<{ id: string; summary: string; file?: string; suggested_fix?: string }>;
  warnings: Array<{ id: string; summary: string; file?: string; suggested_fix?: string }>;
  notes: string;
};

function parseReviewSummary(text: string): ReviewSummary | null {
  const parsed = extractJson<{
    ok?: boolean;
    blockers?: Array<{ id?: string; summary?: string; file?: string; suggested_fix?: string }>;
    warnings?: Array<{ id?: string; summary?: string; file?: string; suggested_fix?: string }>;
    notes?: string;
  }>(text);
  if (!parsed) {
    return null;
  }
  const normalize = (
    items: Array<{ id?: string; summary?: string; file?: string; suggested_fix?: string }> | undefined,
    prefix: string
  ) =>
    (items ?? [])
      .map((it, idx) => ({
        id: (it.id ?? `${prefix}-${idx + 1}`).toString(),
        summary: (it.summary ?? "").toString().trim(),
        file: it.file?.toString(),
        suggested_fix: it.suggested_fix?.toString(),
      }))
      .filter((it) => it.summary.length > 0);

  return {
    blockers: normalize(parsed.blockers, "B"),
    warnings: normalize(parsed.warnings, "W"),
    notes: (parsed.notes ?? "").toString(),
  };
}

function readReviewSummaries(runDir: string, reviewers: AgentName[]): ReviewSummary {
  const summaries: ReviewSummary[] = [];
  for (const reviewer of reviewers) {
    const text = readText(path.join(runDir, "review", `${reviewer}.md`)) ?? "";
    const parsed = parseReviewSummary(text);
    if (parsed) {
      summaries.push(parsed);
    }
  }
  return mergeReviewSummaries(summaries);
}

function mergeReviewSummaries(summaries: ReviewSummary[]): ReviewSummary {
  const blockers: ReviewSummary["blockers"] = [];
  const warnings: ReviewSummary["warnings"] = [];
  const notes: string[] = [];
  for (const s of summaries) {
    blockers.push(...s.blockers);
    warnings.push(...s.warnings);
    if (s.notes?.trim()) {
      notes.push(s.notes.trim());
    }
  }
  return {
    blockers,
    warnings,
    notes: truncateInline(notes.join(" | "), 240),
  };
}

function buildConvergeFixPrompt(
  context: RunContext,
  decision: Decision,
  fixer: AgentName,
  critic: AgentName,
  sharedContext: string,
  executionPlan: string,
  review: ReviewSummary,
  changedFiles: string[],
  stats: { added: number; removed: number },
  lastTestExit: number | null,
  round: number,
  maxRounds: number
): string {
  const blockers =
    review.blockers.length > 0
      ? review.blockers
          .slice(0, 8)
          .map((b) => `- ${b.id}: ${b.summary}${b.file ? ` (${b.file})` : ""}`)
          .join("\n")
      : "none";
  const warnings =
    review.warnings.length > 0
      ? review.warnings
          .slice(0, 8)
          .map((w) => `- ${w.id}: ${w.summary}${w.file ? ` (${w.file})` : ""}`)
          .join("\n")
      : "none";

  return [
    "Fix issues found in review. Minimal changes only.",
    `Task: ${context.task}`,
    context.runMode ? `Run mode: ${context.runMode}` : "",
    `Round: ${round} of ${maxRounds}`,
    `Fixer: ${fixer} | Critic: ${critic}`,
    `Decision: ${decision.winner} (${truncateInline(decision.rationale, 200)})`,
    lastTestExit === null ? "" : `Latest tests exit code: ${lastTestExit}`,
    `Current diff stats: +${stats.added} -${stats.removed}`,
    changedFiles.length ? `Changed files: ${changedFiles.slice(0, 20).join(", ")}${changedFiles.length > 20 ? " …" : ""}` : "",
    "Blockers:",
    blockers,
    "Warnings:",
    warnings,
    executionPlan ? "Execution plan (keep aligned):" : "",
    truncateInline(executionPlan, 3000),
    "Context (short):",
    truncateInline(sharedContext, 1200),
    "Rules:",
    "- Address blockers first. If you disagree, justify briefly and leave code unchanged.",
    "- Avoid refactors; keep diff small.",
    "- If tests are enabled, aim to make them pass.",
    "- Output only a short 3-6 line summary of what you changed + how to verify.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function applyWinnerPatch(
  rootDir: string,
  runDir: string,
  decision: Decision,
  isGit: boolean,
  config: Config
): Promise<void> {
  const implementationMode = config.implementation?.mode ?? "parallel";
  if (implementationMode !== "joint" && decision.winner === "neither") {
    return;
  }

  const applyLog = path.join(runDir, "final", "apply.log");
  const runId = path.basename(runDir);
  const worktreesRoot = path.join(rootDir, ".orchestrator", "worktrees", runId);
  const sourceWorktree =
    implementationMode === "joint"
      ? path.join(worktreesRoot, "driver")
      : path.join(worktreesRoot, decision.winner);

  // Guardrails: refuse to apply unsafe / oversized patches.
  if (config.guardrails?.enabled) {
    const patchPath = path.join(runDir, "final", "final.patch");
    const patchText = readText(patchPath) ?? "";
    const files = extractChangedFilesFromDiff(
      patchText,
      rootDir,
      isGit ? rootDir : sourceWorktree
    );
    const stats = summarizeDiff(patchText);
    const violations = evaluateGuardrails(config, files, stats);
    if (violations.length > 0) {
      writeText(
        applyLog,
        `Guardrails blocked apply.\n\n${violations
          .map((v) => `- ${v}`)
          .join("\n")}\n`
      );
      return;
    }
  }

  if (isGit) {
    const patchPath = path.join(runDir, "final", "final.patch");
    if (!fs.existsSync(patchPath)) {
      return;
    }

    const applyResult = await runCommand({
      command: "git",
      args: ["apply", patchPath],
      cwd: rootDir,
      captureStdout: true,
      captureStderr: true,
    });
    writeText(applyLog, `${applyResult.stdout}${applyResult.stderr}`);
  } else {
    if (!fs.existsSync(sourceWorktree)) {
      throw new Error(`Worktree not found for apply: ${sourceWorktree}`);
    }

    syncWorkspace(sourceWorktree, rootDir);
    writeText(
      applyLog,
      `Synced worktree into workspace (non-git mode).\nSource: ${sourceWorktree}\nTarget: ${rootDir}\n`
    );
  }

  if (config.tests?.enabled) {
    const testResult = await runCommand({
      command: config.tests.command,
      args: config.tests.args ?? [],
      cwd: rootDir,
      captureStdout: true,
      captureStderr: true,
    });
    writeText(
      path.join(runDir, "final", "tests.log"),
      `${testResult.stdout}${testResult.stderr}`
    );
  }
}

function buildPlanPrompt(
  context: RunContext,
  parentSummary: string | null,
  sharedContext: string
): string {
  const parts = [
    "Plan the task. Keep it short.",
    `Task: ${context.task}`,
    context.runMode ? `Run mode: ${context.runMode}` : "",
    "Output JSON only with keys: steps[], risks[], assumptions[], tests[].",
    "Rules: <= 8 items per list; each item <= 120 chars; no markdown, no extra text.",
  ];
  if (context.branchPrompt) {
    parts.push(`Branch prompt: ${context.branchPrompt}`);
  }
  if (parentSummary) {
    parts.push(`Parent summary: ${truncateInline(parentSummary, 800)}`);
  }
  if (context.runMode === "bugfix") {
    parts.push("Bugfix mode: prioritize diagnosis + minimal fix + regression test.");
  }
  parts.push("Context:");
  parts.push(sharedContext);
  return parts.join("\n\n");
}

function formatAgentOutput(output: { stdout: string; stderr: string }): string {
  const trimmed = output.stdout.trim();
  if (trimmed) {
    return output.stdout;
  }
  return output.stderr.trim() ? output.stderr : "";
}

function buildProposePrompt(
  context: RunContext,
  parentSummary: string | null,
  sharedContext: string
): string {
  const parts = [
    "Propose the solution. Keep it short and concrete.",
    `Task: ${context.task}`,
    context.runMode ? `Run mode: ${context.runMode}` : "",
    "Output JSON only with keys: recommended, alternative, tradeoffs[], acceptance[], tests[].",
    "Rules: strings <= 160 chars; lists <= 6 items; no markdown, no extra text.",
  ];
  if (context.branchPrompt) {
    parts.push(`Branch prompt: ${context.branchPrompt}`);
  }
  if (parentSummary) {
    parts.push(`Parent summary: ${truncateInline(parentSummary, 800)}`);
  }
  if (context.runMode === "bugfix") {
    parts.push("Bugfix mode: minimal-risk fix + validation strategy.");
  }
  parts.push("Context:");
  parts.push(sharedContext);
  return parts.join("\n\n");
}

function buildExecutionPlanPrompt(
  context: RunContext,
  decision: Decision,
  planner: AgentName,
  reviewer: AgentName,
  sharedContext: string,
  planCodex: string,
  planClaude: string,
  propCodex: string,
  propClaude: string
): string {
  return [
    "Write an implementation plan (small steps).",
    `Task: ${context.task}`,
    context.runMode ? `Run mode: ${context.runMode}` : "",
    context.branchPrompt ? `Branch prompt: ${context.branchPrompt}` : "",
    `Planner: ${planner} | Reviewer: ${reviewer}`,
    `Decision: ${decision.winner} (${truncateInline(decision.rationale, 240)})`,
    "Format:",
    "- Numbered steps (1..N). Each step: purpose, files, commands.",
    "- End with: Validation checklist (commands + expected).",
    "- Keep it concise; no essays.",
    "Context:",
    sharedContext,
    "Inputs (trimmed):",
    `codex.plan: ${truncateInline(planCodex, 1200)}`,
    `claude.plan: ${truncateInline(planClaude, 1200)}`,
    `codex.propose: ${truncateInline(propCodex, 1200)}`,
    `claude.propose: ${truncateInline(propClaude, 1200)}`,
  ].join("\n");
}

function buildExecutionPlanReviewPrompt(
  context: RunContext,
  decision: Decision,
  planner: AgentName,
  reviewer: AgentName,
  sharedContext: string,
  plannerPlan: string
): string {
  return [
    "Review the plan and propose improvements.",
    `Task: ${context.task}`,
    context.runMode ? `Run mode: ${context.runMode}` : "",
    `Planner: ${planner} | Reviewer: ${reviewer}`,
    `Decision: ${decision.winner} (${truncateInline(decision.rationale, 240)})`,
    "Return bullet points grouped under: Critical / Important / Nice-to-have.",
    "Context:",
    sharedContext,
    "Draft:",
    truncateInline(plannerPlan, 6000),
  ].join("\n");
}

function buildExecutionPlanFinalizePrompt(
  context: RunContext,
  decision: Decision,
  planner: AgentName,
  reviewer: AgentName,
  sharedContext: string,
  plannerDraft: string,
  reviewerFeedback: string
): string {
  return [
    "Revise the plan using the feedback.",
    `Task: ${context.task}`,
    context.runMode ? `Run mode: ${context.runMode}` : "",
    `Planner: ${planner} | Reviewer: ${reviewer}`,
    `Decision: ${decision.winner} (${truncateInline(decision.rationale, 240)})`,
    "Output: final numbered steps + validation checklist. Keep concise.",
    "Context:",
    sharedContext,
    "Draft:",
    truncateInline(plannerDraft, 5000),
    "Feedback:",
    truncateInline(reviewerFeedback, 2000),
  ].join("\n");
}

function buildJudgePrompt(
  context: RunContext,
  planCodex: string,
  planClaude: string,
  propCodex: string,
  propClaude: string,
  sharedContext: string | undefined,
  stance: "independent" | "debate"
): string {
  return [
    "Choose the better proposal.",
    `Task: ${context.task}`,
    context.runMode ? `Run mode: ${context.runMode}` : "",
    stance === "independent"
      ? "Independent: do not coordinate."
      : "Debate: consider the other judge, keep your own reasoning.",
    "Output JSON only: {winner: 'codex'|'claude'|'neither', rationale: string}. Rationale <= 240 chars.",
    sharedContext ? "Context:" : "",
    sharedContext ? truncateInline(sharedContext, 2000) : "",
    "Inputs (trimmed):",
    `codex.plan: ${truncateInline(planCodex, 1400)}`,
    `claude.plan: ${truncateInline(planClaude, 1400)}`,
    `codex.propose: ${truncateInline(propCodex, 1400)}`,
    `claude.propose: ${truncateInline(propClaude, 1400)}`,
  ].join("\n\n");
}

function buildImplementPrompt(
  context: RunContext,
  decision: Decision,
  planText: string,
  proposeText: string,
  sharedContext: string,
  executionPlan: string
): string {
  return [
    "Implement the task in this workspace (focused, minimal changes).",
    `Task: ${context.task}`,
    context.runMode ? `Run mode: ${context.runMode}` : "",
    context.branchPrompt ? `Branch prompt: ${context.branchPrompt}` : "",
    `Decision: ${decision.winner} (${truncateInline(decision.rationale, 240)})`,
    executionPlan ? "Execution plan (follow this):" : "",
    truncateInline(executionPlan, 8000),
    "Context (short):",
    truncateInline(sharedContext, 2000),
    context.runMode === "bugfix"
      ? "Focus on the smallest safe fix and add/adjust tests if needed."
      : "",
    "Do not paste large file contents or diffs in your response.",
    "At the end, output a 3-6 line summary of what you changed + how to test.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildReviewPrompt(
  context: RunContext,
  winner: string,
  diffText: string,
  sharedContext: string
): string {
  return [
    "Review this patch. Be strict and concise.",
    `Task: ${context.task}`,
    context.runMode ? `Run mode: ${context.runMode}` : "",
    `Patch author: ${winner}`,
    "Patch:",
    "```diff",
    diffText,
    "```",
    "Output JSON only with keys: ok (boolean), blockers[], warnings[], notes (string).",
    "Each issue: {id, summary, file?, suggested_fix?}. Keep summary <= 160 chars. notes <= 240 chars.",
    "No markdown, no extra text, do not reprint the diff.",
  ].join("\n\n");
}

function buildJointDriverPrompt(
  context: RunContext,
  decision: Decision,
  driver: AgentName,
  navigator: AgentName,
  planText: string,
  proposeText: string,
  sharedContext: string,
  executionPlan: string,
  navigatorNotes: string,
  lastTestExit: number | null,
  round: number,
  maxRounds: number
): string {
  return [
    "You are the driver implementing in the shared workspace.",
    `Task: ${context.task}`,
    context.runMode ? `Run mode: ${context.runMode}` : "",
    `Driver: ${driver}`,
    `Navigator: ${navigator}`,
    `Round: ${round} of ${maxRounds}`,
    `Decision: ${decision.winner} (${truncateInline(decision.rationale, 200)})`,
    lastTestExit === null
      ? ""
      : `Last test exit code: ${lastTestExit} (fix failures if any).`,
    navigatorNotes ? "Navigator notes from prior round:" : "",
    truncateInline(navigatorNotes, 1500),
    executionPlan ? "Joint execution plan:" : "",
    truncateInline(executionPlan, 8000),
    "Context (short):",
    truncateInline(sharedContext, 2000),
    "Rules: minimal changes, no unrelated refactors, keep output short (3-6 lines).",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildJointNavigatorPrompt(
  context: RunContext,
  decision: Decision,
  driver: AgentName,
  navigator: AgentName,
  sharedContext: string,
  executionPlan: string,
  driverDiff: string,
  testExit: number | null,
  round: number,
  maxRounds: number
): string {
  return [
    "You are the navigator reviewing the driver's changes.",
    `Task: ${context.task}`,
    context.runMode ? `Run mode: ${context.runMode}` : "",
    `Driver: ${driver}`,
    `Navigator: ${navigator}`,
    `Round: ${round} of ${maxRounds}`,
    `Decision: ${decision.winner} (${truncateInline(decision.rationale, 200)})`,
    testExit === null ? "" : `Latest test exit code: ${testExit}.`,
    executionPlan ? "Joint execution plan:" : "",
    truncateInline(executionPlan, 4000),
    "Context (short):",
    truncateInline(sharedContext, 1200),
    "Driver diff:",
    "```diff",
    driverDiff,
    "```",
    "If needed, apply minimal fixes or missing tests. If no changes needed, make no edits.",
    "Keep your response short; do not reprint the diff.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildJudgeDebatePrompt(
  context: RunContext,
  planCodex: string,
  planClaude: string,
  propCodex: string,
  propClaude: string,
  sharedContext: string | undefined,
  prior: { codex: string; claude: string }
): string {
  return [
    "Debate and converge.",
    `Task: ${context.task}`,
    context.runMode ? `Run mode: ${context.runMode}` : "",
    "Consider the other judge, but do not defer blindly.",
    "Output JSON only: {winner: 'codex'|'claude'|'neither', rationale: string}. Rationale <= 240 chars.",
    sharedContext ? "Context:" : "",
    sharedContext ? truncateInline(sharedContext, 2000) : "",
    "Inputs (trimmed):",
    `codex.plan: ${truncateInline(planCodex, 1200)}`,
    `claude.plan: ${truncateInline(planClaude, 1200)}`,
    `codex.propose: ${truncateInline(propCodex, 1200)}`,
    `claude.propose: ${truncateInline(propClaude, 1200)}`,
    `codex.judge: ${truncateInline(prior.codex, 1200)}`,
    `claude.judge: ${truncateInline(prior.claude, 1200)}`,
  ].join("\n\n");
}

function truncateInline(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+\n/g, "\n").trim();
  if (maxChars <= 0) {
    return "";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)} …`;
}

async function diffDirs(rootDir: string, worktreeDir: string): Promise<string> {
  const excludes = [
    "--exclude=.git",
    "--exclude=.orchestrator",
    "--exclude=node_modules",
    "--exclude=dist",
    "--exclude=build",
  ];
  const result = await runCommand({
    command: "diff",
    args: ["-ruN", ...excludes, rootDir, worktreeDir],
    cwd: rootDir,
    captureStdout: true,
    captureStderr: true,
  });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`diff failed: ${result.stderr}`);
  }
  return result.stdout;
}

async function diffDirsBetween(
  baseDir: string,
  otherDir: string
): Promise<string> {
  const parent = path.dirname(baseDir);
  const baseName = path.basename(baseDir);
  const otherName = path.basename(otherDir);
  const excludes = [
    "--exclude=.git",
    "--exclude=.orchestrator",
    "--exclude=node_modules",
    "--exclude=dist",
    "--exclude=build",
  ];
  const result = await runCommand({
    command: "diff",
    args: ["-ruN", ...excludes, baseName, otherName],
    cwd: parent,
    captureStdout: true,
    captureStderr: true,
  });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`diff failed: ${result.stderr}`);
  }
  return result.stdout;
}

function summarizeDiff(diff: string): { added: number; removed: number } {
  const lines = diff.split("\n");
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      continue;
    }
    if (line.startsWith("+")) {
      added += 1;
    } else if (line.startsWith("-")) {
      removed += 1;
    }
  }
  return { added, removed };
}

function extractChangedFilesFromDiff(
  diff: string,
  rootDir: string,
  worktreeDir: string
): string[] {
  const files = new Set<string>();
  const strip = (value: string): string => {
    let p = value.trim();
    // Drop timestamps from diff -ruN headers: "path\t2026-..."
    if (p.includes("\t")) {
      p = p.split("\t")[0] ?? p;
    }
    if (p.startsWith("a/") || p.startsWith("b/")) {
      p = p.slice(2);
    }
    for (const prefix of [rootDir, worktreeDir]) {
      if (p.startsWith(prefix)) {
        p = p.slice(prefix.length);
        if (p.startsWith(path.sep)) {
          p = p.slice(1);
        }
      }
    }
    return p.replaceAll("\\", "/").trim();
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (match?.[2]) {
        files.add(strip(match[2]));
      }
      continue;
    }
    if (line.startsWith("diff -ruN ")) {
      // Example: diff -ruN /a/root/foo /b/worktree/foo
      const parts = line.split(" ").filter(Boolean);
      const left = parts[2];
      const right = parts[3];
      const pick = right && right !== "/dev/null" ? right : left;
      if (pick && pick !== "/dev/null") {
        files.add(strip(pick));
      }
      continue;
    }
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      const raw = line.slice(4).trim();
      if (raw === "/dev/null") {
        continue;
      }
      files.add(strip(raw));
    }
  }

  return Array.from(files).filter(Boolean).sort();
}

function evaluateGuardrails(
  config: Config,
  changedFiles: string[],
  stats: { added: number; removed: number }
): string[] {
  const g = config.guardrails;
  if (!g?.enabled) {
    return [];
  }

  const violations: string[] = [];
  const maxFiles = g.maxFilesChanged ?? 50;
  const maxAdded = g.maxLinesAdded ?? 2000;
  const maxRemoved = g.maxLinesRemoved ?? 2000;

  if (changedFiles.length > maxFiles) {
    violations.push(`Too many files changed (${changedFiles.length} > ${maxFiles}).`);
  }
  if (stats.added > maxAdded) {
    violations.push(`Too many lines added (${stats.added} > ${maxAdded}).`);
  }
  if (stats.removed > maxRemoved) {
    violations.push(`Too many lines removed (${stats.removed} > ${maxRemoved}).`);
  }

  const forbidden = (g.forbiddenPaths ?? []).filter(Boolean);
  if (forbidden.length > 0) {
    const hit = changedFiles.filter((f) => forbidden.some((pat) => matchesGlob(pat, f)));
    if (hit.length > 0) {
      violations.push(`Forbidden paths changed: ${hit.slice(0, 10).join(", ")}${hit.length > 10 ? " …" : ""}`);
    }
  }

  if (g.forbidDependencyChanges) {
    const depFiles = new Set(
      (g.dependencyFiles ?? [
        "package.json",
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "bun.lockb",
        "Cargo.toml",
        "Cargo.lock",
        "pyproject.toml",
        "poetry.lock",
        "requirements.txt",
        "go.mod",
        "go.sum",
      ])
        .map((p) => p.trim())
        .filter(Boolean)
    );

    const depHits = changedFiles.filter((f) => depFiles.has(f));
    if (depHits.length > 0) {
      violations.push(`Dependency files changed (not allowed): ${depHits.join(", ")}`);
    }
  }

  return violations;
}

function globToRegExp(glob: string): RegExp {
  // Very small glob: '*' matches any chars, everything else is literal.
  const escaped = glob
    .split("")
    .map((ch) => {
      if (ch === "*") return ".*";
      return ch.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${escaped}$`);
}

function matchesGlob(glob: string, relPath: string): boolean {
  const normalized = relPath.replaceAll("\\", "/");
  const target = glob.includes("/") ? normalized : path.basename(normalized);
  return globToRegExp(glob).test(target);
}

function resolveDriver(
  configured: "auto" | AgentName | undefined,
  decision: Decision
): AgentName {
  if (decision.executionDriver) {
    return decision.executionDriver;
  }
  if (configured && configured !== "auto") {
    return configured;
  }
  if (decision.winner !== "neither") {
    return decision.winner;
  }
  return "codex";
}

function otherAgent(agent: AgentName): AgentName {
  return agent === "codex" ? "claude" : "codex";
}

async function askYesNo(
  rl: readline.Interface,
  prompt: string,
  defaultValue: boolean
): Promise<boolean> {
  while (true) {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    if (!answer) {
      return defaultValue;
    }
    if (answer === "y" || answer === "yes") {
      return true;
    }
    if (answer === "n" || answer === "no") {
      return false;
    }
    process.stdout.write("Please answer y/n.\n");
  }
}

async function askChoice<T extends string>(
  rl: readline.Interface,
  prompt: string,
  options: readonly T[],
  defaultIndex: number
): Promise<T> {
  const normalized = options.map((opt) => opt.toLowerCase());
  while (true) {
    const answer = (await rl.question(prompt)).trim();
    if (!answer) {
      return options[Math.max(0, Math.min(defaultIndex, options.length - 1))];
    }
    const numeric = Number(answer);
    if (Number.isFinite(numeric)) {
      const idx = Math.floor(numeric) - 1;
      if (idx >= 0 && idx < options.length) {
        return options[idx];
      }
    }
    const idx = normalized.indexOf(answer.toLowerCase());
    if (idx !== -1) {
      return options[idx];
    }
    process.stdout.write(
      `Please enter one of: ${options
        .map((opt, i) => `[${i + 1}] ${opt}`)
        .join(" ")}\n`
    );
  }
}

async function runTestsOnce(
  config: Config,
  cwd: string,
  logPath: string,
  timeoutMs?: number
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await runCommand({
    command: config.tests?.command ?? "npm",
    args: config.tests?.args ?? ["test"],
    cwd,
    captureStdout: true,
    captureStderr: true,
    timeoutMs,
  });
  writeText(logPath, `${result.stdout}${result.stderr}`);
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

async function applyPatchToWorktree(
  worktreePath: string,
  patchPath: string,
  isGit: boolean
): Promise<{ applied: boolean; stdout: string; stderr: string }> {
  const command = isGit ? "git" : "patch";
  const args = isGit
    ? ["apply", "-p1", patchPath]
    : ["-p1", "-i", patchPath];
  const result = await runCommand({
    command,
    args,
    cwd: worktreePath,
    captureStdout: true,
    captureStderr: true,
  });
  return { applied: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr };
}

function buildSummary(runDir: string, decision: Decision): string {
  const task = readText(path.join(runDir, "task.md")) ?? "";
  const context = readText(path.join(runDir, "context.json"));
  const runMode = context ? safeRunMode(context) : null;
  const lines = [
    `Task: ${task}`,
    runMode ? `Run mode: ${runMode}` : "",
    `Decision winner: ${decision.winner}`,
    `Decision rationale: ${decision.rationale}`,
  ];
  return lines.filter(Boolean).join("\n\n");
}

function safeRunMode(contextText: string): string | null {
  try {
    const parsed = JSON.parse(contextText) as { runMode?: string };
    return parsed.runMode ?? null;
  } catch {
    return null;
  }
}

function persistRunMemory(
  store: MemoryStore | null,
  runDir: string,
  context: RunContext,
  decision: Decision
): void {
  if (!store) {
    return;
  }

  const summaryText = readText(path.join(runDir, "final", "summary.md")) ?? "";
  if (summaryText) {
    const entry: MemoryEntry = {
      id: `${context.runId}-summary`,
      type: "summary",
      text: summaryText,
      tags: [context.runMode ?? "full", "summary"],
      runId: context.runId,
      sessionId: context.sessionId,
      timestamp: new Date().toISOString(),
      source: path.join(runDir, "final", "summary.md"),
    };
    store.put(entry);
  }

  const decisionEntry: MemoryEntry = {
    id: `${context.runId}-decision`,
    type: "decision",
    text: `Winner: ${decision.winner}. Rationale: ${decision.rationale}`,
    tags: [context.runMode ?? "full", "decision"],
    runId: context.runId,
    sessionId: context.sessionId,
    timestamp: new Date().toISOString(),
    source: path.join(runDir, "decide", "decision.json"),
  };
  store.put(decisionEntry);
}

async function ensureAnalysisWorktrees(
  rootDir: string,
  runId: string,
  isGit: boolean,
  config: Config
): Promise<Partial<Record<AgentName, string>>> {
  if (!config.context?.isolateWorkspaces) {
    return {};
  }

  const agents: AgentName[] = ["codex", "claude"];
  const worktreesRoot = path.join(rootDir, ".orchestrator", "worktrees", runId, "analysis");
  const result: Partial<Record<AgentName, string>> = {};

  for (const agent of agents) {
    const dest = path.join(worktreesRoot, agent);
    result[agent] = dest;

    if (fs.existsSync(dest)) {
      continue;
    }

    if (isGit) {
      await ensureWorktree(rootDir, dest);
    } else {
      copyWorkspace(rootDir, dest);
    }
  }

  return result;
}
