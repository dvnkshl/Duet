import path from "path";
import { runCommand, RunResult } from "./exec.js";
import { ensureDir, normalizeArgs, writeText } from "./utils.js";
import { AgentConfig, AgentName, RunContext } from "./types.js";

export type PhaseRunOptions = {
  agentName: AgentName;
  agentConfig: AgentConfig;
  phase: string;
  prompt: string;
  cwd: string;
  outputPath?: string;
  logDir: string;
  context: RunContext;
  agentVersion?: string;
  capabilities?: string[];
  timeoutMs?: number;
};

export async function runAgentPhase(
  options: PhaseRunOptions
): Promise<RunResult> {
  ensureDir(options.logDir);

  const promptFile = path.join(options.logDir, "prompt.txt");
  const promptMode = options.agentConfig.promptMode ?? "stdin";
  writeText(promptFile, options.prompt);

  const capabilities = options.capabilities?.join(",") ?? "";
  const replacements = {
    workdir: options.cwd,
    phase: options.phase,
    prompt: options.prompt,
    promptFile,
    task: options.context.task,
    sessionId: options.context.sessionId,
    runId: options.context.runId,
    agent: options.agentName,
    agentVersion: options.agentVersion ?? "",
    capabilities,
    runMode: options.context.runMode ?? "",
  };

  const args = normalizeArgs(options.agentConfig.args, replacements);
  const stdin = promptMode === "stdin" ? options.prompt : undefined;

  const result = await runCommand({
    command: options.agentConfig.command,
    args,
    cwd: options.cwd,
    env: {
      ...options.agentConfig.env,
      ORCHESTRATOR_PHASE: options.phase,
      ORCHESTRATOR_TASK: options.context.task,
      ORCHESTRATOR_SESSION_ID: options.context.sessionId,
      ORCHESTRATOR_RUN_ID: options.context.runId,
      ORCHESTRATOR_AGENT: options.agentName,
      ORCHESTRATOR_AGENT_VERSION: options.agentVersion ?? "",
      ORCHESTRATOR_AGENT_CAPABILITIES: capabilities,
      ORCHESTRATOR_RUN_MODE: options.context.runMode ?? "",
    },
    stdin,
    stdoutPath: path.join(options.logDir, "stdout.log"),
    stderrPath: path.join(options.logDir, "stderr.log"),
    captureStdout: Boolean(options.outputPath),
    captureStderr: Boolean(options.outputPath),
    timeoutMs: options.timeoutMs,
  });

  if (options.outputPath) {
    writeText(options.outputPath, result.stdout || "");
  }

  return result;
}
