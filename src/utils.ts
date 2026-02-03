import fs from "fs";
import path from "path";

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function writeText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
}

export function readText(filePath: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, "utf8");
}

export function timestampId(prefix?: string): string {
  const now = new Date();
  const pad = (value: number) => value.toString().padStart(2, "0");
  const id = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
    now.getDate()
  )}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 8);
  return prefix ? `${prefix}-${id}-${rand}` : `${id}-${rand}`;
}

export function safeJsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function extractJson<T>(value: string): T | null {
  const direct = safeJsonParse<T>(value.trim());
  if (direct) {
    return direct;
  }

  const fenced = value.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const parsed = safeJsonParse<T>(fenced[1]);
    if (parsed) {
      return parsed;
    }
  }

  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const slice = value.slice(firstBrace, lastBrace + 1);
    return safeJsonParse<T>(slice);
  }

  return null;
}

export function normalizeArgs(
  args: string[],
  replacements: Record<string, string>
): string[] {
  return args.map((arg) => {
    let next = arg;
    for (const [key, value] of Object.entries(replacements)) {
      next = next.split(`{${key}}`).join(value);
    }
    return next;
  });
}

export function listFiles(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFiles(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...`;
}
