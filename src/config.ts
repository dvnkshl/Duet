import fs from "fs";
import path from "path";
import { Config } from "./types.js";

export const CONFIG_FILENAME = "config.json";

export function configPath(rootDir: string): string {
  return path.join(rootDir, ".orchestrator", CONFIG_FILENAME);
}

export function loadConfig(rootDir: string): Config {
  const filePath = configPath(rootDir);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Missing config at ${filePath}. Run 'duet init' to create one.`
    );
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as Config;
  if (!parsed.agents?.codex || !parsed.agents?.claude) {
    throw new Error("Config must define agents.codex and agents.claude.");
  }

  return parsed;
}

export function ensureConfigDir(rootDir: string): void {
  fs.mkdirSync(path.join(rootDir, ".orchestrator"), { recursive: true });
}
