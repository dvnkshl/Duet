#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { orchestrate } from "./orchestrator.js";
import { CONFIG_FILENAME, ensureConfigDir, loadConfig } from "./config.js";
import {
  formatVerification,
  verifyAgents,
  verificationFailures,
} from "./verify.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main(): Promise<void> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  if (args[0] === "init") {
    const force = args.includes("--force");
    initConfig(force);
    process.exit(0);
  }

  if (args[0] === "doctor") {
    await runDoctor();
    process.exit(0);
  }

  const parsed = parseArgs(args);
  if (!parsed.task) {
    console.error("Missing task. Example: duet \"Add a healthcheck\"");
    process.exit(1);
  }

  await orchestrate({
    task: parsed.task,
    sessionId: parsed.sessionId,
    branchFrom: parsed.branchFrom,
    branchPrompt: parsed.branchPrompt,
    applyPatch: parsed.applyPatch,
    decisionMode: parsed.decisionMode,
    mode: parsed.mode,
    stream: parsed.stream,
    ui: parsed.ui,
    interactive: parsed.interactive,
  });
}

function parseArgs(argv: string[]): {
  task: string | null;
  sessionId?: string;
  branchFrom?: string;
  branchPrompt?: string;
  applyPatch?: boolean;
  decisionMode?: "judge" | "debate" | "prefer-codex" | "prefer-claude" | "neither";
  mode?: "full" | "plan" | "implement" | "bugfix";
  stream?: boolean;
  ui?: boolean;
  interactive?: boolean;
} {
  let taskParts: string[] = [];
  let sessionId: string | undefined;
  let branchFrom: string | undefined;
  let branchPrompt: string | undefined;
  let applyPatch = false;
  let decisionMode:
    | "judge"
    | "debate"
    | "prefer-codex"
    | "prefer-claude"
    | "neither"
    | undefined;
  let mode: "full" | "plan" | "implement" | "bugfix" | undefined;
  let stream = false;
  let ui = false;
  let interactive = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      taskParts.push(arg);
      continue;
    }

    if (arg === "--session") {
      sessionId = argv[i + 1];
      i += 1;
    } else if (arg === "--branch-from") {
      branchFrom = argv[i + 1];
      i += 1;
    } else if (arg === "--branch-prompt") {
      branchPrompt = argv[i + 1];
      i += 1;
    } else if (arg === "--apply") {
      applyPatch = true;
    } else if (arg === "--decision") {
      decisionMode = argv[i + 1] as typeof decisionMode;
      i += 1;
    } else if (arg === "--mode") {
      mode = argv[i + 1] as typeof mode;
      i += 1;
    } else if (arg === "--stream") {
      stream = true;
    } else if (arg === "--ui") {
      ui = true;
    } else if (arg === "--interactive") {
      interactive = true;
    }
  }

  return {
    task: taskParts.length ? taskParts.join(" ") : null,
    sessionId,
    branchFrom,
    branchPrompt,
    applyPatch,
    decisionMode,
    mode,
    stream,
    ui: ui || interactive,
    interactive,
  };
}

function initConfig(force: boolean): void {
  const rootDir = process.cwd();
  ensureConfigDir(rootDir);

  const targetPath = path.join(rootDir, ".orchestrator", CONFIG_FILENAME);
  if (fs.existsSync(targetPath) && !force) {
    console.error(`Config already exists at ${targetPath}. Use --force to overwrite.`);
    process.exit(1);
  }

  // Try project-specific template first, then fall back to orchestrator's default
  const projectTemplatePath = path.join(rootDir, "templates", "config.json");
  const orchestratorRoot = path.resolve(__dirname, "..");
  const defaultTemplatePath = path.join(orchestratorRoot, "templates", "config.json");
  
  let templatePath: string;
  if (fs.existsSync(projectTemplatePath)) {
    templatePath = projectTemplatePath;
  } else if (fs.existsSync(defaultTemplatePath)) {
    templatePath = defaultTemplatePath;
  } else {
    console.error(`Missing template. Looked for:`);
    console.error(`  - ${projectTemplatePath}`);
    console.error(`  - ${defaultTemplatePath}`);
    process.exit(1);
  }

  fs.copyFileSync(templatePath, targetPath);
  console.log(`Wrote ${targetPath} from ${templatePath === projectTemplatePath ? "project" : "default"} template.`);
  console.log(`Update it with your CLI commands.`);
}

function printHelp(): void {
  console.log(`
Usage:
  duet "<task>" [options]   (alias: orchestrate)
  duet init [--force]
  duet doctor

Options:
  --session <id>        Reuse a session ID (for branching)
  --branch-from <run>   Parent run ID
  --branch-prompt <txt> Branch prompt for exploration
  --decision <mode>     judge | debate | prefer-codex | prefer-claude | neither
  --mode <mode>         full | plan | implement | bugfix
  --stream              Stream JSON transcript events to stdout
  --ui                  Pretty ASCII UI output to stdout
  --interactive         Pause to approve execution + choose driver
  --apply               Apply winner patch to current working tree
`);
}

async function runDoctor(): Promise<void> {
  const rootDir = process.cwd();
  const config = loadConfig(rootDir);
  const results = await verifyAgents(config);
  console.log(formatVerification(results));

  const failures = verificationFailures(results);
  if (failures.length > 0) {
    process.exit(1);
  }
}
