import fs from "node:fs";
import path from "node:path";
import type { ArmoryContext } from "./context.ts";
import { findGitRoot, isPathInGitWorkTree, toPosixRelative } from "./paths.ts";
import { log, type Runtime } from "./runtime.ts";

const GITIGNORE_MANAGED_START = "# >>> armory (managed)";
const GITIGNORE_MANAGED_END = "# <<< armory (managed)";

type GitignoreUpdate = {
  gitignorePath: string;
  lines: string[];
};

/** Keeps generated workspace files and in-tree clones out of the project's history. */
export function ensureGitignore(rt: Runtime, context: ArmoryContext): void {
  for (const update of collectGitignoreUpdates(context)) {
    const existing = fs.existsSync(update.gitignorePath)
      ? fs.readFileSync(update.gitignorePath, "utf8")
      : "";
    const managedLines = [...new Set(update.lines)];
    const next = mergeManagedGitignoreBlock(existing, managedLines);
    if (next === existing) {
      continue;
    }
    fs.mkdirSync(path.dirname(update.gitignorePath), { recursive: true });
    fs.writeFileSync(update.gitignorePath, next, "utf8");
    log(rt, `gitignore: ${update.gitignorePath}`);
  }
}

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
      "*.armory.code-workspace",
    ]);
  }

  for (const update of reposRootGitignoreUpdates(gitRoot, context)) {
    addLines(update.gitignorePath, update.lines);
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
  if (!isPathInGitWorkTree(reposRootAbs, gitRoot)) {
    return [];
  }

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

function mergeManagedGitignoreBlock(existing: string, managedLines: string[]): string {
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
