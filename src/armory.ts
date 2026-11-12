import { resolveCommand } from "./args.ts";
import { runDependencyCommand } from "./graph.ts";
import { HELP } from "./help.ts";
import { initConfig } from "./init.ts";
import { PACKAGE_VERSION } from "./package-info.ts";
import { createDefaultRuntime, fail, type Runtime } from "./runtime.ts";
import { updatePackage } from "./update.ts";

/** Runs one Armory invocation. Tests pass overrides so git and npm stay local. */
export async function runArmory(overrides?: Partial<Runtime>): Promise<void> {
  const rt: Runtime = { ...createDefaultRuntime(), ...overrides };

  const argv = rt.argv.slice(2);
  if (argv.includes("--help") || argv.length === 0) {
    rt.stdout.write(HELP);
    rt.exit(argv.length === 0 ? 1 : 0);
  }
  if (argv.includes("--version")) {
    rt.stdout.write(`${PACKAGE_VERSION}\n`);
    rt.exit(0);
  }

  const command = resolveCommand(rt, argv);
  switch (command) {
    case undefined:
      fail(rt, "Missing command. Use --help for usage.");
    case "update":
      updatePackage(rt);
      return;
    case "init":
      initConfig(rt);
      return;
    default:
      runDependencyCommand(rt, command);
  }
}
