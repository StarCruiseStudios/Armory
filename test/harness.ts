import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArmoryExit, ArmoryFailure, runArmory } from "../armory.ts";

export const ARMORY_RAW_URL =
  "https://raw.githubusercontent.com/StarCruiseStudios/Armory/main/armory.ts";

export type GitCall = {
  args: string[];
  cwd?: string;
  stdio?: string;
};

export type FetchCall = {
  url: string;
  init?: { headers?: Record<string, string> };
};

type GitFailure = {
  status?: number | null;
  error?: Error;
};

export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
  gitCalls: GitCall[];
};

export function cloneGitUrl(args: readonly string[]): string | undefined {
  if (args[0] !== "clone") {
    return undefined;
  }
  if (args[1] === "--branch") {
    return args[4];
  }
  return args[1];
}

export type RunOptions = {
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  origin?: string | null;
  homedir?: string;
  pid?: number;
  now?: number;
  fetch?: typeof fetch;
  onClone?: (dest: string, args: string[]) => void;
  failGit?: (args: string[]) => GitFailure | undefined;
};

export async function withTemp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "armory-test-"));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 4)}\n`, "utf8");
}

export function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function markGitRepo(dir: string): void {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
}

export function gitCommands(calls: GitCall[]): string[] {
  return calls
    .filter((call) => call.args[0] !== "remote")
    .map((call) => call.args[0] ?? "");
}

export async function run(options: RunOptions): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const gitCalls: GitCall[] = [];
  let code = 0;
  const fetchImpl: typeof fetch = options.fetch ?? (async () => {
    throw new Error("network disabled in tests");
  });

  try {
    await runArmory({
      argv: options.argv ?? ["node", "armory.ts", ...options.args],
      cwd: () => options.cwd,
      env: options.env ?? {},
      homedir: () => options.homedir ?? path.join(options.cwd, ".armory-home"),
      pid: options.pid ?? 4242,
      now: () => options.now ?? 1_700_000_000_000,
      stdout: {
        write(chunk: string) {
          stdout += String(chunk);
          return true;
        },
      },
      stderr: {
        write(chunk: string) {
          stderr += String(chunk);
          return true;
        },
      },
      fetch: fetchImpl,
      spawnSync: (_command, args, spawnOptions) => {
        const recorded: GitCall = {
          args: [...args],
          cwd: typeof spawnOptions.cwd === "string" ? spawnOptions.cwd : undefined,
          stdio: typeof spawnOptions.stdio === "string" ? spawnOptions.stdio : undefined,
        };
        gitCalls.push(recorded);

        if (args[0] === "remote" && args[1] === "get-url") {
          if (!options.origin) {
            return { status: 1, stdout: "", stderr: "" } as never;
          }
          return { status: 0, stdout: `${options.origin}\n`, stderr: "" } as never;
        }

        const failure = options.failGit?.(recorded.args);
        if (failure) {
          return {
            status: failure.status ?? null,
            stdout: "",
            stderr: "",
            error: failure.error,
          } as never;
        }

        if (args[0] === "clone") {
          const dest = args[args.length - 1];
          if (dest) {
            fs.mkdirSync(path.join(dest, ".git"), { recursive: true });
            options.onClone?.(dest, recorded.args);
          }
        }

        return { status: 0, stdout: "", stderr: "" } as never;
      },
      exit: (exitCode: number): never => {
        code = exitCode;
        throw new ArmoryExit(exitCode);
      },
    });
  } catch (err) {
    if (err instanceof ArmoryExit) {
      return { code, stdout, stderr, gitCalls };
    }
    if (err instanceof ArmoryFailure) {
      return { code: 1, stdout, stderr, gitCalls };
    }
    throw err;
  }

  return { code, stdout, stderr, gitCalls };
}
