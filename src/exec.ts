import { spawn } from "child_process";
import fs from "fs";
import path from "path";

export type RunOptions = {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  stdin?: string;
  stdoutPath?: string;
  stderrPath?: string;
  captureStdout?: boolean;
  captureStderr?: boolean;
  timeoutMs?: number;
};

export type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
};

export function runCommand(options: RunOptions): Promise<RunResult> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  const stdoutStream = options.stdoutPath
    ? fs.createWriteStream(path.resolve(options.stdoutPath))
    : null;
  const stderrStream = options.stderrPath
    ? fs.createWriteStream(path.resolve(options.stderrPath))
    : null;

  return new Promise((resolve, reject) => {
    let timeoutId: NodeJS.Timeout | undefined;
    let timedOut = false;
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutStream) {
        stdoutStream.write(chunk);
      }
      if (options.captureStdout) {
        stdoutChunks.push(chunk);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrStream) {
        stderrStream.write(chunk);
      }
      if (options.captureStderr) {
        stderrChunks.push(chunk);
      }
    });

    child.on("error", (error) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      stdoutStream?.end();
      stderrStream?.end();
      reject(error);
    });

    child.on("close", (code) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      stdoutStream?.end();
      stderrStream?.end();
      resolve({
        exitCode: code ?? (timedOut ? 124 : 0),
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
      });
    });

    if (options.stdin) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
  });
}
