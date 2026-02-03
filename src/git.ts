import fs from "fs";
import path from "path";
import { runCommand } from "./exec.js";
import { ensureDir } from "./utils.js";

export async function isGitRepo(rootDir: string): Promise<boolean> {
  try {
    const result = await runCommand({
      command: "git",
      args: ["rev-parse", "--is-inside-work-tree"],
      cwd: rootDir,
      captureStdout: true,
      captureStderr: true,
    });
    return result.exitCode === 0 && result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function ensureWorktree(
  rootDir: string,
  worktreePath: string
): Promise<void> {
  if (fs.existsSync(worktreePath)) {
    throw new Error(`Worktree path already exists: ${worktreePath}`);
  }
  ensureDir(path.dirname(worktreePath));
  const result = await runCommand({
    command: "git",
    args: ["worktree", "add", worktreePath, "HEAD"],
    cwd: rootDir,
    captureStdout: true,
    captureStderr: true,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git worktree add failed: ${result.stderr}`);
  }
}

export async function gitDiff(worktreePath: string): Promise<string> {
  // Prefer diffs against HEAD so we include staged + unstaged changes.
  // Some agent CLIs stage files automatically, which makes plain `git diff` empty.
  let result = await runCommand({
    command: "git",
    args: ["-C", worktreePath, "diff", "HEAD"],
    cwd: worktreePath,
    captureStdout: true,
    captureStderr: true,
  });

  if (result.exitCode !== 0) {
    // Fallback for repos without commits or unusual HEAD state.
    result = await runCommand({
      command: "git",
      args: ["-C", worktreePath, "diff"],
      cwd: worktreePath,
      captureStdout: true,
      captureStderr: true,
    });
  }

  if (result.exitCode !== 0) {
    throw new Error(`git diff failed: ${result.stderr}`);
  }
  return result.stdout;
}

export async function gitStatusFiles(worktreePath: string): Promise<string[]> {
  const result = await runCommand({
    command: "git",
    args: ["-C", worktreePath, "status", "--porcelain"],
    cwd: worktreePath,
    captureStdout: true,
    captureStderr: true,
  });
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3));
}
