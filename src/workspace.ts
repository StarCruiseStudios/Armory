import fs from "node:fs";
import path from "node:path";
import type { ArmoryContext } from "./context.ts";
import { parseJsonc } from "./jsonc.ts";
import { fail, log, type Runtime } from "./runtime.ts";

const ARMORY_TASK_LABELS = [
  "Armory: clone",
  "Armory: fetch",
  "Armory: pull",
  "Armory: sync",
  "Armory: update",
] as const;

/** Writes `<workspaceName>.armory.code-workspace` beside armory.json. */
export function writeWorkspace(rt: Runtime, context: ArmoryContext): void {
  const folders: Array<{ name: string; path: string }> = [];

  if (!context.config.excludeLocalDir) {
    folders.push({
      name: path.basename(context.armoryDir) || context.armoryDir,
      path: ".",
    });
  }

  for (const repo of context.repos) {
    folders.push({
      name: repo.displayName,
      path: repo.workspaceFolderPath,
    });
  }

  const userWorkspace = context.config.workspaceSettings ?? {};
  const {
    folders: _extraFolders,
    tasks: userTasks,
    ...workspaceRest
  } = userWorkspace;
  const extraFolders = Array.isArray(_extraFolders) ? _extraFolders : [];

  const tasks = context.config.skipArmoryTasks
    ? mergeWorkspaceTasks(userTasks, { version: "2.0.0", tasks: [] })
    : mergeWorkspaceTasks(userTasks, buildArmoryTasksSection(context));

  const document: Record<string, unknown> = {
    ...workspaceRest,
    folders: [...folders, ...extraFolders],
  };
  if (Array.isArray(tasks.tasks) && tasks.tasks.length > 0) {
    document.tasks = tasks;
  }

  const json = `${JSON.stringify(document, null, 4)}\n`;
  fs.writeFileSync(context.workspaceFilePath, json, "utf8");
  log(rt, `workspace: ${context.workspaceFilePath}`);
}

/** Reads the workspace file already in `dir`, if there is exactly one obvious candidate. */
export function readCurrentWorkspace(
  rt: Runtime,
  dir: string,
): Record<string, unknown> | undefined {
  const workspacePath = findCurrentWorkspaceFile(rt, dir);
  if (!workspacePath) {
    return undefined;
  }

  let parsed: unknown;
  try {
    const raw = fs.readFileSync(workspacePath, "utf8").replace(/^\uFEFF/, "");
    parsed = parseJsonc(raw);
  } catch (err) {
    fail(rt, `Failed to parse ${workspacePath}: ${String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(rt, `Invalid workspace file ${workspacePath}: expected an object.`);
  }
  return parsed as Record<string, unknown>;
}

function findCurrentWorkspaceFile(rt: Runtime, dir: string): string | undefined {
  const names = fs.readdirSync(dir).filter((name) => {
    if (!name.endsWith(".code-workspace")) {
      return false;
    }
    return fs.statSync(path.join(dir, name)).isFile();
  });
  if (names.length === 0) {
    return undefined;
  }
  if (names.length === 1) {
    return path.join(dir, names[0]);
  }

  const folderName = path.basename(dir).toLowerCase();
  const preferred = [
    `${folderName}.code-workspace`,
    `${folderName}.armory.code-workspace`,
  ];
  for (const candidate of preferred) {
    const match = names.find((name) => name.toLowerCase() === candidate);
    if (match) {
      return path.join(dir, match);
    }
  }

  fail(
    rt,
    `Multiple workspace files in ${dir}: ${names.join(", ")}. ` +
    `Could not determine the current workspace.`,
  );
}

function armoryTaskCwd(context: ArmoryContext): string | undefined {
  if (context.config.excludeLocalDir) {
    return undefined;
  }
  const name = path.basename(context.armoryDir) || context.armoryDir;
  return `\${workspaceFolder:${name}}`;
}

function buildArmoryShellTask(
  label: string,
  armoryCommand: string,
  cwd: string | undefined,
): Record<string, unknown> {
  const task: Record<string, unknown> = {
    label,
    type: "shell",
    command: `armory ${armoryCommand}`,
    presentation: {
      reveal: "always",
      panel: "shared",
    },
  };
  if (cwd) {
    task.options = { cwd };
  }
  return task;
}

function buildArmoryTasksSection(context: ArmoryContext): Record<string, unknown> {
  const cwd = armoryTaskCwd(context);
  return {
    version: "2.0.0",
    tasks: ARMORY_TASK_LABELS.map((label) => {
      const command = label.replace("Armory: ", "");
      return buildArmoryShellTask(label, command, cwd);
    }),
  };
}

function mergeWorkspaceTasks(
  userTasks: unknown,
  armoryTasks: Record<string, unknown>,
): Record<string, unknown> {
  const armoryTaskList = Array.isArray(armoryTasks.tasks)
    ? (armoryTasks.tasks as Record<string, unknown>[])
    : [];
  const armoryLabelSet = new Set<string>(ARMORY_TASK_LABELS);

  let version = "2.0.0";
  const userTaskList: Record<string, unknown>[] = [];

  if (userTasks && typeof userTasks === "object") {
    const record = userTasks as Record<string, unknown>;
    if (typeof record.version === "string") {
      version = record.version;
    }
    if (Array.isArray(record.tasks)) {
      for (const task of record.tasks) {
        if (!task || typeof task !== "object") {
          continue;
        }
        const entry = task as Record<string, unknown>;
        const label = entry.label;
        if (typeof label === "string" && armoryLabelSet.has(label)) {
          continue;
        }
        userTaskList.push(entry);
      }
    }
  }

  return {
    version,
    tasks: [...userTaskList, ...armoryTaskList],
  };
}
