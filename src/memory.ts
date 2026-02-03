import fs from "fs";
import path from "path";
import { MemoryConfig } from "./types.js";
import { ensureDir } from "./utils.js";

export type MemoryEntry = {
  id: string;
  type: string;
  text: string;
  tags?: string[];
  runId?: string;
  sessionId?: string;
  timestamp: string;
  source?: string;
};

export interface MemoryStore {
  init(): void;
  put(entry: MemoryEntry): void;
  query(queryText: string, limit: number): MemoryEntry[];
}

export function createMemoryStore(
  config: MemoryConfig | undefined,
  rootDir: string
): MemoryStore | null {
  if (!config?.enabled) {
    return null;
  }
  const backend = config.backend ?? "file";
  if (backend !== "file") {
    throw new Error(`Unsupported memory backend: ${backend}`);
  }

  const memoryPath = config.path
    ? path.resolve(rootDir, config.path)
    : path.join(rootDir, ".orchestrator", "memory", "memory.jsonl");

  return new FileMemoryStore(memoryPath);
}

export class FileMemoryStore implements MemoryStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  init(): void {
    ensureDir(path.dirname(this.filePath));
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, "", "utf8");
    }
  }

  put(entry: MemoryEntry): void {
    this.init();
    fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  query(queryText: string, limit: number): MemoryEntry[] {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }
    const content = fs.readFileSync(this.filePath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    const entries: MemoryEntry[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as MemoryEntry;
        entries.push(entry);
      } catch {
        continue;
      }
    }

    const scored = entries
      .map((entry) => ({
        entry,
        score: scoreEntry(entry, queryText),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.entry);

    return scored;
  }
}

function scoreEntry(entry: MemoryEntry, queryText: string): number {
  const terms = queryText
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/[^a-z0-9_-]/g, ""))
    .filter((term) => term.length > 2);

  if (terms.length === 0) {
    return 0;
  }

  const haystack = `${entry.text} ${entry.tags?.join(" ") ?? ""}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (term && haystack.includes(term)) {
      score += 1;
    }
  }
  return score;
}
