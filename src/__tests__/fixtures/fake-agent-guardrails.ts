import fs from "fs";
import path from "path";

async function readAllStdin(): Promise<string> {
  return await new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.resume();
  });
}

void (await readAllStdin());

const phase = process.env.ORCHESTRATOR_PHASE ?? "";
const cwd = process.cwd();

if (phase === "implement") {
  const pkg = path.join(cwd, "package.json");
  const before = fs.existsSync(pkg) ? fs.readFileSync(pkg, "utf8") : "{}\n";
  // Touch package.json to trigger dependency guardrail.
  fs.writeFileSync(pkg, before.replace(/\}\s*$/, ',\n  "__touchedByTest": true\n}\n'), "utf8");
}

if (phase === "judge") {
  process.stdout.write(JSON.stringify({ winner: "codex", rationale: "fake guardrails agent" }));
  process.exit(0);
}

process.stdout.write("ok\n");

