import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import os from "node:os";
import { PACKAGE_ROOT } from "./package-info.ts";

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => SpawnSyncReturns<string>;

/** Everything Armory touches outside the filesystem. Tests replace these. */
export type Runtime = {
  argv: string[];
  cwd: () => string;
  env: NodeJS.ProcessEnv;
  spawnSync: SpawnFn;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  homedir: () => string;
  platform: NodeJS.Platform;
  /** Where this package is installed; `update` checks it for a git checkout. */
  packageRoot: string;
  exit: (code: number) => never;
};

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

export function createDefaultRuntime(): Runtime {
  return {
    argv: process.argv,
    cwd: () => process.cwd(),
    env: process.env,
    spawnSync: spawnSync as SpawnFn,
    stdout: process.stdout,
    stderr: process.stderr,
    homedir: () => os.homedir(),
    platform: process.platform,
    packageRoot: PACKAGE_ROOT,
    exit(code: number): never {
      return process.exit(code);
    },
  };
}

export function log(rt: Runtime, message: string): void {
  rt.stdout.write(`${message}\n`);
}

export function fail(rt: Runtime, message: string): never {
  rt.stderr.write(`armory: ${message}\n`);
  throw new ArmoryFailure(message);
}
