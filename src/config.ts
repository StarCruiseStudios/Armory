import fs from "node:fs";
import { fail, type Runtime } from "./runtime.ts";

export type ArmoryRepo = {
  url: string;
  branch?: string;
  repoPath?: string;
};

export type ArmoryConfig = {
  workspaceName: string;
  excludeLocalDir?: boolean;
  skipArmoryTasks?: boolean;
  reposRoot?: string;
  repos: ArmoryRepo[];
  workspaceSettings?: Record<string, unknown>;
};

export function loadConfig(rt: Runtime, configPath: string): ArmoryConfig {
  if (!fs.existsSync(configPath)) {
    fail(rt, `Config not found: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(rt, `Failed to parse ${configPath}: ${String(err)}`);
  }
  return normalizeConfig(rt, parsed, configPath);
}

export function normalizeConfig(
  rt: Runtime,
  parsed: unknown,
  configPath: string,
): ArmoryConfig {
  if (!parsed || typeof parsed !== "object") {
    fail(rt, `Invalid config in ${configPath}: expected an object.`);
  }
  const record = parsed as Record<string, unknown>;
  const workspaceName = stringField(rt, record, "workspaceName", configPath);
  if (!workspaceName) {
    fail(rt, `Invalid config in ${configPath}: workspaceName is required.`);
  }
  assertSafeWorkspaceName(rt, workspaceName, configPath);
  const repos = record.repos ?? [];
  if (!Array.isArray(repos)) {
    fail(rt, `Invalid config in ${configPath}: repos must be an array.`);
  }
  const normalizedRepos: ArmoryRepo[] = repos.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      fail(rt, `Invalid repos[${index}] in ${configPath}: expected an object.`);
    }
    const repo = entry as Record<string, unknown>;
    const url = stringField(rt, repo, "url", configPath);
    if (!url) {
      fail(rt, `Invalid repos[${index}] in ${configPath}: url is required.`);
    }
    if (url.startsWith("-")) {
      fail(rt, `Invalid repos[${index}] in ${configPath}: url must not start with '-'.`);
    }
    const branch = stringField(rt, repo, "branch", configPath);
    if (branch?.startsWith("-")) {
      fail(rt, `Invalid repos[${index}] in ${configPath}: branch must not start with '-'.`);
    }
    return {
      url,
      branch,
      repoPath: stringField(rt, repo, "repoPath", configPath) ?? "./",
    };
  });

  let workspaceSettings: Record<string, unknown> = {};
  if (record.workspaceSettings !== undefined) {
    const value = record.workspaceSettings;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(rt, `Invalid config in ${configPath}: workspaceSettings must be an object.`);
    }
    workspaceSettings = value as Record<string, unknown>;
  }

  return {
    workspaceName,
    excludeLocalDir: booleanField(rt, record, "excludeLocalDir", configPath) ?? false,
    skipArmoryTasks: booleanField(rt, record, "skipArmoryTasks", configPath) ?? false,
    reposRoot: stringField(rt, record, "reposRoot", configPath),
    repos: normalizedRepos,
    workspaceSettings,
  };
}

function assertSafeWorkspaceName(
  rt: Runtime,
  workspaceName: string,
  configPath: string,
): void {
  if (
    workspaceName.includes("/") ||
    workspaceName.includes("\\") ||
    workspaceName.includes("..")
  ) {
    fail(
      rt,
      `Invalid config in ${configPath}: workspaceName must not contain path separators or '..'.`,
    );
  }
}

function stringField(
  rt: Runtime,
  record: Record<string, unknown>,
  key: string,
  configPath: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    fail(rt, `Invalid config in ${configPath}: ${key} must be a non-empty string.`);
  }
  return value;
}

function booleanField(
  rt: Runtime,
  record: Record<string, unknown>,
  key: string,
  configPath: string,
): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    fail(rt, `Invalid config in ${configPath}: ${key} must be a boolean.`);
  }
  return value;
}
