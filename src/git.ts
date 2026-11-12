import fs from "node:fs";
import path from "node:path";
import { uniqueCloneDirs, type ArmoryContext, type ResolvedRepo } from "./context.ts";
import { fail, log, type Runtime } from "./runtime.ts";

/**
 * Collects per-repository failures from fetch and pull so one broken clone
 * does not stop the rest. Call `report` once the batch is done.
 */
export class OperationFailures {
  private readonly entries: string[] = [];

  record(cwd: string, message: string): void {
    this.entries.push(`${cwd}: ${message}`);
  }

  report(rt: Runtime): void {
    if (this.entries.length === 0) {
      return;
    }
    const lines = this.entries.map((entry) => `  - ${entry}`);
    fail(
      rt,
      `Git operations failed in ${this.entries.length} repositor(ies):\n${lines.join("\n")}`,
    );
  }
}

export function cloneAll(rt: Runtime, context: ArmoryContext): void {
  fs.mkdirSync(context.reposRootAbs, { recursive: true });
  for (const repo of uniqueCloneDirs(rt, context.repos)) {
    if (fs.existsSync(path.join(repo.cloneDir, ".git"))) {
      log(rt, `skip clone (exists): ${repo.cloneDir}`);
      continue;
    }
    if (fs.existsSync(repo.cloneDir)) {
      fail(
        rt,
        `Cannot clone ${repo.url}: ${repo.cloneDir} exists but is not a git repository.`,
      );
    }
    if (repo.branch) {
      log(rt, `clone ${repo.url} -> ${repo.cloneDir} (branch ${repo.branch})`);
      runGit(rt, [
        "clone",
        "--branch",
        repo.branch,
        "--single-branch",
        "--",
        repo.url,
        repo.cloneDir,
      ]);
    } else {
      log(rt, `clone ${repo.url} -> ${repo.cloneDir} (default branch)`);
      runGit(rt, ["clone", "--", repo.url, repo.cloneDir]);
    }
  }
}

export function fetchAll(
  rt: Runtime,
  context: ArmoryContext,
  failures: OperationFailures,
): void {
  for (const repo of uniqueCloneDirs(rt, context.repos)) {
    ensureGitRepo(rt, repo);
    log(rt, `fetch: ${repo.cloneDir}`);
    runGit(rt, ["fetch", "--all", "--prune"], repo.cloneDir, failures);
  }
}

export function pullAll(
  rt: Runtime,
  context: ArmoryContext,
  failures: OperationFailures,
): void {
  for (const repo of uniqueCloneDirs(rt, context.repos)) {
    ensureGitRepo(rt, repo);
    log(rt, `pull: ${repo.cloneDir}`);
    runGit(rt, ["pull", "--ff-only"], repo.cloneDir, failures);
  }
}

function ensureGitRepo(rt: Runtime, repo: ResolvedRepo): void {
  if (!fs.existsSync(path.join(repo.cloneDir, ".git"))) {
    fail(rt, `Repository not cloned: ${repo.cloneDir}. Run "armory clone" first.`);
  }
}

/** Runs git. With `failures` and a `cwd`, a failure is recorded instead of thrown. */
function runGit(
  rt: Runtime,
  args: string[],
  cwd?: string,
  failures?: OperationFailures,
): void {
  const result = rt.spawnSync("git", args, {
    cwd,
    stdio: "inherit",
  });
  let message: string | undefined;
  if (result.error) {
    message = `git failed: ${result.error.message}`;
  } else if (result.status !== 0) {
    message = `git ${args.join(" ")} exited with code ${result.status ?? "unknown"}`;
  }
  if (message === undefined) {
    return;
  }
  if (failures && cwd) {
    failures.record(cwd, message);
    return;
  }
  fail(rt, message);
}
