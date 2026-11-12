import fs from "node:fs";
import path from "node:path";
import type { DependencyCommand } from "./args.ts";
import { loadConfig } from "./config.ts";
import { resolveContext, type ArmoryContext, type ResolvedRepo } from "./context.ts";
import { cloneAll, fetchAll, OperationFailures, pullAll } from "./git.ts";
import { parseGitUrl } from "./git-url.ts";
import { ensureGitignore } from "./gitignore.ts";
import { canonicalPath, findGitRoot } from "./paths.ts";
import { fail, log, type Runtime } from "./runtime.ts";
import { writeWorkspace } from "./workspace.ts";

type DependencyHop = {
  key: string;
  label: string;
};

/** Runs a dependency command on the armory.json in the current directory and everything below it. */
export function runDependencyCommand(rt: Runtime, command: DependencyCommand): void {
  const configPath = path.resolve(rt.cwd(), "armory.json");
  const config = loadConfig(rt, configPath);
  const armoryDir = path.dirname(configPath);
  const context = resolveContext(rt, config, configPath, armoryDir);
  const rootDependency = resolveCurrentRepositoryDependency(rt, context);
  const ancestry = rootDependency ? [rootDependency] : [];
  preflightExistingDependencyGraph(rt, context, ancestry, new Set<string>());
  runRecursively(rt, context, command, new Set<string>(), ancestry, true);
}

/** Writes the files Armory owns beside armory.json: the workspace and the managed .gitignore block. */
export function ensureLocalSetup(rt: Runtime, context: ArmoryContext): void {
  writeWorkspace(rt, context);
  ensureGitignore(rt, context);
}

function resolveCurrentRepositoryDependency(
  rt: Runtime,
  context: ArmoryContext,
): DependencyHop | undefined {
  const gitRoot = findGitRoot(context.armoryDir);
  if (!gitRoot) {
    return undefined;
  }

  const result = rt.spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: gitRoot,
    encoding: "utf8",
  });
  const origin = result.status === 0 ? result.stdout.trim() : "";
  if (!origin) {
    return undefined;
  }
  const parsed = parseGitUrl(rt, origin, gitRoot);
  return {
    key: parsed.canonicalKey,
    label: origin,
  };
}

function assertNoImmediateCycles(
  rt: Runtime,
  context: ArmoryContext,
  ancestry: DependencyHop[],
): void {
  const ancestorKeys = new Set(ancestry.map((hop) => hop.key));
  for (const repo of context.repos) {
    const key = parseGitUrl(rt, repo.url, context.armoryDir).canonicalKey;
    if (!ancestorKeys.has(key)) {
      continue;
    }
    const chain = [...ancestry.map((hop) => hop.label), repo.url].join("\n    -> ");
    fail(
      rt,
      `Cyclic dependency detected in ${context.configPath}:\n    ${chain}\n` +
      "No repositories from this dependency level were cloned.",
    );
  }
}

function executeCommand(
  rt: Runtime,
  context: ArmoryContext,
  command: DependencyCommand,
): void {
  const failures = new OperationFailures();
  switch (command) {
    case "clone":
      cloneAll(rt, context);
      break;
    case "fetch":
      fetchAll(rt, context, failures);
      break;
    case "pull":
      pullAll(rt, context, failures);
      break;
    case "sync":
      cloneAll(rt, context);
      pullAll(rt, context, failures);
      break;
  }
  failures.report(rt);
}

function dependencyConfigPath(repo: ResolvedRepo): string {
  return path.join(path.resolve(repo.cloneDir, repo.repoPath), "armory.json");
}

function childContexts(
  rt: Runtime,
  context: ArmoryContext,
): Array<{ hop: DependencyHop; childContext: ArmoryContext }> {
  const children: Array<{ hop: DependencyHop; childContext: ArmoryContext }> = [];
  for (const repo of context.repos) {
    const childConfigPath = dependencyConfigPath(repo);
    if (!fs.existsSync(childConfigPath)) {
      continue;
    }
    children.push({
      hop: {
        key: parseGitUrl(rt, repo.url, context.armoryDir).canonicalKey,
        label: repo.url,
      },
      childContext: resolveContext(
        rt,
        loadConfig(rt, childConfigPath),
        childConfigPath,
        path.dirname(childConfigPath),
      ),
    });
  }
  return children;
}

/** Rejects cycles among the dependencies already on disk before any git command runs. */
function preflightExistingDependencyGraph(
  rt: Runtime,
  context: ArmoryContext,
  ancestry: DependencyHop[],
  visitedConfigPaths: Set<string>,
): void {
  assertNoImmediateCycles(rt, context, ancestry);

  const configKey = canonicalPath(rt, context.configPath);
  if (visitedConfigPaths.has(configKey)) {
    return;
  }
  visitedConfigPaths.add(configKey);

  for (const { hop, childContext } of childContexts(rt, context)) {
    preflightExistingDependencyGraph(
      rt,
      childContext,
      [...ancestry, hop],
      visitedConfigPaths,
    );
  }
}

function runRecursively(
  rt: Runtime,
  context: ArmoryContext,
  command: DependencyCommand,
  visitedConfigPaths: Set<string>,
  ancestry: DependencyHop[],
  writeLocalArtifacts: boolean,
): void {
  const configKey = canonicalPath(rt, context.configPath);
  if (visitedConfigPaths.has(configKey)) {
    log(rt, `skip dependency (already processed): ${context.configPath}`);
    return;
  }
  visitedConfigPaths.add(configKey);

  assertNoImmediateCycles(rt, context, ancestry);
  executeCommand(rt, context, command);
  if (writeLocalArtifacts) {
    ensureLocalSetup(rt, context);
  }

  for (const { hop, childContext } of childContexts(rt, context)) {
    runRecursively(
      rt,
      childContext,
      command,
      visitedConfigPaths,
      [...ancestry, hop],
      false,
    );
  }
}
