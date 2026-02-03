import fs from "fs";
import path from "path";
import { AgentName } from "./types.js";
import { ensureDir } from "./utils.js";

export type TranscriptEvent = {
  timestamp: string;
  phase: string;
  role: "system" | "agent";
  agent?: AgentName;
  kind: "prompt" | "response" | "decision" | "note";
  content: string;
  round?: number;
};

export type TranscriptStreamOptions = {
  jsonl?: boolean;
  ui?: boolean;
  uiShowPrompts?: boolean;
  uiMaxChars?: number;
};

export function appendTranscript(
  runDir: string,
  event: TranscriptEvent,
  stream: boolean | TranscriptStreamOptions = false
): void {
  const convoDir = path.join(runDir, "conversation");
  ensureDir(convoDir);

  const jsonlPath = path.join(convoDir, "transcript.jsonl");
  fs.appendFileSync(jsonlPath, `${JSON.stringify(event)}\n`, "utf8");

  const mdPath = path.join(convoDir, "transcript.md");
  fs.appendFileSync(mdPath, renderMarkdown(event), "utf8");

  const streamOpts = normalizeStreamOptions(stream);
  if (streamOpts.jsonl) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
  if (streamOpts.ui) {
    process.stdout.write(renderUi(event, streamOpts));
  }
}

function renderMarkdown(event: TranscriptEvent): string {
  const who = event.role === "agent"
    ? `${event.role}:${event.agent ?? "unknown"}`
    : event.role;
  const round = event.round ? ` (round ${event.round})` : "";
  const header = `### ${event.phase}${round} | ${who} | ${event.kind} | ${event.timestamp}`;
  return `${header}\n\n${event.content}\n\n`;
}

function normalizeStreamOptions(
  stream: boolean | TranscriptStreamOptions
): Required<Pick<TranscriptStreamOptions, "jsonl" | "ui" | "uiShowPrompts" | "uiMaxChars">> {
  if (typeof stream === "boolean") {
    return {
      jsonl: stream,
      ui: false,
      uiShowPrompts: true,
      uiMaxChars: 200000,
    };
  }
  return {
    jsonl: Boolean(stream.jsonl),
    ui: Boolean(stream.ui),
    uiShowPrompts: stream.uiShowPrompts ?? true,
    uiMaxChars: stream.uiMaxChars ?? 200000,
  };
}

function renderUi(
  event: TranscriptEvent,
  options: Required<Pick<TranscriptStreamOptions, "uiShowPrompts" | "uiMaxChars">>
): string {
  const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

  const color = (code: string, text: string) =>
    useColor ? `${code}${text}\x1b[0m` : text;

  const bold = (text: string) => color("\x1b[1m", text);
  const dim = (text: string) => color("\x1b[2m", text);
  const faint = (text: string) => color("\x1b[90m", text);

  let body = event.content ?? "";
  if (event.kind === "prompt" && !options.uiShowPrompts) {
    body = firstNonEmptyLine(body) ?? "";
    if (body) {
      body = `${body}\n(prompt hidden; see transcript on disk)`;
    } else {
      body = "(prompt hidden)";
    }
  }

  body = truncate(body, options.uiMaxChars);

  const cols = typeof process.stdout.columns === "number" ? process.stdout.columns : 100;
  const frameWidth = clamp(cols, 60, 140);
  const bubbleWidth = clamp(Math.floor(frameWidth * 0.72), 44, 92);

  const who =
    event.role === "agent" ? (event.agent ?? "agent").toUpperCase() : "SYSTEM";
  const phase = event.phase.toUpperCase();
  const kind = event.kind.toUpperCase();
  const round = event.round ? ` #${event.round}` : "";

  const align: "left" | "right" | "center" =
    event.role === "agent"
      ? event.agent === "claude"
        ? "right"
        : "left"
      : "center";

  const borderColor =
    who === "CODEX"
      ? (t: string) => color("\x1b[32m", t)
      : who === "CLAUDE"
        ? (t: string) => color("\x1b[36m", t)
        : event.kind === "decision"
          ? (t: string) => color("\x1b[33m", t)
          : (t: string) => faint(t);

  // Keep bubble content uncolored so wrapping stays stable.
  const title = `${who} · ${phase}${round} · ${kind}`;
  const bubbleText = `${title}\n${event.timestamp}\n\n${body}`.trimEnd();
  const rendered = renderBubble(bubbleText, bubbleWidth, frameWidth, align, borderColor);
  return `\n${rendered}\n`;
}

function firstNonEmptyLine(text: string): string | null {
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n\n...(truncated; see transcript on disk)`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function renderBubble(
  text: string,
  bubbleWidth: number,
  frameWidth: number,
  align: "left" | "right" | "center",
  borderColor: (t: string) => string
): string {
  const innerWidth = Math.max(10, bubbleWidth - 4);
  const lines = wrapText(text, innerWidth);

  const indent =
    align === "left"
      ? 0
      : align === "right"
        ? Math.max(0, frameWidth - bubbleWidth)
        : Math.max(0, Math.floor((frameWidth - bubbleWidth) / 2));
  const pad = " ".repeat(indent);

  const top = borderColor(`╭${"─".repeat(bubbleWidth - 2)}╮`);
  const bottom = borderColor(`╰${"─".repeat(bubbleWidth - 2)}╯`);

  const middle = lines
    .map((line) => {
      const padded = line.padEnd(innerWidth, " ");
      return borderColor(`│ `) + padded + borderColor(` │`);
    })
    .join("\n");

  return `${pad}${top}\n${pad}${middle}\n${pad}${bottom}`;
}

function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  const rawLines = text.split("\n");
  for (const raw of rawLines) {
    const line = raw.replace(/\r/g, "");
    if (line.length === 0) {
      out.push("");
      continue;
    }
    if (line.length <= width) {
      out.push(line);
      continue;
    }
    // word-wrap
    const words = line.split(/(\s+)/).filter((w) => w.length > 0);
    let current = "";
    for (const w of words) {
      const next = current ? current + w : w;
      if (next.length <= width) {
        current = next;
        continue;
      }
      if (current) {
        out.push(current.trimEnd());
      }
      // If a single token is longer than width, hard-split.
      if (w.length > width) {
        for (let i = 0; i < w.length; i += width) {
          out.push(w.slice(i, i + width));
        }
        current = "";
      } else {
        current = w.trimStart();
      }
    }
    if (current) {
      out.push(current.trimEnd());
    }
  }
  return out;
}
