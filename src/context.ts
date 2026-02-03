import fs from "fs";
import path from "path";
import { Config, RunContext } from "./types.js";
import { ensureDir, listFiles, truncateText, writeText } from "./utils.js";
import { MemoryEntry } from "./memory.js";
import { runCommand } from "./exec.js";

const DEFAULT_EXCLUDES = new Set([
  ".git",
  ".orchestrator",
  "node_modules",
  "dist",
  "build",
]);

const DEFAULT_INCLUDE_FILES = [
  "README.md",
  "README",
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
];

export type SharedContext = {
  summary: string;
  memory: MemoryEntry[];
};

export async function buildContextPack(
  rootDir: string,
  runDir: string,
  context: RunContext,
  config: Config,
  memoryEntries: MemoryEntry[],
  isGit: boolean
): Promise<SharedContext> {
  const contextDir = path.join(runDir, "context");
  ensureDir(contextDir);

  const repoFiles = listRepoFiles(rootDir);
  const repoMap = repoFiles.map((filePath) => ({
    path: path.relative(rootDir, filePath),
    bytes: fs.statSync(filePath).size,
  }));

  writeText(
    path.join(contextDir, "repo_map.json"),
    JSON.stringify(repoMap, null, 2)
  );

  if (isGit) {
    const log = await runCommand({
      command: "git",
      args: ["-C", rootDir, "log", "-5", "--oneline"],
      cwd: rootDir,
      captureStdout: true,
      captureStderr: true,
    });
    writeText(path.join(contextDir, "recent_commits.txt"), log.stdout.trim());
  }

  const includeFiles =
    config.context?.includeFiles ?? DEFAULT_INCLUDE_FILES;
  const maxBytes = config.context?.maxFileBytes ?? 20000;
  const maxExcerpt = config.context?.maxExcerptChars ?? 2000;

  const keyDir = path.join(contextDir, "key_files");
  ensureDir(keyDir);
  const keyFilesIncluded: string[] = [];

  for (const fileName of includeFiles) {
    const filePath = path.join(rootDir, fileName);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      continue;
    }
    const content = fs.readFileSync(filePath, "utf8").slice(0, maxBytes);
    const excerpt = truncateText(content, maxExcerpt);
    writeText(path.join(keyDir, sanitizeFileName(fileName)), excerpt);
    keyFilesIncluded.push(fileName);
  }

  const memorySummary = memoryEntries
    .map((entry) => `- ${entry.type}: ${truncateText(entry.text, 200)}`)
    .join("\n");

  const repoSummary = summarizeRepo(repoMap);

  const summary = [
    `Task: ${context.task}`,
    context.branchPrompt ? `Branch prompt: ${context.branchPrompt}` : "",
    context.runMode ? `Run mode: ${context.runMode}` : "",
    "Repo summary:",
    repoSummary,
    memoryEntries.length ? "Memory highlights:" : "Memory highlights: none",
    memoryEntries.length ? memorySummary : "",
    keyFilesIncluded.length ? "Key files (inspect in workspace):" : "Key files: none",
    keyFilesIncluded.length ? `- ${keyFilesIncluded.join("\n- ")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  writeText(path.join(contextDir, "context.md"), summary);
  if (memoryEntries.length > 0) {
    writeText(
      path.join(contextDir, "memory.json"),
      JSON.stringify(memoryEntries, null, 2)
    );
  }

  return {
    summary,
    memory: memoryEntries,
  };
}

function listRepoFiles(rootDir: string): string[] {
  return listFiles(rootDir).filter((filePath) => {
    const rel = path.relative(rootDir, filePath);
    const top = rel.split(path.sep)[0];
    return !DEFAULT_EXCLUDES.has(top);
  });
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function summarizeRepo(
  repoMap: { path: string; bytes: number }[]
): string {
  const fileCount = repoMap.length;
  const topLevel = new Map<string, number>();
  for (const entry of repoMap) {
    const segment = entry.path.split(path.sep)[0];
    topLevel.set(segment, (topLevel.get(segment) ?? 0) + 1);
  }
  const topSummary = Array.from(topLevel.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([segment, count]) => `${segment}: ${count}`)
    .join(", ");

  return `Files: ${fileCount}. Top-level: ${topSummary}`;
}
