export type AgentName = "codex" | "claude";
export type RunMode = "full" | "plan" | "implement" | "bugfix";

export type AgentConfig = {
  command: string;
  args: string[];
  promptMode?: "stdin" | "file" | "arg";
  versionArgs?: string[];
  minVersion?: string;
  capabilities?: string[];
  env?: Record<string, string>;
};

export type DecisionMode =
  | "judge"
  | "debate"
  | "prefer-codex"
  | "prefer-claude"
  | "neither";

export type DecisionConfig = {
  mode: DecisionMode;
  judgeAgent?: AgentName;
  debateRounds?: number;
};

export type ReviewConfig = {
  enabled: boolean;
  reviewer: "codex" | "claude" | "both";
};

export type CommandConfig = {
  enabled?: boolean;
  command: string;
  args?: string[];
};

export type MemoryConfig = {
  enabled: boolean;
  backend?: "file";
  path?: string;
  maxResults?: number;
};

export type ContextConfig = {
  includeFiles?: string[];
  maxFileBytes?: number;
  maxExcerptChars?: number;
  /**
   * If true, run non-implementation phases (plan/propose/decide/execution-plan)
   * inside per-agent isolated workspaces to prevent accidental edits to the
   * user's working tree and reduce cross-talk.
   */
  isolateWorkspaces?: boolean;
};

export type LimitsConfig = {
  agentTimeoutMs?: number;
  judgeTimeoutMs?: number;
};

export type ImplementationMode = "parallel" | "joint";

export type ImplementationConfig = {
  mode?: ImplementationMode;
  driver?: "auto" | AgentName;
  maxRounds?: number;
  applyNavigatorPatch?: "auto" | "manual";
  testsDuringLoop?: boolean;
  swapDriverOnFail?: boolean;
  swapDriverEachRound?: boolean;
};

export type ConvergeConfig = {
  /**
   * If enabled, run a bounded "fix/defend" loop after review when blockers are found.
   * Intended to improve first-pass correctness at the cost of more tokens/time.
   */
  enabled?: boolean;
  maxRounds?: number;
};

export type GuardrailsConfig = {
  /**
   * If enabled, enforce safety + budget guardrails before applying patches.
   */
  enabled?: boolean;
  maxFilesChanged?: number;
  maxLinesAdded?: number;
  maxLinesRemoved?: number;
  /**
   * Glob-ish patterns (supports '*' wildcard) matched against relative paths.
   */
  forbiddenPaths?: string[];
  /**
   * If true, changes to dependency manifests / lockfiles are considered violations.
   */
  forbidDependencyChanges?: boolean;
  /**
   * Dependency file list to protect (relative paths). If omitted, uses defaults.
   */
  dependencyFiles?: string[];
};

export type Config = {
  agents: {
    codex: AgentConfig;
    claude: AgentConfig;
  };
  decision?: DecisionConfig;
  review?: ReviewConfig;
  tests?: CommandConfig;
  lint?: CommandConfig;
  memory?: MemoryConfig;
  context?: ContextConfig;
  limits?: LimitsConfig;
  implementation?: ImplementationConfig;
  converge?: ConvergeConfig;
  guardrails?: GuardrailsConfig;
};

export type RunContext = {
  sessionId: string;
  runId: string;
  task: string;
  createdAt: string;
  parentRunId?: string;
  branchPrompt?: string;
  runMode?: RunMode;
};
