import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { markGitRepo, run, withTemp, writeJson } from "./harness.ts";

const START = "# >>> armory (managed)";
const END = "# <<< armory (managed)";

describe("gitignore", () => {
  it("does nothing when armory.json is outside a git work tree", async () => {
    await withTemp(async (dir) => {
      writeJson(path.join(dir, "armory.json"), {
        workspaceName: "demo",
        reposRoot: "./deps",
        repos: [],
      });
      const result = await run({ args: ["clone"], cwd: dir });
      assert.equal(result.code, 0);
      assert.equal(fs.existsSync(path.join(dir, ".gitignore")), false);
      assert.doesNotMatch(result.stdout, /gitignore:/);
    });
  });

  it("writes and refreshes one managed block beside armory.json", async () => {
    await withTemp(async (dir) => {
      markGitRepo(dir);
      fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\nfile[1].txt\n\n", "utf8");
      writeJson(path.join(dir, "armory.json"), {
        workspaceName: "demo",
        reposRoot: "./deps",
        repos: [{ url: "https://example.com/widget.git" }],
      });

      const first = await run({ args: ["clone"], cwd: dir });
      assert.equal(first.code, 0);
      const expected = [
        "node_modules/",
        "file[1].txt",
        "",
        START,
        "armory.ts",
        "*.armory.code-workspace",
        "deps/",
        END,
        "",
      ].join("\n");
      assert.equal(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), expected);

      fs.writeFileSync(
        path.join(dir, ".gitignore"),
        `keep me\n${START}\nold-line\n${END}\nalso keep\n`,
        "utf8",
      );
      const second = await run({ args: ["clone"], cwd: dir });
      assert.equal(second.code, 0);
      assert.equal(
        fs.readFileSync(path.join(dir, ".gitignore"), "utf8"),
        ["keep me", START, "armory.ts", "*.armory.code-workspace", "deps/", END, "also keep", ""].join("\n"),
      );

      const third = await run({ args: ["clone"], cwd: dir });
      assert.equal(third.code, 0);
      assert.doesNotMatch(third.stdout, /gitignore:/);
    });
  });

  it("ignores a repos root outside the work tree and records one inside a nested project", async () => {
    await withTemp(async (dir) => {
      const project = path.join(dir, "app");
      fs.mkdirSync(project, { recursive: true });
      markGitRepo(dir);
      const outside = path.join(dir, "..", `armory-outside-${path.basename(dir)}`);
      fs.mkdirSync(outside, { recursive: true });
      try {
        writeJson(path.join(project, "armory.json"), {
          workspaceName: "demo",
          reposRoot: outside,
          repos: [{ url: "https://example.com/widget.git" }],
        });
        const external = await run({ args: ["clone"], cwd: project });
        assert.equal(external.code, 0);
        assert.equal(
          fs.readFileSync(path.join(project, ".gitignore"), "utf8"),
          [START, "armory.ts", "*.armory.code-workspace", END, ""].join("\n"),
        );
        assert.equal(fs.existsSync(path.join(dir, ".gitignore")), false);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  it("ignores the repos root from the git root when it lives beside the armory directory", async () => {
    await withTemp(async (dir) => {
      markGitRepo(dir);
      const project = path.join(dir, "app");
      fs.mkdirSync(project);
      writeJson(path.join(project, "armory.json"), {
        workspaceName: "demo",
        reposRoot: "../external",
        repos: [{ url: "https://example.com/widget.git" }],
      });
      const result = await run({ args: ["clone"], cwd: project });
      assert.equal(result.code, 0);
      assert.equal(
        fs.readFileSync(path.join(project, ".gitignore"), "utf8"),
        [START, "armory.ts", "*.armory.code-workspace", END, ""].join("\n"),
      );
      assert.equal(
        fs.readFileSync(path.join(dir, ".gitignore"), "utf8"),
        [START, "external/", END, ""].join("\n"),
      );
    });
  });

  it("lists clone directories when reposRoot is the git root itself", async () => {
    await withTemp(async (dir) => {
      markGitRepo(dir);
      writeJson(path.join(dir, "armory.json"), {
        workspaceName: "demo",
        reposRoot: ".",
        repos: [
          { url: "https://example.com/widget.git" },
          { url: "https://example.com/plugin.git" },
        ],
      });
      const result = await run({ args: ["clone"], cwd: dir });
      assert.equal(result.code, 0);
      assert.equal(
        fs.readFileSync(path.join(dir, ".gitignore"), "utf8"),
        [START, "armory.ts", "*.armory.code-workspace", "widget/", "plugin/", END, ""].join("\n"),
      );

      writeJson(path.join(dir, "armory.json"), {
        workspaceName: "demo",
        reposRoot: ".",
        repos: [],
      });
      fs.rmSync(path.join(dir, ".gitignore"));
      const empty = await run({ args: ["clone"], cwd: dir });
      assert.equal(empty.code, 0);
      assert.equal(
        fs.readFileSync(path.join(dir, ".gitignore"), "utf8"),
        [START, "armory.ts", "*.armory.code-workspace", END, ""].join("\n"),
      );
    });
  });

  it("updates a nested repo's gitignore without writing a nested workspace file", async () => {
    await withTemp(async (dir) => {
      writeJson(path.join(dir, "armory.json"), {
        workspaceName: "root",
        reposRoot: "./deps",
        repos: [{ url: "https://example.com/child.git" }],
      });
      const result = await run({
        args: ["clone"],
        cwd: dir,
        onClone: (dest) => {
          markGitRepo(dest);
          writeJson(path.join(dest, "armory.json"), {
            workspaceName: "child",
            reposRoot: "./vendor",
            repos: [],
          });
        },
      });
      assert.equal(result.code, 0);
      assert.equal(fs.existsSync(path.join(dir, ".gitignore")), false);
      assert.equal(
        fs.readFileSync(path.join(dir, "deps", "child", ".gitignore"), "utf8"),
        [START, "armory.ts", "*.armory.code-workspace", "vendor/", END, ""].join("\n"),
      );
      assert.equal(
        fs.existsSync(path.join(dir, "deps", "child", "child.armory.code-workspace")),
        false,
      );
    });
  });
});
