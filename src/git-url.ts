import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalPath } from "./paths.ts";
import { fail, type Runtime } from "./runtime.ts";

export type ParsedGitUrl = {
  kind: "remote" | "local";
  canonicalKey: string;
  pathSegments: string[];
};

export function parseGitUrl(rt: Runtime, url: string, baseDir: string): ParsedGitUrl {
  let value = url.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (value.toLowerCase().endsWith(".git")) {
    value = value.slice(0, -4);
  }

  if (
    value.startsWith("./") ||
    value.startsWith("../") ||
    path.isAbsolute(value)
  ) {
    const resolved = canonicalPath(rt, path.resolve(baseDir, value));
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
      const resolved = canonicalPath(rt, fileURLToPath(parsed));
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

/** Path of a clone under reposRoot, as `<owner>/<repository>` with forward slashes. */
export function cloneRelativePathFromParsed(
  rt: Runtime,
  parsed: ParsedGitUrl,
  url: string,
): string {
  const segments = parsed.pathSegments.filter((segment) => segment !== ".");
  if (parsed.kind === "remote") {
    if (segments.length < 2 || segments.some((segment) => segment === "..")) {
      fail(rt, `Could not derive an owner and repository name from git url: ${url}`);
    }
    return segments.join("/");
  }
  const segment = segments.filter((part) => part !== "..").at(-1);
  if (!segment) {
    fail(rt, `Could not derive an owner and repository name from git url: ${url}`);
  }
  return segment;
}

export function cloneRelativePathWithBranch(
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
