import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { readJson, run, withTemp, writeJson } from "./harness.ts";

function armoryTasks(cwd: string): unknown[] {
  return ["clone", "fetch", "pull", "sync", "update"].map((command) => ({
    label: `Armory: ${command}`,
    type: "shell",
    command: `node armory.ts ${command}`,
    options: { cwd },
    presentation: { reveal: "always", panel: "shared" },
  }));
}

describe("workspace file", () => {
  it("writes folders, settings, extra folders, and armory tasks for the root config only", async () => {
    await withTemp(async (dir) => {
      writeJson(path.join(dir, "armory.json"), {
        workspaceName: "demo",
        reposRoot: "./deps",
        repos: [
          { url: "https://example.com/example/widget.git", repoPath: "./packages/app" },
          { url: "https://example.com/example/plugin.git", repoPath: "./packages/app" },
        ],
        workspaceSettings: {
          settings: { "files.eol": "\n" },
          launch: { version: "0.2.0", configurations: [] },
          folders: [{ name: "notes", path: "../notes" }],
          tasks: {
            version: "2.1.0",
            tasks: [
              null,
              "skip-me",
              { command: "echo keep" },
              { label: "Armory: clone", command: "stale" },
              { label: 12, command: "numeric" },
              { label: "Build", command: "npm run build" },
            ],
          },
        },
      });

      const result = await run({
        args: ["clone"],
        cwd: dir,
        onClone: (dest) => {
          writeJson(path.join(dest, "packages", "app", "armory.json"), {
            workspaceName: "nested",
            reposRoot: "./inner",
            repos: [],
          });
        },
      });
      assert.equal(result.code, 0);

      const workspacePath = path.join(dir, "demo.armory.code-workspace");
      const document = readJson(workspacePath) as {
        folders: Array<{ name: string; path: string }>;
        settings: unknown;
        launch: unknown;
        tasks: { version: string; tasks: Array<{ label?: string; command?: string }> };
      };
      assert.deepEqual(document.folders, [
        { name: path.basename(dir), path: "." },
        { name: "example/widget", path: "deps/example/widget/packages/app" },
        { name: "example/plugin", path: "deps/example/plugin/packages/app" },
        { name: "notes", path: "../notes" },
      ]);
      assert.deepEqual(document.settings, { "files.eol": "\n" });
      assert.deepEqual(document.launch, { version: "0.2.0", configurations: [] });
      assert.equal(document.tasks.version, "2.1.0");
      assert.deepEqual(document.tasks.tasks.slice(0, 3), [
        { command: "echo keep" },
        { label: 12, command: "numeric" },
        { label: "Build", command: "npm run build" },
      ]);
      assert.deepEqual(
        document.tasks.tasks.slice(3),
        armoryTasks(`\${workspaceFolder:${path.basename(dir)}}`),
      );
      assert.equal(
        fs.existsSync(path.join(dir, "deps", "example", "plugin", "packages", "app", "nested.armory.code-workspace")),
        false,
      );
      assert.match(fs.readFileSync(workspacePath, "utf8"), /\n$/);
    });
  });

  it("omits the local folder and points tasks at the workspace file when excludeLocalDir is set", async () => {
    await withTemp(async (dir) => {
      writeJson(path.join(dir, "armory.json"), {
        workspaceName: "demo",
        excludeLocalDir: true,
        reposRoot: "./deps",
        repos: [{ url: "https://example.com/example/widget.git" }],
      });
      fs.mkdirSync(path.join(dir, "deps", "example", "widget", ".git"), { recursive: true });
      const pulled = await run({ args: ["pull"], cwd: dir });
      assert.equal(pulled.code, 0);
      const document = readJson(path.join(dir, "demo.armory.code-workspace")) as {
        folders: unknown[];
        tasks: { tasks: Array<{ options: { cwd: string } }> };
      };
      assert.deepEqual(document.folders, [{ name: "example/widget", path: "deps/example/widget" }]);
      assert.equal(document.tasks.tasks[0]?.options.cwd, "${fileDirname:${workspaceFile}}");
    });
  });

  it("drops generated tasks when skipArmoryTasks is set, but keeps user tasks", async () => {
    await withTemp(async (dir) => {
      writeJson(path.join(dir, "armory.json"), {
        workspaceName: "demo",
        skipArmoryTasks: true,
        reposRoot: "./deps",
        repos: [],
        workspaceSettings: {
          tasks: { version: "9.9.9", tasks: [{ label: "Only mine", command: "echo hi" }] },
        },
      });
      const withUser = await run({ args: ["clone"], cwd: dir });
      assert.equal(withUser.code, 0);
      const kept = readJson(path.join(dir, "demo.armory.code-workspace")) as {
        tasks: { version: string; tasks: unknown[] };
      };
      assert.equal(kept.tasks.version, "9.9.9");
      assert.deepEqual(kept.tasks.tasks, [{ label: "Only mine", command: "echo hi" }]);

      writeJson(path.join(dir, "armory.json"), {
        workspaceName: "demo",
        skipArmoryTasks: true,
        reposRoot: "./deps",
        repos: [],
        workspaceSettings: { tasks: { version: 1, tasks: "nope" } },
      });
      const empty = await run({ args: ["clone"], cwd: dir });
      assert.equal(empty.code, 0);
      const document = readJson(path.join(dir, "demo.armory.code-workspace")) as Record<string, unknown>;
      assert.equal(document.tasks, undefined);
    });
  });

  it("ignores a non-object workspaceSettings value by treating it as empty", async () => {
    await withTemp(async (dir) => {
      writeJson(path.join(dir, "armory.json"), {
        workspaceName: "demo",
        reposRoot: "./deps",
        repos: [],
        workspaceSettings: "nope",
      });
      const result = await run({ args: ["clone"], cwd: dir });
      assert.equal(result.code, 0);
      const document = readJson(path.join(dir, "demo.armory.code-workspace")) as {
        folders: unknown[];
        tasks: { tasks: unknown[] };
      };
      assert.equal(document.folders.length, 1);
      assert.equal(document.tasks.tasks.length, 5);
    });
  });
});
