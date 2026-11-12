import { fail, type Runtime } from "./runtime.ts";

const COMMANDS = ["init", "clone", "fetch", "pull", "sync", "update"] as const;

export type ArmoryCommand = (typeof COMMANDS)[number];

/** Commands that walk the dependency tree described by armory.json. */
export type DependencyCommand = Exclude<ArmoryCommand, "init" | "update">;

function isCommand(token: string): token is ArmoryCommand {
  return (COMMANDS as readonly string[]).includes(token);
}

export function resolveCommand(rt: Runtime, argv: string[]): ArmoryCommand | undefined {
  let command: ArmoryCommand | undefined;
  for (const token of argv) {
    if (token.startsWith("--")) {
      fail(rt, `Unknown option: ${token}`);
    }
    if (command) {
      fail(rt, `Unexpected extra argument: ${token}`);
    }
    if (!isCommand(token)) {
      fail(rt, `Unknown command: ${token}`);
    }
    command = token;
  }
  return command;
}
