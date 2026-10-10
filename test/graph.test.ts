import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { gitCommands, markGitRepo, run, withTemp, writeJson } from "./harness.ts";

describe("dependency graph", () => {
  it("rejects a direct cycle before cloning, including equivalent git urls", async () => {
    await withTemp(async (dir) => {
      markGitRepo(dir);
      writeJson(path.join(dir, "armory.json"), {
        workspaceName: "demo",
        reposRoot: "./deps",
        repos: [{ url: "git@github.com:Org/Repo.git" }],
      });
      const result = await run({
        args: ["clone"],
        cwd: dir,
        origin: "https://GitHub.com/Org/Repo.git/",
      });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Cyclic dependency detected/);
      assert.match(result.stderr, /https:\/\/GitHub.com\/Org\/Repo\.git\//);
      assert.match(result.stderr, /git@github.com:Org\/Repo\.git/);
      assert.match(result.stderr, /No repositories from this dependency level were cloned/);
      assert.deepEqual(gitCommands(result.gitCalls), []);
      assert.equal(fs.existsSync(path.join(dir, "deps")), false);
      assert.equal(fs.existsSync(path.join(dir, "deps", "Org", "Repo")), false);
      assert.equal(fs.existsSync(path.join(dir, "demo.armory.code-workspace")), false);
    });
  });

  it("does not treat differently cased repo paths as the same repository", async () => {
    await withTemp(async (dir) => {
      markGitRepo(dir);
      writeJson(path.join(dir, "armory.json"), {
        workspaceName: "demo",
        reposRoot: "./deps",
        repos: [{ url: "https://github.com/org/Repo.git" }],
      });
      const result = await run({
        args: ["clone"],
        cwd: dir,
        origin: "https://github.com/Org/Repo.git",
      });
      assert.equal(result.code, 0);
      assert.deepEqual(gitCommands(result.gitCalls), ["clone"]);
    });
  });

  it("canonicalizes ssh, scp, trailing slashes, file urls, relative paths, and unparsed urls", async () => {
    await withTemp(async (dir) => {
      const project = path.join(dir, "proj");
      const sibling = path.join(dir, "sibling");
      fs.mkdirSync(project);
      fs.mkdirSync(sibling);
      markGitRepo(project);

      const cases: Array<{ origin: string; url: string }> = [
        {
          origin: "ssh://git@github.com/Org/Repo.git",
          url: "github.com:Org/Repo",
        },
        {
          origin: "https://github.com/org/leaf.git",
          url: "https://github.com/org/leaf/",
        },
        {
          origin: path.resolve(sibling),
          url: "../sibling",
        },
        {
          origin: pathToFileURL(path.resolve(sibling)).href,
          url: path.resolve(sibling),
        },
        {
          origin: "not a url",
          url: "not a url",
        },
      ];

      for (const entry of cases) {
        writeJson(path.join(project, "armory.json"), {
          workspaceName: "demo",
          reposRoot: "./deps",
          repos: [{ url: entry.url }],
        });
        const result = await run({
          args: ["clone"],
          cwd: project,
          origin: entry.origin,
        });
        assert.equal(result.code, 1, `${entry.origin} -> ${entry.url}\n${result.stderr}`);
        assert.match(result.stderr, /Cyclic dependency detected/);
        assert.deepEqual(gitCommands(result.gitCalls), []);
      }
    });
  });

  it("rejects a cycle already present on disk before cloning anything", async () => {
    await withTemp(async (dir) => {
      markGitRepo(dir);
      const child = path.join(dir, "deps", "example", "child");
      markGitRepo(child);
      writeJson(path.join(child, "armory.json"), {
        workspaceName: "child",
        reposRoot: "./vendor",
        repos: [{ url: "https://github.com/org/root.git" }],
      });
      writeJson(path.join(dir, "armory.json"), {
        workspaceName: "root",
        reposRoot: "./deps",
        repos: [{ url: "https://example.com/example/child.git" }],
      });
      const result = await run({
        args: ["sync"],
        cwd: dir,
        origin: "https://github.com/org/root.git",
      });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Cyclic dependency detected/);
      assert.match(result.stderr, /https:\/\/example.com\/example\/child\.git/);
      assert.deepEqual(gitCommands(result.gitCalls), []);
      assert.equal(fs.existsSync(path.join(child, "vendor")), false);
    });
  });

  it("checks a newly cloned config before cloning that level", async () => {
    await withTemp(async (dir) => {
      markGitRepo(dir);
      writeJson(path.join(dir, "armory.json"), {
        workspaceName: "root",
        reposRoot: "./deps",
        repos: [{ url: "https://example.com/example/child.git" }],
      });
      const result = await run({
        args: ["clone"],
        cwd: dir,
        origin: "https://github.com/org/root.git",
        onClone: (dest) => {
          writeJson(path.join(dest, "armory.json"), {
            workspaceName: "child",
            reposRoot: "./vendor",
            repos: [{ url: "git@github.com:org/root.git" }],
          });
        },
      });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Cyclic dependency detected/);
      assert.match(result.stderr, /No repositories from this dependency level were cloned/);
      assert.deepEqual(gitCommands(result.gitCalls), ["clone"]);
      assert.equal(fs.existsSync(path.join(dir, "deps", "example", "child", "vendor", "org", "root")), false);
      assert.equal(fs.existsSync(path.join(dir, "root.armory.code-workspace")), true);
    });
  });

  it("processes a shared nested config once", async () => {
    await withTemp(async (dir) => {
      const shared = path.join(dir, "shared");
      writeJson(path.join(dir, "armory.json"), {
        workspaceName: "root",
        reposRoot: "./deps",
        repos: [
          { url: "https://example.com/example/alpha.git" },
          { url: "https://example.com/example/beta.git" },
        ],
      });
      const result = await run({
        args: ["clone"],
        cwd: dir,
        onClone: (dest, args) => {
          const url = args[4];
          if (url === "https://example.com/example/alpha.git" || url === "https://example.com/example/beta.git") {
            writeJson(path.join(dest, "armory.json"), {
              workspaceName: path.basename(dest),
              reposRoot: shared,
              repos: [{ url: "https://example.com/example/common.git" }],
            });
            return;
          }
          if (url === "https://example.com/example/common.git") {
            writeJson(path.join(dest, "armory.json"), {
              workspaceName: "common",
              reposRoot: "./more",
              repos: [{ url: "https://example.com/example/leaf.git" }],
            });
          }
        },
      });
      assert.equal(result.code, 0);
      const clones = result.gitCalls
        .filter((call) => call.args[0] === "clone")
        .map((call) => call.args[4]);
      assert.deepEqual(clones, [
        "https://example.com/example/alpha.git",
        "https://example.com/example/beta.git",
        "https://example.com/example/common.git",
        "https://example.com/example/leaf.git",
      ]);
      assert.match(result.stdout, /skip dependency \(already processed\)/);
      assert.equal(fs.existsSync(path.join(shared, "example", "common", "more", "example", "leaf", ".git")), true);
    });

  });

  it("treats a repoPath that points back at the current config as a cycle", async () => {
    await withTemp(async (dir) => {
      writeJson(path.join(dir, "armory.json"), {
        workspaceName: "root",
        reposRoot: "./deps",
        repos: [{ url: "https://example.com/example/loop.git", repoPath: "../../.." }],
      });
      const result = await run({ args: ["clone"], cwd: dir });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Cyclic dependency detected/);
      assert.deepEqual(gitCommands(result.gitCalls), []);
      assert.equal(fs.existsSync(path.join(dir, "deps", "example", "loop")), false);
    });
  });

  it("fails when an existing or newly cloned nested config is invalid", async () => {
    await withTemp(async (dir) => {
      const child = path.join(dir, "deps", "example", "child");
      fs.mkdirSync(child, { recursive: true });
      fs.writeFileSync(path.join(child, "armory.json"), "{", "utf8");
      writeJson(path.join(dir, "armory.json"), {
        workspaceName: "root",
        reposRoot: "./deps",
        repos: [{ url: "https://example.com/example/child.git" }],
      });
      const existing = await run({ args: ["clone"], cwd: dir });
      assert.equal(existing.code, 1);
      assert.match(existing.stderr, /Failed to parse/);
      assert.deepEqual(gitCommands(existing.gitCalls), []);

      fs.rmSync(child, { recursive: true, force: true });
      const created = await run({
        args: ["clone"],
        cwd: dir,
        onClone: (dest) => {
          fs.writeFileSync(path.join(dest, "armory.json"), "null\n", "utf8");
        },
      });
      assert.equal(created.code, 1);
      assert.match(created.stderr, /expected an object/);
      assert.equal(fs.existsSync(path.join(dir, "root.armory.code-workspace")), true);
    });
  });
});
