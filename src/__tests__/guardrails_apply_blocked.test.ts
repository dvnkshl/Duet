import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { orchestrate } from "../orchestrator.js";

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function onlySubdir(dir: string): string {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  assert.equal(entries.length, 1, `Expected 1 subdir in ${dir}, got: ${entries.join(", ")}`);
  return entries[0];
}

test("guardrails can block apply when dependency files change", async () => {
  const originalCwd = process.cwd();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orc-poc-test-"));
  const fakeAgentPath = path.join(thisDir(), "fixtures", "fake-agent-guardrails.js");
  assert.ok(fs.existsSync(fakeAgentPath), `Missing fake agent at ${fakeAgentPath}`);

  try {
    const pkgPath = path.join(tmpRoot, "package.json");
    fs.writeFileSync(pkgPath, JSON.stringify({ name: "tmp", version: "0.0.0" }, null, 2), "utf8");
    const pkgBefore = fs.readFileSync(pkgPath, "utf8");

    fs.mkdirSync(path.join(tmpRoot, ".orchestrator"), { recursive: true });

    const config = {
      agents: {
        codex: {
          command: "node",
          args: [fakeAgentPath],
          promptMode: "stdin",
          versionArgs: ["--version"],
          minVersion: "0.0.0",
          capabilities: [],
        },
        claude: {
          command: "node",
          args: [fakeAgentPath],
          promptMode: "stdin",
          versionArgs: ["--version"],
          minVersion: "0.0.0",
          capabilities: [],
        },
      },
      decision: { mode: "prefer-codex" },
      review: { enabled: false, reviewer: "both" },
      tests: { enabled: false, command: "npm", args: ["test"] },
      lint: { enabled: false, command: "npm", args: ["run", "lint"] },
      memory: { enabled: false, backend: "file", path: ".orchestrator/memory/memory.jsonl", maxResults: 5 },
      context: { isolateWorkspaces: true },
      limits: { agentTimeoutMs: 30_000, judgeTimeoutMs: 30_000 },
      implementation: {
        mode: "joint",
        driver: "auto",
        maxRounds: 1,
        applyNavigatorPatch: "manual",
        testsDuringLoop: false,
        swapDriverOnFail: false,
        swapDriverEachRound: false,
      },
      converge: { enabled: false },
      guardrails: {
        enabled: true,
        forbidDependencyChanges: true,
        dependencyFiles: ["package.json"],
      },
    };

    fs.writeFileSync(
      path.join(tmpRoot, ".orchestrator", "config.json"),
      JSON.stringify(config, null, 2),
      "utf8"
    );

    process.chdir(tmpRoot);
    await orchestrate({
      task: "guardrails test",
      sessionId: "session-guardrails",
      stream: false,
      ui: false,
      interactive: false,
      applyPatch: true,
      decisionMode: "prefer-codex",
      mode: "full",
    });

    const pkgAfter = fs.readFileSync(pkgPath, "utf8");
    assert.equal(pkgAfter, pkgBefore, "package.json should not be modified when apply is blocked");

    const runsDir = path.join(tmpRoot, ".orchestrator", "sessions", "session-guardrails", "runs");
    const runId = onlySubdir(runsDir);
    const runDir = path.join(runsDir, runId);
    const applyLog = fs.readFileSync(path.join(runDir, "final", "apply.log"), "utf8");
    assert.match(applyLog, /Guardrails blocked apply/);
  } finally {
    process.chdir(originalCwd);
  }
});

