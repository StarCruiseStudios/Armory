import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { run, withTemp, writeJson } from "./harness.ts";

async function cloneConfig(dir: string, value: unknown): Promise<{ code: number; stderr: string }> {
  writeJson(path.join(dir, "armory.json"), value);
  return run({ args: ["clone"], cwd: dir });
}

describe("config", () => {
  it("reports a missing config", async () => {
    await withTemp(async (dir) => {
      const result = await run({ args: ["fetch"], cwd: dir });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Config not found:/);
      assert.match(result.stderr, /armory\.json/);
    });
  });

  it("reports invalid JSON and non-object documents", async () => {
    await withTemp(async (dir) => {
      fs.writeFileSync(path.join(dir, "armory.json"), "{", "utf8");
      const broken = await run({ args: ["clone"], cwd: dir });
      assert.equal(broken.code, 1);
      assert.match(broken.stderr, /Failed to parse/);

      fs.writeFileSync(path.join(dir, "armory.json"), "[]", "utf8");
      const array = await run({ args: ["clone"], cwd: dir });
      assert.equal(array.code, 1);
      assert.match(array.stderr, /workspaceName is required/);

      for (const contents of ["null", "\"text\"", "true", "1"]) {
        fs.writeFileSync(path.join(dir, "armory.json"), contents, "utf8");
        const result = await run({ args: ["clone"], cwd: dir });
        assert.equal(result.code, 1, contents);
        assert.match(result.stderr, /expected an object/);
      }
    });
  });

  it("requires workspaceName and a repos array", async () => {
    await withTemp(async (dir) => {
      const missing = await cloneConfig(dir, { repos: [] });
      assert.match(missing.stderr, /workspaceName is required/);

      const repos = await cloneConfig(dir, { workspaceName: "demo", repos: {} });
      assert.match(repos.stderr, /repos must be an array/);
    });
  });

  it("defaults omitted repos to an empty list and treats null repos as empty", async () => {
    await withTemp(async (dir) => {
      const omitted = await cloneConfig(dir, { workspaceName: "demo", reposRoot: "./deps" });
      assert.equal(omitted.code, 0);

      const nulled = await cloneConfig(dir, {
        workspaceName: "demo",
        reposRoot: "./deps",
        repos: null,
      });
      assert.equal(nulled.code, 0);
    });
  });

  it("validates repo entries, urls, and field types", async () => {
    await withTemp(async (dir) => {
      const cases: Array<{ value: unknown; message: RegExp }> = [
        {
          value: { workspaceName: "demo", repos: [null] },
          message: /Invalid repos\[0\].*expected an object/,
        },
        {
          value: { workspaceName: "demo", repos: [{}] },
          message: /Invalid repos\[0\].*url is required/,
        },
        {
          value: { workspaceName: "demo", repos: [{ url: "  " }] },
          message: /url must be a non-empty string/,
        },
        {
          value: { workspaceName: "demo", repos: [{ url: "https://example.com/a.git", branch: "" }] },
          message: /branch must be a non-empty string/,
        },
        {
          value: { workspaceName: "demo", repos: [{ url: "https://example.com/a.git", repoPath: 1 }] },
          message: /repoPath must be a non-empty string/,
        },
        {
          value: { workspaceName: " ", repos: [] },
          message: /workspaceName must be a non-empty string/,
        },
        {
          value: { workspaceName: "demo", reposRoot: "", repos: [] },
          message: /reposRoot must be a non-empty string/,
        },
        {
          value: { workspaceName: "demo", excludeLocalDir: "yes", repos: [] },
          message: /excludeLocalDir must be a boolean/,
        },
        {
          value: { workspaceName: "demo", skipArmoryTasks: 1, repos: [] },
          message: /skipArmoryTasks must be a boolean/,
        },
        {
          value: { workspaceName: "demo", repos: [{ url: ".git" }], reposRoot: "./deps" },
          message: /Could not derive a directory name from git url/,
        },
      ];

      for (const entry of cases) {
        const result = await cloneConfig(dir, entry.value);
        assert.equal(result.code, 1);
        assert.match(result.stderr, entry.message);
      }
    });
  });

  it("uses ARMORY_ROOT when reposRoot is omitted and rejects an empty value", async () => {
    await withTemp(async (dir) => {
      const home = path.join(dir, "home");
      const root = path.join(dir, "from-env");
      writeJson(path.join(dir, "armory.json"), {
        workspaceName: "demo",
        repos: [{ url: "https://example.com/widget.git" }],
      });

      const created = await run({
        args: ["clone"],
        cwd: dir,
        env: { ARMORY_ROOT: root },
        homedir: home,
      });
      assert.equal(created.code, 0);
      assert.equal(fs.existsSync(path.join(root, "widget", ".git")), true);
      assert.equal(fs.existsSync(path.join(home, "armory")), false);

      const fallback = await run({
        args: ["clone"],
        cwd: dir,
        env: {},
        homedir: home,
      });
      assert.equal(fallback.code, 0);
      assert.equal(fs.existsSync(path.join(home, "armory", "widget", ".git")), true);

      const empty = await run({
        args: ["clone"],
        cwd: dir,
        env: { ARMORY_ROOT: "   " },
        homedir: home,
      });
      assert.equal(empty.code, 1);
      assert.match(empty.stderr, /Invalid ARMORY_ROOT: must be a non-empty string/);
    });
  });
});
