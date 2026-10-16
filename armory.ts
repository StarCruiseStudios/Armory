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
 * armory.json workspace and repository configuration:
 * {
 *     "workspaceName": "name", // Required. Base name of <workspaceName>.armory.code-workspace.
 *     "repos": [ // Optional. Repositories to clone. Defaults to [].
 *         {
 *             "url": "https://github.com/org/repo.git", // Required. Git clone URL.
 *             "branch": "main", // Optional. When set, clone that branch into <owner>/<repo>-<branch>. When omitted, use the remote default at <owner>/<repo>.
 *             "repoPath": "./" // Optional. Subpath inside the clone added as a workspace folder. Defaults to ./.
 *         }
 *     ],
 *     "reposRoot": "~/armory", // Optional. Where repos are cloned, as <reposRoot>/<owner>/<name>. Relative to armory.json or absolute. When omitted, Armory uses ARMORY_ROOT, then ~/armory.
 *     "excludeLocalDir": false, // Optional. If true, omit this directory from the workspace.
 *     "skipArmoryTasks": false, // Optional. If true, omit Armory shell tasks from the workspace.
 *     "workspaceSettings": {} // Optional. Extra VS Code workspace JSON (settings, launch configs, additional folders, tasks, and so on) merged into the generated workspace file.
 * }
 */

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
  branch?: string;
  repoPath: string;
  cloneDir: string;
  workspaceFolderPath: string;
  displayName: string;
};

type ArmoryCommand = "init" | "clone" | "fetch" | "pull" | "sync" | "update";

type DependencyCommand = "clone" | "fetch" | "pull" | "sync";

type DependencyHop = {
  key: string;
  label: string;
};

type ParsedGitUrl = {
  kind: "remote" | "local";
  canonicalKey: string;
  pathSegments: string[];
};

type ArmoryContext = {
  configPath: string;
  armoryDir: string;
  config: ArmoryConfig;
  reposRootAbs: string;
  workspaceFilePath: string;
  repos: ResolvedRepo[];
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
  sync       Recursively clone, then pull.
  update     Download and replace armory.ts with the latest version.

Options:
  --help            Show help

armory.json workspace and repository configuration:
{
    "workspaceName": "name", // Required. Names <workspaceName>.armory.code-workspace.
    "repos": [ // Optional. Repositories to clone. Defaults to [].
        {
            "url": "https://github.com/org/repo.git", // Required. Git clone URL.
            "branch": "main", // Optional. When set, clone that branch into <owner>/<repo>-<branch>. When omitted, use the remote default at <owner>/<repo>.
            "repoPath": "./" // Optional. Subpath added as a workspace folder. Defaults to ./.
        }
    ],
    "reposRoot": "~/armory", // Optional. Clone directory. Each repo is placed at <reposRoot>/<owner>/<name>. Relative to armory.json or absolute. Defaults to ARMORY_ROOT, then ~/armory.
    "excludeLocalDir": false, // Optional. If true, omit this directory from the workspace.
    "skipArmoryTasks": false, // Optional. If true, omit Armory shell tasks from the workspace.
    "workspaceSettings": {} // Optional. Extra VS Code workspace JSON merged into the generated workspace file.
}
`;

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

/** Runs one Armory invocation. Tests pass overrides so git and network stay local. */
export async function runArmory(overrides?: Partial<Runtime>): Promise<void> {
  const runner = new ArmoryRunner({ ...createDefaultRuntime(), ...overrides });
  await runner.run();
}

class ArmoryRunner {
  private readonly rt: Runtime;
  private operationFailures: string[] = [];

  constructor(runtime: Runtime) {
    this.rt = runtime;
  }

  async run(): Promise<void> {
    const argv = this.rt.argv.slice(2);
    if (argv.includes("--help") || argv.length === 0) {
      this.rt.stdout.write(HELP);
      this.rt.exit(argv.length === 0 ? 1 : 0);
    }

    const command = this.resolveCommand(argv);
    if (!command) {
      this.fail("Missing command. Use --help for usage.");
    }
    if (command === "update") {
      await this.updateScript();
      return;
    }
    if (command === "init") {
      this.initConfig();
      return;
    }

    const configPath = path.resolve(this.rt.cwd(), "armory.json");
    const config = this.loadConfig(configPath);
    const armoryDir = path.dirname(path.resolve(configPath));
    const context = this.resolveContext(config, configPath, armoryDir);
    const rootDependency = this.resolveCurrentRepositoryDependency(context);
    const ancestry = rootDependency ? [rootDependency] : [];
    this.preflightExistingDependencyGraph(context, ancestry, new Set<string>());
    this.runRecursively(
      context,
      command,
      new Set<string>(),
      ancestry,
      true,
    );
  }

  private resolveCommand(argv: string[]): ArmoryCommand | undefined {
    let command: ArmoryCommand | undefined;
    for (const token of argv) {
      if (token.startsWith("--")) {
        this.fail(`Unknown option: ${token}`);
      }
      const isCommand =
        token === "init" ||
        token === "clone" ||
        token === "fetch" ||
        token === "pull" ||
        token === "sync" ||
        token === "update";
      if (!isCommand) {
        if (command) {
          this.fail(`Unexpected extra argument: ${token}`);
        }
        this.fail(`Unknown command: ${token}`);
      }
      if (command) {
        this.fail(`Unexpected extra argument: ${token}`);
      }
      command = token;
    }
    return command;
  }

  private loadConfig(configPath: string): ArmoryConfig {
    if (!fs.existsSync(configPath)) {
      this.fail(`Config not found: ${configPath}`);
    }
    const raw = fs.readFileSync(configPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.fail(`Failed to parse ${configPath}: ${String(err)}`);
    }
    return this.normalizeConfig(parsed, configPath);
  }

  private normalizeConfig(parsed: unknown, configPath: string): ArmoryConfig {
    if (!parsed || typeof parsed !== "object") {
      this.fail(`Invalid config in ${configPath}: expected an object.`);
    }
    const record = parsed as Record<string, unknown>;
    const workspaceName = this.stringField(record, "workspaceName", configPath);
    if (!workspaceName) {
      this.fail(`Invalid config in ${configPath}: workspaceName is required.`);
    }
    this.assertSafeWorkspaceName(workspaceName, configPath);
    const repos = record.repos ?? [];
    if (!Array.isArray(repos)) {
      this.fail(`Invalid config in ${configPath}: repos must be an array.`);
    }
    const normalizedRepos: ArmoryRepo[] = repos.map((entry, index) => {
      if (!entry || typeof entry !== "object") {
        this.fail(`Invalid repos[${index}] in ${configPath}: expected an object.`);
      }
      const repo = entry as Record<string, unknown>;
      const url = this.stringField(repo, "url", configPath);
      if (!url) {
        this.fail(`Invalid repos[${index}] in ${configPath}: url is required.`);
      }
      if (url.startsWith("-")) {
        this.fail(`Invalid repos[${index}] in ${configPath}: url must not start with '-'.`);
      }
      const branch = this.stringField(repo, "branch", configPath);
      if (branch?.startsWith("-")) {
        this.fail(`Invalid repos[${index}] in ${configPath}: branch must not start with '-'.`);
      }
      return {
        url,
        branch,
        repoPath: this.stringField(repo, "repoPath", configPath) ?? "./",
      };
    });

    let workspaceSettings: Record<string, unknown> = {};
    if (record.workspaceSettings !== undefined) {
      const value = record.workspaceSettings;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        this.fail(`Invalid config in ${configPath}: workspaceSettings must be an object.`);
      }
      workspaceSettings = value as Record<string, unknown>;
    }

    return {
      workspaceName,
      excludeLocalDir: this.booleanField(record, "excludeLocalDir", configPath) ?? false,
      skipArmoryTasks: this.booleanField(record, "skipArmoryTasks", configPath) ?? false,
      reposRoot: this.stringField(record, "reposRoot", configPath),
      repos: normalizedRepos,
      workspaceSettings,
    };
  }

  private assertSafeWorkspaceName(workspaceName: string, configPath: string): void {
    if (
      workspaceName.includes("/") ||
      workspaceName.includes("\\") ||
      workspaceName.includes("..")
    ) {
      this.fail(
        `Invalid config in ${configPath}: workspaceName must not contain path separators or '..'.`,
      );
    }
  }

  private stringField(
    record: Record<string, unknown>,
    key: string,
    configPath: string,
  ): string | undefined {
    const value = record[key];
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "string" || value.trim() === "") {
      this.fail(`Invalid config in ${configPath}: ${key} must be a non-empty string.`);
    }
    return value;
  }

  private booleanField(
    record: Record<string, unknown>,
    key: string,
    configPath: string,
  ): boolean | undefined {
    const value = record[key];
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "boolean") {
      this.fail(`Invalid config in ${configPath}: ${key} must be a boolean.`);
    }
    return value;
  }

  private resolveContext(
    config: ArmoryConfig,
    configPath: string,
    armoryDir: string,
  ): ArmoryContext {
    const reposRootRaw = config.reposRoot ?? this.defaultReposRoot();
    const reposRootAbs = path.resolve(armoryDir, reposRootRaw);
    const workspaceFilePath = path.join(
      armoryDir,
      `${config.workspaceName}.armory.code-workspace`,
    );

    const cloneSlots = new Map<string, string>();
    const cloneRelativeOwners = new Map<string, string>();

    const repos = config.repos.map((repo) => {
      const repoPathValue = repo.repoPath ?? "./";
      const repoPathInside = this.normalizeRepoPath(repoPathValue);
      const parsed = this.parseGitUrl(repo.url, armoryDir);
      const cloneKey = `${parsed.canonicalKey}\0${repo.branch ?? ""}`;
      const cloneRelative = this.cloneRelativePathWithBranch(
        this.cloneRelativePathFromParsed(parsed, repo.url),
        repo.branch,
      );

      let cloneDir: string;
      const existingDir = cloneSlots.get(cloneKey);
      if (existingDir) {
        cloneDir = existingDir;
      } else {
        const ownerKey = cloneRelativeOwners.get(cloneRelative);
        if (ownerKey !== undefined && ownerKey !== cloneKey) {
          this.fail(
            `Cannot clone ${repo.url}: ${path.join(reposRootAbs, ...cloneRelative.split("/"))} ` +
            "is already used by another repository with the same branch treatment.",
          );
        }
        cloneDir = path.join(reposRootAbs, ...cloneRelative.split("/"));
        cloneSlots.set(cloneKey, cloneDir);
        cloneRelativeOwners.set(cloneRelative, cloneKey);
      }

      const workspaceTarget = path.resolve(cloneDir, repoPathInside);
      const workspaceFolderPath = this.toPosixRelative(
        path.dirname(workspaceFilePath),
        workspaceTarget,
      );

      return {
        url: repo.url,
        branch: repo.branch,
        repoPath: repoPathInside,
        cloneDir,
        workspaceFolderPath,
        displayName: this.workspaceDisplayName(cloneRelative, repoPathInside),
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

  private defaultReposRoot(): string {
    const fromEnv = this.rt.env.ARMORY_ROOT;
    if (fromEnv === undefined) {
      return path.join(this.rt.homedir(), "armory");
    }
    if (fromEnv.trim() === "") {
      this.fail("Invalid ARMORY_ROOT: must be a non-empty string.");
    }
    return fromEnv;
  }

  private cloneRelativePathWithBranch(
    baseRelative: string,
    branch?: string,
  ): string {
    if (!branch) {
      return baseRelative;
    }
    const flatBranch = branch.replace(/[/\\]+/g, "-");
    const parts = baseRelative.split("/");
    parts[parts.length - 1] = `${parts[parts.length - 1]}-${flatBranch}`;
    return parts.join("/");
  }

  private workspaceDisplayName(
    cloneRelative: string,
    repoPathInside: string,
  ): string {
    if (repoPathInside === ".") {
      return cloneRelative;
    }
    return `${cloneRelative}/${repoPathInside}`;
  }

  private uniqueCloneDirs(repos: ResolvedRepo[]): ResolvedRepo[] {
    const seen = new Set<string>();
    const unique: ResolvedRepo[] = [];
    for (const repo of repos) {
      const key = this.canonicalPath(repo.cloneDir);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      unique.push(repo);
    }
    return unique;
  }

  private cloneRelativePathFromParsed(parsed: ParsedGitUrl, url: string): string {
    const segments = parsed.pathSegments.filter((segment) => segment !== ".");
    if (parsed.kind === "remote") {
      if (segments.length < 2 || segments.some((segment) => segment === "..")) {
        this.fail(`Could not derive an owner and repository name from git url: ${url}`);
      }
      return segments.join("/");
    }
    const segment = segments.filter((part) => part !== "..").at(-1);
    if (!segment) {
      this.fail(`Could not derive an owner and repository name from git url: ${url}`);
    }
    return segment;
  }

  private parseGitUrl(url: string, baseDir: string): ParsedGitUrl {
    let value = url.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (value.toLowerCase().endsWith(".git")) {
      value = value.slice(0, -4);
    }

    if (
      value.startsWith("./") ||
      value.startsWith("../") ||
      path.isAbsolute(value)
    ) {
      const resolved = this.canonicalPath(path.resolve(baseDir, value));
      const segment = path.basename(resolved);
      return {
        kind: "local",
        canonicalKey: `file:${resolved}`,
        pathSegments: segment ? [segment] : [],
      };
    }

    const scpMatch = value.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
    if (
      scpMatch &&
      !value.includes("://") &&
      !/^[A-Za-z]:\//.test(value)
    ) {
      const host = scpMatch[1].toLowerCase();
      const repoPath = scpMatch[2].replace(/^\/+|\/+$/g, "");
      const segments = repoPath.split("/").filter(Boolean);
      return {
        kind: "remote",
        canonicalKey: `${host}/${repoPath}`,
        pathSegments: segments,
      };
    }

    try {
      const parsed = new URL(value);
      if (parsed.protocol === "file:") {
        const resolved = this.canonicalPath(fileURLToPath(parsed));
        const segment = path.basename(resolved);
        return {
          kind: "local",
          canonicalKey: `file:${resolved}`,
          pathSegments: segment ? [segment] : [],
        };
      }
      const remote = parsed.protocol === "http:" ||
        parsed.protocol === "https:" ||
        parsed.protocol === "ssh:";
      const host = parsed.hostname.toLowerCase();
      const repoPath = parsed.pathname.replace(/^\/+|\/+$/g, "");
      const segments = repoPath.split("/").filter(Boolean);
      return {
        kind: remote ? "remote" : "local",
        canonicalKey: `${host}/${repoPath}`,
        pathSegments: segments,
      };
    } catch {
      return {
        kind: "local",
        canonicalKey: value,
        pathSegments: value.split("/").filter(Boolean),
      };
    }
  }

  private normalizeRepoPath(repoPath: string): string {
    const normalized = repoPath.replace(/\\/g, "/");
    if (normalized === "." || normalized === "./") {
      return ".";
    }
    return normalized.replace(/^\.\//, "");
  }

  private toPosixRelative(fromDir: string, targetPath: string): string {
    const relative = path.relative(fromDir, path.resolve(targetPath));
    const posix = relative.split(path.sep).join("/");
    return posix === "" ? "." : posix;
  }

  private canonicalPath(value: string): string {
    const resolved = path.resolve(value);
    return this.rt.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  private resolveCurrentRepositoryDependency(
    context: ArmoryContext,
  ): DependencyHop | undefined {
    const gitRoot = this.findGitRoot(context.armoryDir);
    if (!gitRoot) {
      return undefined;
    }

    const result = this.rt.spawnSync("git", ["remote", "get-url", "origin"], {
      cwd: gitRoot,
      encoding: "utf8",
    });
    const origin = result.status === 0 ? result.stdout.trim() : "";
    if (!origin) {
      return undefined;
    }
    const parsed = this.parseGitUrl(origin, gitRoot);
    return {
      key: parsed.canonicalKey,
      label: origin,
    };
  }

  private assertNoImmediateCycles(
    context: ArmoryContext,
    ancestry: DependencyHop[],
  ): void {
    const ancestorKeys = new Set(ancestry.map((hop) => hop.key));
    for (const repo of context.repos) {
      const key = this.parseGitUrl(repo.url, context.armoryDir).canonicalKey;
      if (!ancestorKeys.has(key)) {
        continue;
      }
      const chain = [...ancestry.map((hop) => hop.label), repo.url].join("\n    -> ");
      this.fail(
        `Cyclic dependency detected in ${context.configPath}:\n    ${chain}\n` +
        "No repositories from this dependency level were cloned.",
      );
    }
  }

  private executeCommand(context: ArmoryContext, command: DependencyCommand): void {
    this.operationFailures = [];
    switch (command) {
      case "clone":
        this.cloneAll(context);
        break;
      case "fetch":
        this.fetchAll(context);
        this.reportOperationFailures();
        break;
      case "pull":
        this.pullAll(context);
        this.reportOperationFailures();
        break;
      case "sync":
        this.cloneAll(context);
        this.pullAll(context);
        this.reportOperationFailures();
        break;
    }
  }

  private initConfig(): void {
    const configPath = path.resolve(this.rt.cwd(), "armory.json");
    if (fs.existsSync(configPath)) {
      this.fail(`Config already exists: ${configPath}`);
    }

    const workspaceName = path.basename(this.rt.cwd()) || this.rt.cwd();
    const document: Record<string, unknown> = {
      workspaceName,
      repos: [],
    };
    const workspaceSettings = this.readCurrentWorkspace(this.rt.cwd());
    if (workspaceSettings && Object.keys(workspaceSettings).length > 0) {
      document.workspaceSettings = workspaceSettings;
    }

    fs.writeFileSync(configPath, `${JSON.stringify(document, null, 4)}\n`, "utf8");
    this.log(`created: ${configPath}`);

    const config = this.normalizeConfig(document, configPath);
    this.ensureLocalSetup(
      this.resolveContext(config, configPath, path.dirname(configPath)),
    );
  }

  private findCurrentWorkspaceFile(dir: string): string | undefined {
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

    this.fail(
      `Multiple workspace files in ${dir}: ${names.join(", ")}. ` +
      `Could not determine the current workspace.`,
    );
  }

  /** VS Code / Cursor `.code-workspace` files are JSON with comments and trailing commas. */
  private parseJsonc(text: string): unknown {
    const out: string[] = [];
    let inString = false;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const next = text[i + 1];

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

      if (char === ",") {
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) {
          j++;
        }
        const afterComma = text[j];
        if (afterComma === "}" || afterComma === "]") {
          continue;
        }
      }

      out.push(char);
    }

    return JSON.parse(out.join(""));
  }

  private readCurrentWorkspace(dir: string): Record<string, unknown> | undefined {
    const workspacePath = this.findCurrentWorkspaceFile(dir);
    if (!workspacePath) {
      return undefined;
    }

    let parsed: unknown;
    try {
      const raw = fs.readFileSync(workspacePath, "utf8").replace(/^\uFEFF/, "");
      parsed = this.parseJsonc(raw);
    } catch (err) {
      this.fail(`Failed to parse ${workspacePath}: ${String(err)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.fail(`Invalid workspace file ${workspacePath}: expected an object.`);
    }
    return parsed as Record<string, unknown>;
  }

  private async updateScript(): Promise<void> {
    const scriptArg = this.rt.argv[1];
    if (!scriptArg) {
      this.fail("Could not determine the current armory.ts path.");
    }

    const scriptPath = path.resolve(scriptArg);
    const tempPath = `${scriptPath}.update-${this.rt.pid}-${this.rt.now()}`;
    this.log(`update: downloading ${ARMORY_RAW_URL}`);

    let response: Response;
    try {
      response = await this.rt.fetch(ARMORY_RAW_URL, {
        headers: { "user-agent": "Armory self-update" },
      });
    } catch (err) {
      this.fail(`Failed to download update: ${String(err)}`);
    }
    if (!response.ok) {
      this.fail(
        `Failed to download update: HTTP ${response.status} ${response.statusText}`,
      );
    }

    let source: string;
    try {
      source = await response.text();
    } catch (err) {
      this.fail(`Failed to read update response: ${String(err)}`);
    }
    if (
      !source.startsWith("#!/usr/bin/env node") ||
      !source.includes("ARMORY_RAW_URL")
    ) {
      this.fail("Downloaded file did not look like a valid Armory script.");
    }

    let existing = "";
    if (fs.existsSync(scriptPath) && fs.statSync(scriptPath).isFile()) {
      existing = fs.readFileSync(scriptPath, "utf8");
    }
    if (existing === source) {
      this.log(`update: already up to date (${scriptPath})`);
      return;
    }

    try {
      const mode = fs.statSync(scriptPath).mode;
      fs.writeFileSync(tempPath, source, { encoding: "utf8", mode });
      fs.renameSync(tempPath, scriptPath);
    } catch (err) {
      if (fs.existsSync(tempPath)) {
        fs.rmSync(tempPath, { force: true });
      }
      this.fail(`Failed to replace ${scriptPath}: ${String(err)}`);
    }

    this.log(`updated: ${scriptPath}`);
  }

  private dependencyConfigPath(repo: ResolvedRepo): string {
    return path.join(
      path.resolve(repo.cloneDir, repo.repoPath),
      "armory.json",
    );
  }

  private dependencyHop(repo: ResolvedRepo, context: ArmoryContext): DependencyHop {
    return {
      key: this.parseGitUrl(repo.url, context.armoryDir).canonicalKey,
      label: repo.url,
    };
  }

  private childContexts(
    context: ArmoryContext,
  ): Array<{ hop: DependencyHop; childContext: ArmoryContext }> {
    const children: Array<{ hop: DependencyHop; childContext: ArmoryContext }> = [];
    for (const repo of context.repos) {
      const childConfigPath = this.dependencyConfigPath(repo);
      if (!fs.existsSync(childConfigPath)) {
        continue;
      }
      const dependencyDir = path.dirname(childConfigPath);
      children.push({
        hop: this.dependencyHop(repo, context),
        childContext: this.resolveContext(
          this.loadConfig(childConfigPath),
          childConfigPath,
          dependencyDir,
        ),
      });
    }
    return children;
  }

  private preflightExistingDependencyGraph(
    context: ArmoryContext,
    ancestry: DependencyHop[],
    visitedConfigPaths: Set<string>,
  ): void {
    this.assertNoImmediateCycles(context, ancestry);

    const configKey = this.canonicalPath(context.configPath);
    if (visitedConfigPaths.has(configKey)) {
      return;
    }
    visitedConfigPaths.add(configKey);

    for (const { hop, childContext } of this.childContexts(context)) {
      this.preflightExistingDependencyGraph(
        childContext,
        [...ancestry, hop],
        visitedConfigPaths,
      );
    }
  }

  private runRecursively(
    context: ArmoryContext,
    command: DependencyCommand,
    visitedConfigPaths: Set<string>,
    ancestry: DependencyHop[],
    writeLocalArtifacts: boolean,
  ): void {
    const configKey = this.canonicalPath(context.configPath);
    if (visitedConfigPaths.has(configKey)) {
      this.log(`skip dependency (already processed): ${context.configPath}`);
      return;
    }
    visitedConfigPaths.add(configKey);

    this.assertNoImmediateCycles(context, ancestry);
    this.executeCommand(context, command);
    if (writeLocalArtifacts) {
      this.ensureLocalSetup(context);
    }

    for (const { hop, childContext } of this.childContexts(context)) {
      this.runRecursively(
        childContext,
        command,
        visitedConfigPaths,
        [...ancestry, hop],
        false,
      );
    }
  }

  private cloneAll(context: ArmoryContext): void {
    fs.mkdirSync(context.reposRootAbs, { recursive: true });
    for (const repo of this.uniqueCloneDirs(context.repos)) {
      if (fs.existsSync(path.join(repo.cloneDir, ".git"))) {
        this.log(`skip clone (exists): ${repo.cloneDir}`);
        continue;
      }
      if (fs.existsSync(repo.cloneDir)) {
        this.fail(
          `Cannot clone ${repo.url}: ${repo.cloneDir} exists but is not a git repository.`,
        );
      }
      if (repo.branch) {
        this.log(`clone ${repo.url} -> ${repo.cloneDir} (branch ${repo.branch})`);
        this.runGit([
          "clone",
          "--branch",
          repo.branch,
          "--single-branch",
          "--",
          repo.url,
          repo.cloneDir,
        ]);
      } else {
        this.log(`clone ${repo.url} -> ${repo.cloneDir} (default branch)`);
        this.runGit(["clone", "--", repo.url, repo.cloneDir]);
      }
    }
  }

  private fetchAll(context: ArmoryContext): void {
    for (const repo of this.uniqueCloneDirs(context.repos)) {
      this.ensureGitRepo(repo);
      this.log(`fetch: ${repo.cloneDir}`);
      this.runGit(["fetch", "--all", "--prune"], repo.cloneDir, true);
    }
  }

  private pullAll(context: ArmoryContext): void {
    for (const repo of this.uniqueCloneDirs(context.repos)) {
      this.ensureGitRepo(repo);
      this.log(`pull: ${repo.cloneDir}`);
      this.runGit(["pull", "--ff-only"], repo.cloneDir, true);
    }
  }

  private reportOperationFailures(): void {
    if (this.operationFailures.length === 0) {
      return;
    }
    const lines = this.operationFailures.map((entry) => `  - ${entry}`);
    this.fail(
      `Git operations failed in ${this.operationFailures.length} repositor(ies):\n${lines.join("\n")}`,
    );
  }

  private recordOperationFailure(cwd: string, message: string): void {
    this.operationFailures.push(`${cwd}: ${message}`);
  }

  private GITIGNORE_MANAGED_START = "# >>> armory (managed)";
  private GITIGNORE_MANAGED_END = "# <<< armory (managed)";

  private ensureLocalSetup(context: ArmoryContext): void {
    this.writeWorkspace(context);
    this.ensureGitignore(context);
  }

  private findGitRoot(startDir: string): string | undefined {
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

  private isPathInGitWorkTree(targetAbs: string, gitRoot: string): boolean {
    const relative = path.relative(gitRoot, path.resolve(targetAbs));
    if (relative === "") {
      return true;
    }
    if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
      return false;
    }
    return !path.isAbsolute(relative);
  }

  private collectGitignoreUpdates(context: ArmoryContext): Array<{
    gitignorePath: string;
    lines: string[];
  }> {
    const gitRoot = this.findGitRoot(context.armoryDir);
    if (!gitRoot) {
      return [];
    }

    const byPath = new Map<string, Set<string>>();

    const addLines = (gitignorePath: string, lines: string[]): void => {
      const gitignoreDir = path.dirname(gitignorePath);
      if (!this.isPathInGitWorkTree(gitignoreDir, gitRoot)) {
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

    if (this.isPathInGitWorkTree(context.armoryDir, gitRoot)) {
      addLines(path.join(context.armoryDir, ".gitignore"), [
        "armory.ts",
        "*.armory.code-workspace",
      ]);
    }

    for (const update of this.reposRootGitignoreUpdates(gitRoot, context)) {
      addLines(update.gitignorePath, update.lines);
    }

    return [...byPath.entries()].map(([gitignorePath, lines]) => ({
      gitignorePath,
      lines: [...lines],
    }));
  }

  private reposRootGitignoreUpdates(
    gitRoot: string,
    context: ArmoryContext,
  ): Array<{ gitignorePath: string; lines: string[] }> {
    const reposRootAbs = path.resolve(context.reposRootAbs);
    if (!this.isPathInGitWorkTree(reposRootAbs, gitRoot)) {
      return [];
    }

    const gitignoreDir = path.dirname(reposRootAbs);
    if (this.isPathInGitWorkTree(gitignoreDir, gitRoot)) {
      const entry = this.toPosixRelative(gitignoreDir, reposRootAbs);
      if (entry !== "" && entry !== ".") {
        return [
          {
            gitignorePath: path.join(gitignoreDir, ".gitignore"),
            lines: [`${entry}/`],
          },
        ];
      }
    }

    const entryFromGitRoot = this.toPosixRelative(gitRoot, reposRootAbs);
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
      if (!this.isPathInGitWorkTree(repo.cloneDir, gitRoot)) {
        continue;
      }
      const rel = this.toPosixRelative(gitRoot, repo.cloneDir);
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

  private mergeManagedGitignoreBlock(
    existing: string,
    managedLines: string[],
  ): string {
    const blockBody = managedLines.join("\n");
    const block = `${this.GITIGNORE_MANAGED_START}\n${blockBody}\n${this.GITIGNORE_MANAGED_END}`;
    const blockPattern = new RegExp(
      `${this.escapeRegExp(this.GITIGNORE_MANAGED_START)}[\\s\\S]*?${this.escapeRegExp(this.GITIGNORE_MANAGED_END)}\\n?`,
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

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private ensureGitignore(context: ArmoryContext): void {
    for (const update of this.collectGitignoreUpdates(context)) {
      const existing = fs.existsSync(update.gitignorePath)
        ? fs.readFileSync(update.gitignorePath, "utf8")
        : "";
      const managedLines = [...new Set(update.lines)];
      const next = this.mergeManagedGitignoreBlock(existing, managedLines);
      if (next === existing) {
        continue;
      }
      fs.mkdirSync(path.dirname(update.gitignorePath), { recursive: true });
      fs.writeFileSync(update.gitignorePath, next, "utf8");
      this.log(`gitignore: ${update.gitignorePath}`);
    }
  }

  private readonly ARMORY_TASK_LABELS = [
    "Armory: clone",
    "Armory: fetch",
    "Armory: pull",
    "Armory: sync",
    "Armory: update",
  ] as const;

  private armoryTaskCwd(context: ArmoryContext): string | undefined {
    if (context.config.excludeLocalDir) {
      return undefined;
    }
    const name = path.basename(context.armoryDir) || context.armoryDir;
    return `\${workspaceFolder:${name}}`;
  }

  private buildArmoryShellTask(
    label: string,
    armoryCommand: string,
    cwd: string | undefined,
  ): Record<string, unknown> {
    const task: Record<string, unknown> = {
      label,
      type: "shell",
      command: `node armory.ts ${armoryCommand}`,
      presentation: {
        reveal: "always",
        panel: "shared",
      },
    };
    if (cwd) {
      task.options = { cwd };
    }
    return task;
  }

  private buildArmoryTasksSection(context: ArmoryContext): Record<string, unknown> {
    const cwd = this.armoryTaskCwd(context);
    return {
      version: "2.0.0",
      tasks: this.ARMORY_TASK_LABELS.map((label) => {
        const command = label.replace("Armory: ", "");
        return this.buildArmoryShellTask(label, command, cwd);
      }),
    };
  }

  private mergeWorkspaceTasks(
    userTasks: unknown,
    armoryTasks: Record<string, unknown>,
  ): Record<string, unknown> {
    const armoryTaskList = Array.isArray(armoryTasks.tasks)
      ? (armoryTasks.tasks as Record<string, unknown>[])
      : [];
    const armoryLabelSet = new Set<string>(this.ARMORY_TASK_LABELS);

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

  private writeWorkspace(context: ArmoryContext): void {
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

    const tasks = context.config.skipArmoryTasks
      ? this.mergeWorkspaceTasks(userTasks, { version: "2.0.0", tasks: [] })
      : this.mergeWorkspaceTasks(userTasks, this.buildArmoryTasksSection(context));

    const document: Record<string, unknown> = {
      ...workspaceRest,
      folders: [...folders, ...extraFolders],
    };
    if (Array.isArray(tasks.tasks) && tasks.tasks.length > 0) {
      document.tasks = tasks;
    }

    const json = `${JSON.stringify(document, null, 4)}\n`;
    fs.writeFileSync(context.workspaceFilePath, json, "utf8");
    this.log(`workspace: ${context.workspaceFilePath}`);
  }

  private ensureGitRepo(repo: ResolvedRepo): void {
    if (!fs.existsSync(path.join(repo.cloneDir, ".git"))) {
      this.fail(
        `Repository not cloned: ${repo.cloneDir}. Run "node armory.ts clone" first.`,
      );
    }
  }

  private runGit(args: string[], cwd?: string, continueOnError = false): void {
    const result = this.rt.spawnSync("git", args, {
      cwd,
      stdio: "inherit",
    });
    if (result.error) {
      const message = `git failed: ${result.error.message}`;
      if (continueOnError && cwd) {
        this.recordOperationFailure(cwd, message);
        return;
      }
      this.fail(message);
    }
    if (result.status !== 0) {
      const message = `git ${args.join(" ")} exited with code ${result.status ?? "unknown"}`;
      if (continueOnError && cwd) {
        this.recordOperationFailure(cwd, message);
        return;
      }
      this.fail(message);
    }
  }

  private log(message: string): void {
    this.rt.stdout.write(`${message}\n`);
  }

  private fail(message: string): never {
    this.rt.stderr.write(`armory: ${message}\n`);
    throw new ArmoryFailure(message);
  }
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
