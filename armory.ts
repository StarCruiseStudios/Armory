#!/usr/bin/env node
/**
 * Armory — recursively clone, update, and wire up repos from armory.json.
 *
 * Usage (from the directory that contains armory.json):
 *   node armory.ts <command>
 *
 * Commands:
 *   init       Create armory.json in the current directory if it is missing.
 *   clone      Recursively clone configured repos that are not present.
 *   fetch      Recursively run `git fetch` in configured repos.
 *   pull       Recursively run `git pull` in configured repos.
 *   sync       Recursively run clone, then fetch, then pull.
 *   update     Replace this script with the latest version from GitHub.
 *
 * Options:
 *   --help            Show this help text.
 *
 * Examples:
 *   node armory.ts sync
 *   node armory.ts pull
 *
 * clone, fetch, and pull (and sync) each update `<workspaceName>.armory.code-workspace`
 * next to the armory.json the command was run against (including Armory shell tasks).
 * Nested armory.json files do not create or update a workspace file. Managed
 * `.gitignore` block(s) are updated when armory.json lies inside a git repository.
 *
 * Requires Node.js 22+ (native TypeScript execution) and git on PATH.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type GitSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => SpawnSyncReturns<string>;

export class ArmoryFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArmoryFailure";
  }
}

export class ArmoryExit extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`exit ${code}`);
    this.name = "ArmoryExit";
    this.code = code;
  }
}

type Runtime = {
  argv: string[];
  cwd: () => string;
  env: NodeJS.ProcessEnv;
  spawnSync: GitSpawn;
  fetch: typeof fetch;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  homedir: () => string;
  platform: NodeJS.Platform;
  pid: number;
  now: () => number;
  exit: (code: number) => never;
};

const runtimeStore = new AsyncLocalStorage<Runtime>();

function createDefaultRuntime(): Runtime {
  return {
    argv: process.argv,
    cwd: () => process.cwd(),
    env: process.env,
    spawnSync: spawnSync as GitSpawn,
    fetch: globalThis.fetch.bind(globalThis),
    stdout: process.stdout,
    stderr: process.stderr,
    homedir: () => os.homedir(),
    platform: process.platform,
    pid: process.pid,
    now: () => Date.now(),
    exit(code: number): never {
      return process.exit(code);
    },
  };
}

function runtime(): Runtime {
  const current = runtimeStore.getStore();
  if (!current) {
    throw new Error("Armory runtime is unavailable.");
  }
  return current;
}

/** Runs one Armory invocation. Tests pass overrides so git and network stay local. */
export async function runArmory(overrides?: Partial<Runtime>): Promise<void> {
  const store = { ...createDefaultRuntime(), ...overrides };
  await runtimeStore.run(store, () => main());
}

type ArmoryRepo = {
  url: string;
  branch?: string;
  repoPath?: string;
};

type ArmoryConfig = {
  workspaceName: string;
  excludeLocalDir?: boolean;
  skipArmoryTasks?: boolean;
  reposRoot?: string;
  repos: ArmoryRepo[];
  workspaceSettings?: Record<string, unknown>;
};

type ResolvedRepo = {
  url: string;
  branch: string;
  repoPath: string;
  cloneDir: string;
  workspaceFolderPath: string;
  displayName: string;
};

type ArmoryCommand = "init" | "clone" | "fetch" | "pull" | "sync" | "update";

type DependencyHop = {
  key: string;
  label: string;
};

type RecursiveRunState = {
  visitedConfigPaths: Set<string>;
};

const ARMORY_RAW_URL =
  "https://raw.githubusercontent.com/StarCruiseStudios/Armory/main/armory.ts";

const HELP = `Usage: node armory.ts <command>

Run dependency commands from the directory that contains armory.json.
The update command can run from any directory.

Commands:
  init       Create armory.json here if it does not already exist.
  clone      Recursively clone missing repos under reposRoot.
  fetch      Recursively fetch all configured repositories.
  pull       Recursively pull all configured repositories.
  sync       Recursively clone, then fetch, then pull.
  update     Download and replace armory.ts with the latest version.

Options:
  --help            Show help
`;

async function main(): Promise<void> {
  const argv = runtime().argv.slice(2);
  if (argv.includes("--help") || argv.length === 0) {
    runtime().stdout.write(HELP);
    runtime().exit(argv.length === 0 ? 1 : 0);
  }

  const command = resolveCommand(argv);
  if (!command) {
    fail("Missing command. Use --help for usage.");
  }
  if (command === "update") {
    await updateScript();
    return;
  }
  if (command === "init") {
    initConfig();
    return;
  }

  const configPath = path.resolve(runtime().cwd(), "armory.json");
  const config = loadConfig(configPath);
  const armoryDir = path.dirname(path.resolve(configPath));
  const context = resolveContext(config, configPath, armoryDir);
  const rootDependency = resolveCurrentRepositoryDependency(context);
  const ancestry = rootDependency ? [rootDependency] : [];
  preflightExistingDependencyGraph(
    context,
    ancestry,
    new Set<string>(),
  );
  runRecursively(
    context,
    command,
    { visitedConfigPaths: new Set<string>() },
    ancestry,
    true,
  );
}

function resolveCommand(argv: string[]): ArmoryCommand | undefined {
  for (const token of argv) {
    if (token.startsWith("--")) {
      fail(`Unknown option: ${token}`);
    }
    if (
      token !== "init" &&
      token !== "clone" &&
      token !== "fetch" &&
      token !== "pull" &&
      token !== "sync" &&
      token !== "update"
    ) {
      fail(`Unknown command: ${token}`);
    }
    return token;
  }
  return undefined;
}

function loadConfig(configPath: string): ArmoryConfig {
  if (!fs.existsSync(configPath)) {
    fail(`Config not found: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`Failed to parse ${configPath}: ${String(err)}`);
  }
  return normalizeConfig(parsed, configPath);
}

function normalizeConfig(parsed: unknown, configPath: string): ArmoryConfig {
  if (!parsed || typeof parsed !== "object") {
    fail(`Invalid config in ${configPath}: expected an object.`);
  }
  const record = parsed as Record<string, unknown>;
  const workspaceName = stringField(record, "workspaceName");
  if (!workspaceName) {
    fail(`Invalid config in ${configPath}: workspaceName is required.`);
  }
  const repos = record.repos ?? [];
  if (!Array.isArray(repos)) {
    fail(`Invalid config in ${configPath}: repos must be an array.`);
  }
  const normalizedRepos: ArmoryRepo[] = repos.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      fail(`Invalid repos[${index}] in ${configPath}: expected an object.`);
    }
    const repo = entry as Record<string, unknown>;
    const url = stringField(repo, "url");
    if (!url) {
      fail(`Invalid repos[${index}] in ${configPath}: url is required.`);
    }
    return {
      url,
      branch: stringField(repo, "branch") ?? "main",
      repoPath: stringField(repo, "repoPath") ?? "./",
    };
  });

  return {
    workspaceName,
    excludeLocalDir: booleanField(record, "excludeLocalDir") ?? false,
    skipArmoryTasks: booleanField(record, "skipArmoryTasks") ?? false,
    reposRoot: stringField(record, "reposRoot"),
    repos: normalizedRepos,
    workspaceSettings:
      record.workspaceSettings && typeof record.workspaceSettings === "object"
        ? (record.workspaceSettings as Record<string, unknown>)
        : {},
  };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    fail(`Invalid config: ${key} must be a non-empty string.`);
  }
  return value;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    fail(`Invalid config: ${key} must be a boolean.`);
  }
  return value;
}

type ArmoryContext = {
  configPath: string;
  armoryDir: string;
  config: ArmoryConfig;
  reposRootAbs: string;
  workspaceFilePath: string;
  repos: ResolvedRepo[];
};

function resolveContext(
  config: ArmoryConfig,
  configPath: string,
  armoryDir: string,
): ArmoryContext {
  const reposRootRaw = config.reposRoot ?? defaultReposRoot();
  const reposRootAbs = path.resolve(armoryDir, reposRootRaw);
  const workspaceFilePath = path.join(
    armoryDir,
    `${config.workspaceName}.armory.code-workspace`,
  );

  fs.mkdirSync(reposRootAbs, { recursive: true });

  const usedNames = new Map<string, number>();
  const repos = config.repos.map((repo) => {
    const baseName = directoryNameFromGitUrl(repo.url);
    const count = usedNames.get(baseName) ?? 0;
    usedNames.set(baseName, count + 1);
    const folderName = count === 0 ? baseName : `${baseName}-${count + 1}`;
    const cloneDir = path.join(reposRootAbs, folderName);
    const repoPathInside = normalizeRepoPath(repo.repoPath ?? "./");
    const workspaceTarget = path.resolve(cloneDir, repoPathInside);
    const workspaceFolderPath = toWorkspaceRelativePath(
      path.dirname(workspaceFilePath),
      workspaceTarget,
    );

    return {
      url: repo.url,
      branch: repo.branch ?? "main",
      repoPath: repo.repoPath ?? "./",
      cloneDir,
      workspaceFolderPath,
      displayName: folderName,
    };
  });

  return {
    configPath,
    armoryDir,
    config,
    reposRootAbs,
    workspaceFilePath,
    repos,
  };
}

function defaultReposRoot(): string {
  const fromEnv = runtime().env.ARMORY_ROOT;
  if (fromEnv === undefined) {
    return path.join(runtime().homedir(), "armory");
  }
  if (fromEnv.trim() === "") {
    fail("Invalid ARMORY_ROOT: must be a non-empty string.");
  }
  return fromEnv;
}

function directoryNameFromGitUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const withoutGit = trimmed.endsWith(".git") ? trimmed.slice(0, -4) : trimmed;
  const segment = withoutGit.split(/[/:]/).filter(Boolean).pop();
  if (!segment) {
    fail(`Could not derive a directory name from git url: ${url}`);
  }
  return segment;
}

function normalizeRepoPath(repoPath: string): string {
  const normalized = repoPath.replace(/\\/g, "/");
  if (normalized === "." || normalized === "./") {
    return ".";
  }
  return normalized.replace(/^\.\//, "");
}

function toWorkspaceRelativePath(fromDir: string, targetPath: string): string {
  const relative = path.relative(fromDir, targetPath);
  const posix = relative.split(path.sep).join("/");
  return posix === "" ? "." : posix;
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  return runtime().platform === "win32" ? resolved.toLowerCase() : resolved;
}

function canonicalGitUrl(url: string, baseDir: string): string {
  let value = url.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (value.toLowerCase().endsWith(".git")) {
    value = value.slice(0, -4);
  }

  if (
    value.startsWith("./") ||
    value.startsWith("../") ||
    path.isAbsolute(value)
  ) {
    return `file:${canonicalPath(path.resolve(baseDir, value))}`;
  }

  const scpMatch = value.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  if (
    scpMatch &&
    !value.includes("://") &&
    !/^[A-Za-z]:\//.test(value)
  ) {
    return `${scpMatch[1].toLowerCase()}/${scpMatch[2].replace(/^\/+/, "")}`;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol === "file:") {
      return `file:${canonicalPath(fileURLToPath(parsed))}`;
    }
    const host = parsed.hostname.toLowerCase();
    const repoPath = parsed.pathname.replace(/^\/+|\/+$/g, "");
    return `${host}/${repoPath}`;
  } catch {
    return value;
  }
}

function resolveCurrentRepositoryDependency(
  context: ArmoryContext,
): DependencyHop | undefined {
  const gitRoot = findGitRoot(context.armoryDir);
  if (!gitRoot) {
    return undefined;
  }

  const result = runtime().spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: gitRoot,
    encoding: "utf8",
  });
  const origin = result.status === 0 ? result.stdout.trim() : "";
  if (!origin) {
    return undefined;
  }
  return {
    key: canonicalGitUrl(origin, gitRoot),
    label: origin,
  };
}

function assertNoImmediateCycles(
  context: ArmoryContext,
  ancestry: DependencyHop[],
): void {
  const ancestorKeys = new Set(ancestry.map((hop) => hop.key));
  for (const repo of context.repos) {
    const key = canonicalGitUrl(repo.url, context.armoryDir);
    if (!ancestorKeys.has(key)) {
      continue;
    }
    const chain = [...ancestry.map((hop) => hop.label), repo.url].join("\n    -> ");
    fail(
      `Cyclic dependency detected in ${context.configPath}:\n    ${chain}\n` +
      "No repositories from this dependency level were cloned.",
    );
  }
}

function executeCommand(context: ArmoryContext, command: ArmoryCommand): void {
  switch (command) {
    case "init":
      fail("The init command cannot run as a dependency operation.");
      break;
    case "clone":
      cloneAll(context);
      break;
    case "fetch":
      fetchAll(context);
      break;
    case "pull":
      pullAll(context);
      break;
    case "sync":
      cloneAll(context);
      fetchAll(context);
      pullAll(context);
      break;
    case "update":
      fail("The update command cannot run as a dependency operation.");
  }
}

function initConfig(): void {
  const configPath = path.resolve(runtime().cwd(), "armory.json");
  if (fs.existsSync(configPath)) {
    fail(`Config already exists: ${configPath}`);
  }

  const workspaceName = path.basename(runtime().cwd()) || runtime().cwd();
  const document: Record<string, unknown> = {
    workspaceName,
    repos: [],
  };
  const workspaceSettings = readCurrentWorkspace(runtime().cwd());
  if (workspaceSettings && Object.keys(workspaceSettings).length > 0) {
    document.workspaceSettings = workspaceSettings;
  }

  fs.writeFileSync(configPath, `${JSON.stringify(document, null, 4)}\n`, "utf8");
  log(`created: ${configPath}`);
}

function findCurrentWorkspaceFile(dir: string): string | undefined {
  const names = fs.readdirSync(dir).filter((name) => {
    if (!name.endsWith(".code-workspace")) {
      return false;
    }
    return fs.statSync(path.join(dir, name)).isFile();
  });
  if (names.length === 0) {
    return undefined;
  }
  if (names.length === 1) {
    return path.join(dir, names[0]);
  }

  const folderName = path.basename(dir).toLowerCase();
  const preferred = [
    `${folderName}.code-workspace`,
    `${folderName}.armory.code-workspace`,
  ];
  for (const candidate of preferred) {
    const match = names.find((name) => name.toLowerCase() === candidate);
    if (match) {
      return path.join(dir, match);
    }
  }

  fail(
    `Multiple workspace files in ${dir}: ${names.join(", ")}. ` +
      `Could not determine the current workspace.`,
  );
}

/** VS Code / Cursor `.code-workspace` files are JSON with comments and trailing commas. */
function parseJsonc(text: string): unknown {
  const stripped = stripJsonComments(text);
  const withoutTrailingCommas = removeJsonTrailingCommas(stripped);
  return JSON.parse(withoutTrailingCommas);
}

function stripJsonComments(json: string): string {
  const out: string[] = [];
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    const next = json[i + 1];

    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false;
        out.push(char);
      }
      continue;
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      out.push(char);
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      out.push(char);
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }

    if (char === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }

    out.push(char);
  }

  return out.join("");
}

function removeJsonTrailingCommas(json: string): string {
  const out: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < json.length; i++) {
    const char = json[i];

    if (inString) {
      out.push(char);
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      out.push(char);
      continue;
    }

    if (char === ",") {
      let j = i + 1;
      while (j < json.length && /\s/.test(json[j])) {
        j++;
      }
      const next = json[j];
      if (next === "}" || next === "]") {
        continue;
      }
    }

    out.push(char);
  }

  return out.join("");
}

function readCurrentWorkspace(dir: string): Record<string, unknown> | undefined {
  const workspacePath = findCurrentWorkspaceFile(dir);
  if (!workspacePath) {
    return undefined;
  }

  let parsed: unknown;
  try {
    const raw = fs.readFileSync(workspacePath, "utf8").replace(/^\uFEFF/, "");
    parsed = parseJsonc(raw);
  } catch (err) {
    fail(`Failed to parse ${workspacePath}: ${String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`Invalid workspace file ${workspacePath}: expected an object.`);
  }
  return parsed as Record<string, unknown>;
}

async function updateScript(): Promise<void> {
  const scriptArg = runtime().argv[1];
  if (!scriptArg) {
    fail("Could not determine the current armory.ts path.");
  }

  const scriptPath = path.resolve(scriptArg);
  const tempPath = `${scriptPath}.update-${runtime().pid}-${runtime().now()}`;
  log(`update: downloading ${ARMORY_RAW_URL}`);

  let response: Response;
  try {
    response = await runtime().fetch(ARMORY_RAW_URL, {
      headers: { "user-agent": "Armory self-update" },
    });
  } catch (err) {
    fail(`Failed to download update: ${String(err)}`);
  }
  if (!response.ok) {
    fail(
      `Failed to download update: HTTP ${response.status} ${response.statusText}`,
    );
  }

  let source: string;
  try {
    source = await response.text();
  } catch (err) {
    fail(`Failed to read update response: ${String(err)}`);
  }
  if (
    !source.startsWith("#!/usr/bin/env node") ||
    !source.includes("ARMORY_RAW_URL")
  ) {
    fail("Downloaded file did not look like a valid Armory script.");
  }

  try {
    const mode = fs.statSync(scriptPath).mode;
    fs.writeFileSync(tempPath, source, { encoding: "utf8", mode });
    fs.renameSync(tempPath, scriptPath);
  } catch (err) {
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }
    fail(`Failed to replace ${scriptPath}: ${String(err)}`);
  }

  log(`updated: ${scriptPath}`);
}

function dependencyConfigPath(repo: ResolvedRepo): string {
  return path.join(
    path.resolve(repo.cloneDir, normalizeRepoPath(repo.repoPath)),
    "armory.json",
  );
}

function dependencyHop(repo: ResolvedRepo, context: ArmoryContext): DependencyHop {
  return {
    key: canonicalGitUrl(repo.url, context.armoryDir),
    label: repo.url,
  };
}

/**
 * Checks the complete dependency graph that is already present on disk before
 * clone can make changes. Newly cloned configurations are checked again before
 * cloning any repositories from their dependency level.
 */
function preflightExistingDependencyGraph(
  context: ArmoryContext,
  ancestry: DependencyHop[],
  visitedConfigPaths: Set<string>,
): void {
  assertNoImmediateCycles(context, ancestry);

  const configKey = canonicalPath(context.configPath);
  if (visitedConfigPaths.has(configKey)) {
    return;
  }
  visitedConfigPaths.add(configKey);

  for (const repo of context.repos) {
    const childConfigPath = dependencyConfigPath(repo);
    if (!fs.existsSync(childConfigPath)) {
      continue;
    }
    const childDir = path.dirname(childConfigPath);
    const childContext = resolveContext(
      loadConfig(childConfigPath),
      childConfigPath,
      childDir,
    );
    preflightExistingDependencyGraph(
      childContext,
      [...ancestry, dependencyHop(repo, context)],
      visitedConfigPaths,
    );
  }
}

function runRecursively(
  context: ArmoryContext,
  command: ArmoryCommand,
  state: RecursiveRunState,
  ancestry: DependencyHop[],
  isRoot: boolean,
): void {
  const configKey = canonicalPath(context.configPath);
  if (state.visitedConfigPaths.has(configKey)) {
    log(`skip dependency (already processed): ${context.configPath}`);
    return;
  }
  state.visitedConfigPaths.add(configKey);

  // Validate every edge at this level before cloneAll can mutate the filesystem.
  assertNoImmediateCycles(context, ancestry);
  executeCommand(context, command);
  ensureLocalSetup(context, isRoot);

  for (const repo of context.repos) {
    const childConfigPath = dependencyConfigPath(repo);
    if (!fs.existsSync(childConfigPath)) {
      continue;
    }

    const dependencyDir = path.dirname(childConfigPath);
    const dependencyContext = resolveContext(
      loadConfig(childConfigPath),
      childConfigPath,
      dependencyDir,
    );
    runRecursively(
      dependencyContext,
      command,
      state,
      [...ancestry, dependencyHop(repo, context)],
      false,
    );
  }
}

function cloneAll(context: ArmoryContext): void {
  for (const repo of context.repos) {
    if (fs.existsSync(path.join(repo.cloneDir, ".git"))) {
      log(`skip clone (exists): ${repo.cloneDir}`);
      continue;
    }
    if (fs.existsSync(repo.cloneDir)) {
      fail(
        `Cannot clone ${repo.url}: ${repo.cloneDir} exists but is not a git repository.`,
      );
    }
    log(`clone ${repo.url} -> ${repo.cloneDir} (branch ${repo.branch})`);
    runGit(["clone", "--branch", repo.branch, "--single-branch", repo.url, repo.cloneDir]);
  }
}

function fetchAll(context: ArmoryContext): void {
  for (const repo of context.repos) {
    ensureGitRepo(repo);
    log(`fetch: ${repo.cloneDir}`);
    runGit(["fetch", "--all", "--prune"], repo.cloneDir);
  }
}

function pullAll(context: ArmoryContext): void {
  for (const repo of context.repos) {
    ensureGitRepo(repo);
    log(`pull: ${repo.cloneDir}`);
    runGit(["pull", "--ff-only"], repo.cloneDir);
  }
}

const GITIGNORE_MANAGED_START = "# >>> armory (managed)";
const GITIGNORE_MANAGED_END = "# <<< armory (managed)";

function ensureLocalSetup(context: ArmoryContext, writeWorkspaceFile: boolean): void {
  if (writeWorkspaceFile) {
    writeWorkspace(context);
  }
  ensureGitignore(context);
}

function findGitRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (; ;) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

function isPathInGitWorkTree(targetAbs: string, gitRoot: string): boolean {
  const relative = path.relative(gitRoot, path.resolve(targetAbs));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function toPosixRelative(fromDir: string, targetAbs: string): string {
  const relative = path.relative(fromDir, path.resolve(targetAbs));
  return relative.split(path.sep).join("/");
}

type GitignoreUpdate = {
  gitignorePath: string;
  lines: string[];
};

function collectGitignoreUpdates(context: ArmoryContext): GitignoreUpdate[] {
  const gitRoot = findGitRoot(context.armoryDir);
  if (!gitRoot) {
    return [];
  }

  const byPath = new Map<string, Set<string>>();

  const addLines = (gitignorePath: string, lines: string[]): void => {
    const gitignoreDir = path.dirname(gitignorePath);
    if (!isPathInGitWorkTree(gitignoreDir, gitRoot)) {
      return;
    }
    let set = byPath.get(gitignorePath);
    if (!set) {
      set = new Set<string>();
      byPath.set(gitignorePath, set);
    }
    for (const line of lines) {
      set.add(line);
    }
  };

  if (isPathInGitWorkTree(context.armoryDir, gitRoot)) {
    addLines(path.join(context.armoryDir, ".gitignore"), [
      "armory.ts",
      "*.armory.code-workspace",
    ]);
  }

  if (isPathInGitWorkTree(context.reposRootAbs, gitRoot)) {
    for (const update of reposRootGitignoreUpdates(gitRoot, context)) {
      addLines(update.gitignorePath, update.lines);
    }
  }

  return [...byPath.entries()].map(([gitignorePath, lines]) => ({
    gitignorePath,
    lines: [...lines],
  }));
}

function reposRootGitignoreUpdates(
  gitRoot: string,
  context: ArmoryContext,
): GitignoreUpdate[] {
  const reposRootAbs = path.resolve(context.reposRootAbs);
  const gitignoreDir = path.dirname(reposRootAbs);

  if (isPathInGitWorkTree(gitignoreDir, gitRoot)) {
    const entry = toPosixRelative(gitignoreDir, reposRootAbs);
    if (entry !== "" && entry !== ".") {
      return [
        {
          gitignorePath: path.join(gitignoreDir, ".gitignore"),
          lines: [`${entry}/`],
        },
      ];
    }
  }

  const entryFromGitRoot = toPosixRelative(gitRoot, reposRootAbs);
  if (entryFromGitRoot !== "" && entryFromGitRoot !== ".") {
    return [
      {
        gitignorePath: path.join(gitRoot, ".gitignore"),
        lines: [`${entryFromGitRoot}/`],
      },
    ];
  }

  const cloneLines: string[] = [];
  for (const repo of context.repos) {
    if (!isPathInGitWorkTree(repo.cloneDir, gitRoot)) {
      continue;
    }
    const rel = toPosixRelative(gitRoot, repo.cloneDir);
    if (rel !== "" && rel !== ".") {
      cloneLines.push(`${rel}/`);
    }
  }
  if (cloneLines.length === 0) {
    return [];
  }
  return [
    {
      gitignorePath: path.join(gitRoot, ".gitignore"),
      lines: cloneLines,
    },
  ];
}

function mergeManagedGitignoreBlock(
  existing: string,
  managedLines: string[],
): string {
  const blockBody = managedLines.join("\n");
  const block = `${GITIGNORE_MANAGED_START}\n${blockBody}\n${GITIGNORE_MANAGED_END}`;
  const blockPattern = new RegExp(
    `${escapeRegExp(GITIGNORE_MANAGED_START)}[\\s\\S]*?${escapeRegExp(GITIGNORE_MANAGED_END)}\\n?`,
    "m",
  );

  if (blockPattern.test(existing)) {
    const updated = existing.replace(blockPattern, `${block}\n`);
    return updated.endsWith("\n") ? updated : `${updated}\n`;
  }

  const trimmed = existing.replace(/\s+$/, "");
  if (trimmed === "") {
    return `${block}\n`;
  }
  return `${trimmed}\n\n${block}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureGitignore(context: ArmoryContext): void {
  for (const update of collectGitignoreUpdates(context)) {
    const existing = fs.existsSync(update.gitignorePath)
      ? fs.readFileSync(update.gitignorePath, "utf8")
      : "";
    const managedLines = [...new Set(update.lines)];
    const next = mergeManagedGitignoreBlock(existing, managedLines);
    if (next === existing) {
      continue;
    }
    fs.writeFileSync(update.gitignorePath, next, "utf8");
    log(`gitignore: ${update.gitignorePath}`);
  }
}

const ARMORY_TASK_LABELS = [
  "Armory: clone",
  "Armory: fetch",
  "Armory: pull",
  "Armory: sync",
  "Armory: update",
] as const;

function armoryTaskCwd(context: ArmoryContext): string {
  if (!context.config.excludeLocalDir) {
    const name = path.basename(context.armoryDir) || context.armoryDir;
    return `\${workspaceFolder:${name}}`;
  }
  return "${fileDirname:${workspaceFile}}";
}

function buildArmoryShellTask(
  label: string,
  armoryCommand: string,
  cwd: string,
): Record<string, unknown> {
  return {
    label,
    type: "shell",
    command: `node armory.ts ${armoryCommand}`,
    options: { cwd },
    presentation: {
      reveal: "always",
      panel: "shared",
    },
  };
}

function buildArmoryTasksSection(context: ArmoryContext): Record<string, unknown> {
  const cwd = armoryTaskCwd(context);
  return {
    version: "2.0.0",
    tasks: ARMORY_TASK_LABELS.map((label) => {
      const command = label.replace("Armory: ", "");
      return buildArmoryShellTask(label, command, cwd);
    }),
  };
}

function mergeWorkspaceTasks(
  userTasks: unknown,
  armoryTasks: Record<string, unknown>,
): Record<string, unknown> {
  const armoryTaskList = Array.isArray(armoryTasks.tasks)
    ? (armoryTasks.tasks as Record<string, unknown>[])
    : [];
  const armoryLabelSet = new Set<string>(ARMORY_TASK_LABELS);

  let version = "2.0.0";
  const userTaskList: Record<string, unknown>[] = [];

  if (userTasks && typeof userTasks === "object") {
    const record = userTasks as Record<string, unknown>;
    if (typeof record.version === "string") {
      version = record.version;
    }
    if (Array.isArray(record.tasks)) {
      for (const task of record.tasks) {
        if (!task || typeof task !== "object") {
          continue;
        }
        const entry = task as Record<string, unknown>;
        const label = entry.label;
        if (typeof label === "string" && armoryLabelSet.has(label)) {
          continue;
        }
        userTaskList.push(entry);
      }
    }
  }

  return {
    version,
    tasks: [...userTaskList, ...armoryTaskList],
  };
}

function writeWorkspace(context: ArmoryContext): void {
  const folders: Array<{ name: string; path: string }> = [];

  if (!context.config.excludeLocalDir) {
    folders.push({
      name: path.basename(context.armoryDir) || context.armoryDir,
      path: ".",
    });
  }

  for (const repo of context.repos) {
    folders.push({
      name: repo.displayName,
      path: repo.workspaceFolderPath,
    });
  }

  const userWorkspace = context.config.workspaceSettings ?? {};
  const {
    folders: _extraFolders,
    tasks: userTasks,
    ...workspaceRest
  } = userWorkspace;
  const extraFolders = Array.isArray(_extraFolders) ? _extraFolders : [];

  const armoryTasks = context.config.skipArmoryTasks
    ? { version: "2.0.0", tasks: [] }
    : buildArmoryTasksSection(context);
  const tasks = mergeWorkspaceTasks(userTasks, armoryTasks);

  const document: Record<string, unknown> = {
    ...workspaceRest,
    folders: [...folders, ...extraFolders],
  };
  if (Array.isArray(tasks.tasks) && tasks.tasks.length > 0) {
    document.tasks = tasks;
  }

  const json = `${JSON.stringify(document, null, 4)}\n`;
  fs.writeFileSync(context.workspaceFilePath, json, "utf8");
  log(`workspace: ${context.workspaceFilePath}`);
}

function ensureGitRepo(repo: ResolvedRepo): void {
  if (!fs.existsSync(path.join(repo.cloneDir, ".git"))) {
    fail(
      `Repository not cloned: ${repo.cloneDir}. Run "node armory.ts clone" first.`,
    );
  }
}

function runGit(args: string[], cwd?: string): void {
  const result = runtime().spawnSync("git", args, {
    cwd,
    stdio: "inherit",
  });
  if (result.error) {
    fail(`git failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`git ${args.join(" ")} exited with code ${result.status ?? "unknown"}`);
  }
}

function log(message: string): void {
  runtime().stdout.write(`${message}\n`);
}

function fail(message: string): never {
  runtime().stderr.write(`armory: ${message}\n`);
  throw new ArmoryFailure(message);
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  const invoked = path.resolve(entry);
  const self = fileURLToPath(import.meta.url);
  return process.platform === "win32"
    ? invoked.toLowerCase() === self.toLowerCase()
    : invoked === self;
}

if (isDirectExecution()) {
  runArmory().catch((err: unknown) => {
    if (!(err instanceof ArmoryFailure)) {
      process.stderr.write(`armory: Unexpected error: ${String(err)}\n`);
    }
    process.exit(1);
  });
}
