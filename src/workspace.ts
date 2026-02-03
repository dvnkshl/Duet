import fs from "fs";
import path from "path";
import { ensureDir } from "./utils.js";

const DEFAULT_EXCLUDES = new Set([
  ".git",
  ".orchestrator",
  "node_modules",
  "dist",
  "build",
]);

type Excludes = Set<string>;

export function copyWorkspace(
  sourceDir: string,
  destDir: string,
  excludes: Set<string> = DEFAULT_EXCLUDES
): void {
  ensureDir(destDir);
  // fs.cpSync() refuses to copy a directory into its own subdirectory.
  // Our worktrees live under `.orchestrator/` inside the workspace, so copy
  // each top-level entry individually to avoid self-copy errors.
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (excludes.has(entry.name)) {
      continue;
    }
    const srcPath = path.join(sourceDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    fs.cpSync(srcPath, destPath, { recursive: true, force: true });
  }
}

export function syncWorkspace(
  sourceDir: string,
  destDir: string,
  excludes: Excludes = DEFAULT_EXCLUDES
): void {
  ensureDir(destDir);

  const sourceEntries = listRelativeEntries(sourceDir, excludes);
  const destEntries = listRelativeEntries(destDir, excludes);

  const sourcePaths = new Set(sourceEntries.map((entry) => entry.relPath));
  const toRemove = destEntries
    .filter((entry) => !sourcePaths.has(entry.relPath))
    .sort((a, b) => b.relPath.length - a.relPath.length); // remove children first

  for (const entry of toRemove) {
    const abs = path.join(destDir, entry.relPath);
    fs.rmSync(abs, { recursive: true, force: true });
  }

  fs.cpSync(sourceDir, destDir, {
    recursive: true,
    force: true,
    filter: (src) => {
      const rel = path.relative(sourceDir, src);
      if (!rel || rel.startsWith("..")) {
        return true;
      }
      const top = rel.split(path.sep)[0];
      return !excludes.has(top);
    },
  });
}

function listRelativeEntries(
  rootDir: string,
  excludes: Excludes
): Array<{ relPath: string }> {
  const results: Array<{ relPath: string }> = [];

  const walk = (currentRel: string): void => {
    const absDir = path.join(rootDir, currentRel);
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = path.join(currentRel, entry.name);
      const top = relPath.split(path.sep)[0];
      if (excludes.has(top)) {
        continue;
      }
      results.push({ relPath });
      if (entry.isDirectory()) {
        walk(relPath);
      }
    }
  };

  walk("");
  return results;
}
