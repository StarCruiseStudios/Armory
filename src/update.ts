import fs from "node:fs";
import path from "node:path";
import { PACKAGE_NAME } from "./package-info.ts";
import { fail, log, type Runtime } from "./runtime.ts";

/**
 * Updates the running Armory install. A git checkout (the `npm link` case) is
 * pulled and rebuilt in place so the link keeps pointing at it. Anything else
 * is treated as a registry install and replaced through npm.
 */
export function updatePackage(rt: Runtime): void {
  const root = rt.packageRoot;
  if (fs.existsSync(path.join(root, ".git"))) {
    updateCheckout(rt, root);
  } else {
    runNpm(rt, ["install", "--global", `${PACKAGE_NAME}@latest`]);
  }
  log(rt, `updated: ${PACKAGE_NAME}`);
}

function updateCheckout(rt: Runtime, root: string): void {
  log(rt, `update: source checkout at ${root}`);

  log(rt, "update: git pull --ff-only");
  const pull = rt.spawnSync("git", ["pull", "--ff-only"], { cwd: root, stdio: "inherit" });
  if (pull.error) {
    fail(rt, `Failed to run git: ${pull.error.message}`);
  }
  if (pull.status !== 0) {
    fail(rt, `git pull --ff-only exited with code ${pull.status ?? "unknown"} in ${root}`);
  }

  runNpm(rt, ["install"], root);
  runNpm(rt, ["run", "build"], root);
}

function runNpm(rt: Runtime, args: string[], cwd?: string): void {
  const commandLine = `npm ${args.join(" ")}`;
  log(rt, `update: ${commandLine}`);

  // On Windows npm is a .cmd shim, which Node only runs through a shell. The
  // command line is built from constants, so nothing in it needs escaping.
  const result = rt.platform === "win32"
    ? rt.spawnSync(commandLine, [], { cwd, stdio: "inherit", shell: true })
    : rt.spawnSync("npm", args, { cwd, stdio: "inherit" });

  const where = cwd ? ` in ${cwd}` : "";
  if (result.error) {
    fail(rt, `Failed to run npm: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(rt, `${commandLine} exited with code ${result.status ?? "unknown"}${where}`);
  }
}
