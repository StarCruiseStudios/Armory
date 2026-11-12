import fs from "node:fs";
import path from "node:path";
import { normalizeConfig } from "./config.ts";
import { resolveContext } from "./context.ts";
import { ensureLocalSetup } from "./graph.ts";
import { fail, log, type Runtime } from "./runtime.ts";
import { readCurrentWorkspace } from "./workspace.ts";

/** Creates a starter armory.json, seeded from an existing workspace file when one is present. */
export function initConfig(rt: Runtime): void {
  const cwd = rt.cwd();
  const configPath = path.resolve(cwd, "armory.json");
  if (fs.existsSync(configPath)) {
    fail(rt, `Config already exists: ${configPath}`);
  }

  const workspaceName = path.basename(cwd) || cwd;
  const document: Record<string, unknown> = {
    workspaceName,
    repos: [],
  };
  const workspaceSettings = readCurrentWorkspace(rt, cwd);
  if (workspaceSettings && Object.keys(workspaceSettings).length > 0) {
    document.workspaceSettings = workspaceSettings;
  }

  fs.writeFileSync(configPath, `${JSON.stringify(document, null, 4)}\n`, "utf8");
  log(rt, `created: ${configPath}`);

  const config = normalizeConfig(rt, document, configPath);
  ensureLocalSetup(
    rt,
    resolveContext(rt, config, configPath, path.dirname(configPath)),
  );
}
