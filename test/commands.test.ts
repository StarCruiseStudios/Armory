import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { gitCommands, markGitRepo, run, withTemp, writeJson } from "./harness.ts";

function config(repos: unknown[]): Record<string, unknown> {
  return {
    workspaceName: "demo",
    reposRoot: "./deps",
    repos,
  };
}

describe("clone, fetch, pull, and sync", () => {
  it("clones missing repos with the requested branch and skips ones that already have .git", async () => {
    await withTemp(async (dir) => {
      const existing = path.join(dir, "deps", "group", "widget");
      fs.mkdirSync(existing, { recursive: true });
      fs.writeFileSync(path.join(existing, ".git"), "gitdir: pointer\n", "utf8");
      writeJson(path.join(dir, "armory.json"), config([
        { url: "https://example.com/group/widget.git/", branch: "develop" },
        { url: "git@github.com:example/widget.git", branch: "release" },
        { url: "https://example.com/other/widget.git" },
        { url: "https://example.com/other/widget.git" },
        { url: "https://gitlab.example/group/subgroup/tool.git" },
        { url: "ssh://git@github.com/example/plugin.git", repoPath: ".\\packages\\app" },
      ]));

      const result = await run({ args: ["clone"], cwd: dir });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /skip clone \(exists\)/);
      assert.deepEqual(gitCommands(result.gitCalls), ["clone", "clone", "clone", "clone", "clone"]);

      const clones = result.gitCalls.filter((call) => call.args[0] === "clone");
      assert.deepEqual(clones[0]?.args, [
        "clone",
        "--branch",
        "release",
        "--single-branch",
        "git@github.com:example/widget.git",
        path.join(dir, "deps", "example", "widget"),
      ]);
      assert.equal(clones[0]?.cwd, undefined);
      assert.equal(clones[0]?.stdio, "inherit");
      assert.deepEqual(clones[1]?.args.slice(0, 4), ["clone", "--branch", "main", "--single-branch"]);
      assert.equal(clones[1]?.args[5], path.join(dir, "deps", "other", "widget"));
      assert.equal(clones[2]?.args[5], path.join(dir, "deps", "other", "widget-2"));
      assert.equal(clones[3]?.args[5], path.join(dir, "deps", "group", "subgroup", "tool"));
      assert.equal(clones[4]?.args[5], path.join(dir, "deps", "example", "plugin"));

      for (const folder of [
        path.join("example", "widget"),
        path.join("other", "widget"),
        path.join("other", "widget-2"),
        path.join("group", "subgroup", "tool"),
        path.join("example", "plugin"),
      ]) {
        const gitPath = path.join(dir, "deps", folder, ".git");
        assert.equal(fs.statSync(gitPath).isDirectory(), true);
        assert.deepEqual(fs.readdirSync(gitPath), []);
      }
    });
  });

  it("fails when the destination exists and is not a git repository", async () => {
    await withTemp(async (dir) => {
      fs.mkdirSync(path.join(dir, "deps", "example", "widget"), { recursive: true });
      writeJson(path.join(dir, "armory.json"), config([
        { url: "https://example.com/example/widget.git" },
      ]));
      const result = await run({ args: ["clone"], cwd: dir });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /exists but is not a git repository/);
      assert.deepEqual(gitCommands(result.gitCalls), []);
      assert.equal(fs.existsSync(path.join(dir, "demo.armory.code-workspace")), false);
    });
  });

  it("stops after a git clone failure and still leaves earlier clones in place", async () => {
    await withTemp(async (dir) => {
      writeJson(path.join(dir, "armory.json"), config([
        { url: "https://example.com/example/ok.git" },
        { url: "https://example.com/example/bad.git" },
      ]));
      const result = await run({
        args: ["clone"],
        cwd: dir,
        failGit: (args) => args.includes("https://example.com/example/bad.git")
          ? { status: 7 }
          : undefined,
      });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /git clone --branch main --single-branch https:\/\/example.com\/example\/bad\.git .* exited with code 7/);
      assert.equal(fs.existsSync(path.join(dir, "deps", "example", "ok", ".git")), true);
      assert.equal(fs.existsSync(path.join(dir, "deps", "example", "bad")), false);
      assert.equal(fs.existsSync(path.join(dir, "demo.armory.code-workspace")), false);
    });
  });

  it("reports spawn errors and a missing exit status", async () => {
    await withTemp(async (dir) => {
      writeJson(path.join(dir, "armory.json"), config([
        { url: "https://example.com/example/missing.git" },
      ]));
      const spawned = await run({
        args: ["clone"],
        cwd: dir,
        failGit: () => ({ error: new Error("spawn git ENOENT") }),
      });
      assert.match(spawned.stderr, /git failed: spawn git ENOENT/);

      const unknown = await run({
        args: ["clone"],
        cwd: dir,
        failGit: () => ({ status: null }),
      });
      assert.match(unknown.stderr, /exited with code unknown/);
    });
  });

  it("fetch and pull require an existing clone and pass the git flags through", async () => {
    await withTemp(async (dir) => {
      writeJson(path.join(dir, "armory.json"), config([
        { url: "https://example.com/example/widget.git" },
      ]));
      const missing = await run({ args: ["fetch"], cwd: dir });
      assert.equal(missing.code, 1);
      assert.match(missing.stderr, /Repository not cloned:.*Run "node armory\.ts clone" first/);

      markGitRepo(path.join(dir, "deps", "example", "widget"));
      const fetched = await run({ args: ["fetch"], cwd: dir });
      assert.equal(fetched.code, 0);
      assert.deepEqual(gitCommands(fetched.gitCalls), ["fetch"]);
      assert.deepEqual(fetched.gitCalls[0]?.args, ["fetch", "--all", "--prune"]);
      assert.equal(fetched.gitCalls[0]?.cwd, path.join(dir, "deps", "example", "widget"));

      const pulled = await run({ args: ["pull"], cwd: dir });
      assert.equal(pulled.code, 0);
      assert.deepEqual(pulled.gitCalls[0]?.args, ["pull", "--ff-only"]);
      assert.equal(pulled.gitCalls[0]?.cwd, path.join(dir, "deps", "example", "widget"));
    });
  });

  it("sync clones, then fetches, then pulls, including repos materialized by the fake clone", async () => {
    await withTemp(async (dir) => {
      writeJson(path.join(dir, "armory.json"), config([
        { url: "https://example.com/example/alpha.git", branch: "dev" },
        { url: "https://example.com/example/beta.git" },
      ]));
      const result = await run({
        args: ["sync"],
        cwd: dir,
        onClone: (dest) => {
          if (path.basename(dest) === "alpha") {
            writeJson(path.join(dest, "armory.json"), {
              workspaceName: "alpha",
              reposRoot: "./nested",
              repos: [{ url: "https://example.com/example/leaf.git" }],
            });
          }
        },
      });
      assert.equal(result.code, 0);
      assert.deepEqual(gitCommands(result.gitCalls), [
        "clone",
        "clone",
        "fetch",
        "fetch",
        "pull",
        "pull",
        "clone",
        "fetch",
        "pull",
      ]);
      assert.equal(fs.existsSync(path.join(dir, "deps", "example", "alpha", "nested", "example", "leaf", ".git")), true);
      assert.equal(
        fs.existsSync(path.join(dir, "deps", "example", "alpha", "alpha.armory.code-workspace")),
        false,
      );
    });
  });
});
