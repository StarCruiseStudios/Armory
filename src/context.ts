import path from "node:path";
import type { ArmoryConfig } from "./config.ts";
import {
  cloneRelativePathFromParsed,
  cloneRelativePathWithBranch,
  parseGitUrl,
} from "./git-url.ts";
import { canonicalPath, toPosixRelative } from "./paths.ts";
import { fail, type Runtime } from "./runtime.ts";

export type ResolvedRepo = {
  url: string;
  branch?: string;
  repoPath: string;
  cloneDir: string;
  workspaceFolderPath: string;
  displayName: string;
};

/** One armory.json with every path it implies resolved to an absolute location. */
export type ArmoryContext = {
  configPath: string;
  armoryDir: string;
  config: ArmoryConfig;
  reposRootAbs: string;
  workspaceFilePath: string;
  repos: ResolvedRepo[];
};

export function resolveContext(
  rt: Runtime,
  config: ArmoryConfig,
  configPath: string,
  armoryDir: string,
): ArmoryContext {
  const reposRootRaw = config.reposRoot ?? defaultReposRoot(rt);
  const reposRootAbs = path.resolve(armoryDir, reposRootRaw);
  const workspaceFilePath = path.join(
    armoryDir,
    `${config.workspaceName}.armory.code-workspace`,
  );

  const cloneSlots = new Map<string, string>();
  const cloneRelativeOwners = new Map<string, string>();

  const repos = config.repos.map((repo) => {
    const repoPathInside = normalizeRepoPath(repo.repoPath ?? "./");
    const parsed = parseGitUrl(rt, repo.url, armoryDir);
    const cloneKey = `${parsed.canonicalKey}\0${repo.branch ?? ""}`;
    const cloneRelative = cloneRelativePathWithBranch(
      cloneRelativePathFromParsed(rt, parsed, repo.url),
      repo.branch,
    );

    let cloneDir: string;
    const existingDir = cloneSlots.get(cloneKey);
    if (existingDir) {
      cloneDir = existingDir;
    } else {
      const ownerKey = cloneRelativeOwners.get(cloneRelative);
      if (ownerKey !== undefined && ownerKey !== cloneKey) {
        fail(
          rt,
          `Cannot clone ${repo.url}: ${path.join(reposRootAbs, ...cloneRelative.split("/"))} ` +
          "is already used by another repository with the same branch treatment.",
        );
      }
      cloneDir = path.join(reposRootAbs, ...cloneRelative.split("/"));
      cloneSlots.set(cloneKey, cloneDir);
      cloneRelativeOwners.set(cloneRelative, cloneKey);
    }

    const workspaceTarget = path.resolve(cloneDir, repoPathInside);
    const workspaceFolderPath = toPosixRelative(
      path.dirname(workspaceFilePath),
      workspaceTarget,
    );

    return {
      url: repo.url,
      branch: repo.branch,
      repoPath: repoPathInside,
      cloneDir,
      workspaceFolderPath,
      displayName: workspaceDisplayName(cloneRelative, repoPathInside),
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

/** Repos that share a clone directory collapse to the first one listed. */
export function uniqueCloneDirs(rt: Runtime, repos: ResolvedRepo[]): ResolvedRepo[] {
  const seen = new Set<string>();
  const unique: ResolvedRepo[] = [];
  for (const repo of repos) {
    const key = canonicalPath(rt, repo.cloneDir);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(repo);
  }
  return unique;
}

function defaultReposRoot(rt: Runtime): string {
  const fromEnv = rt.env.ARMORY_ROOT;
  if (fromEnv === undefined) {
    return path.join(rt.homedir(), "armory");
  }
  if (fromEnv.trim() === "") {
    fail(rt, "Invalid ARMORY_ROOT: must be a non-empty string.");
  }
  return fromEnv;
}

function workspaceDisplayName(cloneRelative: string, repoPathInside: string): string {
  if (repoPathInside === ".") {
    return cloneRelative;
  }
  return `${cloneRelative}/${repoPathInside}`;
}

function normalizeRepoPath(repoPath: string): string {
  const normalized = repoPath.replace(/\\/g, "/");
  if (normalized === "." || normalized === "./") {
    return ".";
  }
  return normalized.replace(/^\.\//, "");
}
