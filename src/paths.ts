import fs from "node:fs";
import path from "node:path";
import type { Runtime } from "./runtime.ts";

export function toPosixRelative(fromDir: string, targetPath: string): string {
  const relative = path.relative(fromDir, path.resolve(targetPath));
  const posix = relative.split(path.sep).join("/");
  return posix === "" ? "." : posix;
}

/** Absolute path usable as a map key; case-folded where the filesystem is. */
export function canonicalPath(rt: Runtime, value: string): string {
  const resolved = path.resolve(value);
  return rt.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function findGitRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
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

export function isPathInGitWorkTree(targetAbs: string, gitRoot: string): boolean {
  const relative = path.relative(gitRoot, path.resolve(targetAbs));
  if (relative === "") {
    return true;
  }
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    return false;
  }
  return !path.isAbsolute(relative);
}
