import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArmoryExit, ArmoryFailure, runArmory } from "../src/index.ts";

export type GitCall = {
  args: string[];
  cwd?: string;
  stdio?: string;
};

export type NpmCall = {
  command: string;
  args: string[];
  cwd?: string;
  shell: boolean;
  stdio?: string;
};

type NpmFailure = {
  status?: number | null;
  error?: Error;
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
  npmCalls: NpmCall[];
};

export function cloneGitUrl(args: readonly string[]): string | undefined {
  if (args[0] !== "clone") {
    return undefined;
  }
  const separator = args.indexOf("--");
  if (separator >= 0) {
    return args[separator + 1];
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
  platform?: NodeJS.Platform;
  packageRoot?: string;
  failNpm?: (call: NpmCall) => NpmFailure | undefined;
  onClone?: (dest: string, args: string[]) => void;
  failGit?: (call: GitCall) => GitFailure | undefined;
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
  const npmCalls: NpmCall[] = [];
  let code = 0;

  try {
    await runArmory({
      argv: options.argv ?? ["node", "armory", ...options.args],
      cwd: () => options.cwd,
      env: options.env ?? {},
      homedir: () => options.homedir ?? path.join(options.cwd, ".armory-home"),
      packageRoot: options.packageRoot ?? path.join(options.cwd, ".armory-package"),
      ...(options.platform ? { platform: options.platform } : {}),
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
      spawnSync: (command, args, spawnOptions) => {
        if (command !== "git") {
          const npmCall: NpmCall = {
            command,
            args: [...args],
            cwd: typeof spawnOptions.cwd === "string" ? spawnOptions.cwd : undefined,
            shell: spawnOptions.shell === true,
            stdio: typeof spawnOptions.stdio === "string" ? spawnOptions.stdio : undefined,
          };
          npmCalls.push(npmCall);
          const npmFailure = options.failNpm?.(npmCall);
          return {
            status: npmFailure ? npmFailure.status ?? null : 0,
            stdout: "",
            stderr: "",
            error: npmFailure?.error,
          } as never;
        }

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

        const failure = options.failGit?.(recorded);
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
      return { code, stdout, stderr, gitCalls, npmCalls };
    }
    if (err instanceof ArmoryFailure) {
      return { code: 1, stdout, stderr, gitCalls, npmCalls };
    }
    throw err;
  }

  return { code, stdout, stderr, gitCalls, npmCalls };
}
