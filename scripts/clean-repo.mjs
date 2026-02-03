import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const all = args.has("--all");

const targets = [
  ".DS_Store",
  path.join(".orchestrator", "sessions"),
  path.join(".orchestrator", "worktrees"),
  path.join(".orchestrator", "memory"),
  path.join("sandbox", ".orchestrator"),
  path.join("sandbox", "dist"),
  path.join("sandbox", "build"),
  path.join("sandbox", "judge_result.json"),
];

if (all) {
  targets.push("my-todo-app");
  targets.push(path.join("sandbox", "IMPLEMENTATION_PLAN.md"));
}

let removed = 0;
for (const rel of targets) {
  const abs = path.join(root, rel);
  try {
    if (!fs.existsSync(abs)) {
      continue;
    }
    fs.rmSync(abs, { recursive: true, force: true });
    process.stdout.write(`removed: ${rel}\n`);
    removed += 1;
  } catch (err) {
    process.stderr.write(
      `warn: failed to remove ${rel}: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}

process.stdout.write(
  removed === 0
    ? "nothing to clean\n"
    : `done (${removed} path${removed === 1 ? "" : "s"} removed)\n`
);

