import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { gitCommands, markGitRepo, readJson, run, withTemp, writeJson } from "./harness.ts";

const GITIGNORE_START = "# >>> armory (managed)";
const GITIGNORE_END = "# <<< armory (managed)";

describe("init", () => {
  it("creates armory.json from the directory name when no workspace file exists", async () => {
    await withTemp(async (dir) => {
      const project = path.join(dir, "Widget Lab");
      fs.mkdirSync(project);
      const result = await run({ args: ["init"], cwd: project });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /created:/);
      assert.deepEqual(gitCommands(result.gitCalls), []);
      assert.deepEqual(readJson(path.join(project, "armory.json")), {
        workspaceName: "Widget Lab",
        repos: [],
      });
      assert.equal(fs.existsSync(path.join(project, ".gitignore")), false);
    });
  });

  it("writes a managed gitignore when the directory is inside a git repository", async () => {
    await withTemp(async (dir) => {
      const project = path.join(dir, "project");
      fs.mkdirSync(project);
      markGitRepo(project);
      fs.writeFileSync(path.join(project, ".gitignore"), "node_modules/\n", "utf8");
      const result = await run({
        args: ["init"],
        cwd: project,
        homedir: path.join(dir, "home"),
      });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /created:/);
      assert.match(result.stdout, /gitignore:/);
      assert.equal(
        fs.readFileSync(path.join(project, ".gitignore"), "utf8"),
        [
          "node_modules/",
          "",
          GITIGNORE_START,
          "armory.ts",
          "*.armory.code-workspace",
          GITIGNORE_END,
          "",
        ].join("\n"),
      );
    });
  });

  it("creates a gitignore from scratch when none exists in a git repository", async () => {
    await withTemp(async (dir) => {
      const project = path.join(dir, "fresh");
      fs.mkdirSync(project);
      markGitRepo(project);
      const result = await run({
        args: ["init"],
        cwd: project,
        homedir: path.join(dir, "home"),
      });
      assert.equal(result.code, 0);
      assert.equal(
        fs.readFileSync(path.join(project, ".gitignore"), "utf8"),
        [GITIGNORE_START, "armory.ts", "*.armory.code-workspace", GITIGNORE_END, ""].join("\n"),
      );
    });
  });

  it("refuses to overwrite an existing armory.json", async () => {
    await withTemp(async (dir) => {
      const configPath = path.join(dir, "armory.json");
      fs.writeFileSync(configPath, "{\"keep\":true}\n", "utf8");
      const result = await run({ args: ["init"], cwd: dir });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Config already exists:/);
      assert.equal(fs.readFileSync(configPath, "utf8"), "{\"keep\":true}\n");
    });
  });

  it("copies the only workspace file into workspaceSettings", async () => {
    await withTemp(async (dir) => {
      writeJson(path.join(dir, "notes.code-workspace"), {
        settings: { "editor.tabSize": 2 },
        folders: [{ name: "extra", path: "../extra" }],
      });
      fs.mkdirSync(path.join(dir, "skip.code-workspace"));
      const result = await run({ args: ["init"], cwd: dir });
      assert.equal(result.code, 0);
      assert.deepEqual(readJson(path.join(dir, "armory.json")), {
        workspaceName: path.basename(dir),
        repos: [],
        workspaceSettings: {
          settings: { "editor.tabSize": 2 },
          folders: [{ name: "extra", path: "../extra" }],
        },
      });
    });
  });

  it("accepts JSONC workspace files with comments and trailing commas", async () => {
    await withTemp(async (dir) => {
      const workspacePath = path.join(dir, "jsonc.code-workspace");
      fs.writeFileSync(
        workspacePath,
        `{
  // editor defaults from the old workspace
  "settings": {
    "editor.tabSize": 2,
  },
  "folders": [
    { "path": "." },
  ],
}\n`,
        "utf8",
      );
      const result = await run({ args: ["init"], cwd: dir });
      assert.equal(result.code, 0);
      assert.deepEqual(readJson(path.join(dir, "armory.json")), {
        workspaceName: path.basename(dir),
        repos: [],
        workspaceSettings: {
          settings: { "editor.tabSize": 2 },
          folders: [{ path: "." }],
        },
      });
    });
  });

  it("omits workspaceSettings when the workspace file is an empty object", async () => {
    await withTemp(async (dir) => {
      writeJson(path.join(dir, "empty.code-workspace"), {});
      const result = await run({ args: ["init"], cwd: dir });
      assert.equal(result.code, 0);
      assert.deepEqual(readJson(path.join(dir, "armory.json")), {
        workspaceName: path.basename(dir),
        repos: [],
      });
    });
  });

  it("prefers a workspace file named after the directory when several exist", async () => {
    await withTemp(async (dir) => {
      const project = path.join(dir, "Sample");
      fs.mkdirSync(project);
      writeJson(path.join(project, "other.code-workspace"), { settings: { picked: "other" } });
      writeJson(path.join(project, "Sample.code-workspace"), { settings: { picked: "named" } });
      writeJson(path.join(project, "sample.armory.code-workspace"), { settings: { picked: "armory" } });

      const named = await run({ args: ["init"], cwd: project });
      assert.equal(named.code, 0);
      assert.deepEqual(
        (readJson(path.join(project, "armory.json")) as { workspaceSettings: unknown }).workspaceSettings,
        { settings: { picked: "named" } },
      );
    });
  });

  it("falls back to the armory workspace file name when the plain name is absent", async () => {
    await withTemp(async (dir) => {
      const project = path.join(dir, "Sample");
      fs.mkdirSync(project);
      writeJson(path.join(project, "other.code-workspace"), { settings: { picked: "other" } });
      writeJson(path.join(project, "SAMPLE.armory.code-workspace"), { settings: { picked: "armory" } });
      const result = await run({ args: ["init"], cwd: project });
      assert.equal(result.code, 0);
      assert.deepEqual(
        (readJson(path.join(project, "armory.json")) as { workspaceSettings: unknown }).workspaceSettings,
        { settings: { picked: "armory" } },
      );
    });
  });

  it("fails when several workspace files exist and none match the directory name", async () => {
    await withTemp(async (dir) => {
      writeJson(path.join(dir, "a.code-workspace"), { settings: { a: 1 } });
      writeJson(path.join(dir, "b.code-workspace"), { settings: { b: 1 } });
      const result = await run({ args: ["init"], cwd: dir });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Multiple workspace files/);
      assert.match(result.stderr, /a\.code-workspace/);
      assert.match(result.stderr, /b\.code-workspace/);
      assert.equal(fs.existsSync(path.join(dir, "armory.json")), false);
    });
  });

  it("fails when the workspace file is not valid JSON or not an object", async () => {
    await withTemp(async (dir) => {
      const broken = path.join(dir, "broken");
      fs.mkdirSync(broken);
      fs.writeFileSync(path.join(broken, "broken.code-workspace"), "{", "utf8");
      const invalid = await run({ args: ["init"], cwd: broken });
      assert.equal(invalid.code, 1);
      assert.match(invalid.stderr, /Failed to parse/);

      const arrayDir = path.join(dir, "array");
      fs.mkdirSync(arrayDir);
      fs.writeFileSync(path.join(arrayDir, "array.code-workspace"), "[]\n", "utf8");
      const arrayResult = await run({ args: ["init"], cwd: arrayDir });
      assert.equal(arrayResult.code, 1);
      assert.match(arrayResult.stderr, /expected an object/);

      const textDir = path.join(dir, "text");
      fs.mkdirSync(textDir);
      fs.writeFileSync(path.join(textDir, "text.code-workspace"), "\"nope\"\n", "utf8");
      const textResult = await run({ args: ["init"], cwd: textDir });
      assert.equal(textResult.code, 1);
      assert.match(textResult.stderr, /expected an object/);
    });
  });
});
