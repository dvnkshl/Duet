import { runCommand } from "./exec.js";
import { AgentName, Config } from "./types.js";

export type AgentVerification = {
  agent: AgentName;
  command: string;
  found: boolean;
  version?: string;
  versionRaw?: string;
  minVersion?: string;
  versionOk?: boolean;
  capabilities?: string[];
  error?: string;
};

export async function verifyAgents(
  config: Config
): Promise<AgentVerification[]> {
  const agents: AgentName[] = ["codex", "claude"];
  const results: AgentVerification[] = [];

  for (const agent of agents) {
    const agentConfig = config.agents[agent];
    const command = agentConfig.command;
    const found = await hasCommand(command);

    const verification: AgentVerification = {
      agent,
      command,
      found,
      capabilities: agentConfig.capabilities ?? [],
      minVersion: agentConfig.minVersion,
    };

    if (!found) {
      verification.error = `Command not found: ${command}`;
      results.push(verification);
      continue;
    }

    const versionArgs = agentConfig.versionArgs ?? ["--version"];
    if (versionArgs.length > 0) {
      const versionResult = await runCommand({
        command,
        args: versionArgs,
        cwd: process.cwd(),
        captureStdout: true,
        captureStderr: true,
      });

      const raw = `${versionResult.stdout}${versionResult.stderr}`.trim();
      verification.versionRaw = raw;

      const parsed = parseVersion(raw);
      if (parsed) {
        verification.version = parsed;
        if (agentConfig.minVersion) {
          const meets = compareVersions(parsed, agentConfig.minVersion) >= 0;
          verification.versionOk = meets;
          if (!meets) {
            verification.error = `Version ${parsed} is below required ${agentConfig.minVersion}`;
          }
        } else {
          verification.versionOk = true;
        }
      } else if (agentConfig.minVersion) {
        verification.versionOk = false;
        verification.error = `Unable to parse version output for ${command}`;
      }
    }

    results.push(verification);
  }

  return results;
}

export function verificationFailures(
  results: AgentVerification[]
): AgentVerification[] {
  return results.filter((item) => !item.found || item.versionOk === false);
}

export function formatVerification(results: AgentVerification[]): string {
  return results
    .map((item) => {
      if (!item.found) {
        return `${item.agent}: missing (${item.command})`;
      }
      const version = item.version ? `version ${item.version}` : "version unknown";
      const versionOk =
        item.versionOk === false
          ? "(version too low)"
          : item.versionOk === true
            ? "(ok)"
            : "";
      const caps = item.capabilities?.length
        ? `capabilities: ${item.capabilities.join(", ")}`
        : "capabilities: none";
      return `${item.agent}: ${version} ${versionOk} | ${caps}`.trim();
    })
    .join("\n");
}

async function hasCommand(command: string): Promise<boolean> {
  const result = await runCommand({
    command: "which",
    args: [command],
    cwd: process.cwd(),
    captureStdout: true,
    captureStderr: true,
  });
  return result.exitCode === 0 && result.stdout.trim().length > 0;
}

function parseVersion(output: string): string | null {
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
  if (match) {
    return `${match[1]}.${match[2]}.${match[3]}`;
  }
  const shortMatch = output.match(/(\d+)\.(\d+)/);
  if (shortMatch) {
    return `${shortMatch[1]}.${shortMatch[2]}.0`;
  }
  return null;
}

function compareVersions(a: string, b: string): number {
  const toParts = (value: string) =>
    value
      .split(".")
      .map((part) => parseInt(part.replace(/\D/g, ""), 10) || 0)
      .slice(0, 3);

  const aParts = toParts(a);
  const bParts = toParts(b);
  while (aParts.length < 3) aParts.push(0);
  while (bParts.length < 3) bParts.push(0);

  for (let i = 0; i < 3; i += 1) {
    if (aParts[i] > bParts[i]) return 1;
    if (aParts[i] < bParts[i]) return -1;
  }
  return 0;
}
