import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { ARMORY_RAW_URL, gitCommands, markGitRepo, run, withTemp, writeJson } from "./harness.ts";

const VALID_SCRIPT = "#!/usr/bin/env node\nconst ARMORY_RAW_URL = \"kept\";\n";

function config(repos: unknown[]): Record<string, unknown> {
  return {
    workspaceName: "demo",
    reposRoot: "./deps",
    repos,
  };
}

describe("review fixes", () => {
  it("continues pull after one repo fails and reports a summary", async () => {
    await withTemp(async (dir) => {
      writeJson(path.join(dir, "armory.json"), config([
        { url: "https://example.com/example/good.git" },
        { url: "https://example.com/example/bad.git" },
      ]));
      markGitRepo(path.join(dir, "deps", "example", "good"));
      markGitRepo(path.join(dir, "deps", "example", "bad"));

      const result = await run({
        args: ["pull"],
        cwd: dir,
        failGit: (call) =>
          call.args[0] === "pull" && call.cwd === path.join(dir, "deps", "example", "bad")
            ? { status: 1 }
            : undefined,
      });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Git operations failed in 1 repositor/);
      assert.match(result.stderr, /bad/);
      assert.deepEqual(gitCommands(result.gitCalls), ["pull", "pull"]);
    });
  });

  it("rejects urls and branches that start with '-'", async () => {
    await withTemp(async (dir) => {
      writeJson(path.join(dir, "armory.json"), config([
        { url: "-https://example.com/evil.git" },
      ]));
      const urlResult = await run({ args: ["clone"], cwd: dir });
      assert.equal(urlResult.code, 1);
      assert.match(urlResult.stderr, /url must not start with '-'/);

      writeJson(path.join(dir, "armory.json"), config([
        { url: "https://example.com/example/widget.git", branch: "-main" },
      ]));
      const branchResult = await run({ args: ["clone"], cwd: dir });
      assert.equal(branchResult.code, 1);
      assert.match(branchResult.stderr, /branch must not start with '-'/);
    });
  });

  it("rejects workspaceName values with path separators", async () => {
    await withTemp(async (dir) => {
      writeJson(path.join(dir, "armory.json"), {
        workspaceName: "bad/name",
        repos: [],
      });
      const result = await run({ args: ["clone"], cwd: dir });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /workspaceName must not contain path separators/);
    });
  });

  it("skips the update write when the downloaded script matches the current file", async () => {
    await withTemp(async (dir) => {
      const scriptPath = path.join(dir, "armory.ts");
      fs.writeFileSync(scriptPath, VALID_SCRIPT, "utf8");
      const result = await run({
        args: ["update"],
        cwd: dir,
        argv: ["node", scriptPath, "update"],
        fetch: async (url) => {
          assert.equal(String(url), ARMORY_RAW_URL);
          return new Response(VALID_SCRIPT, { status: 200, statusText: "OK" });
        },
      });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /already up to date/);
      assert.doesNotMatch(result.stdout, /updated:/);
    });
  });

  it("treats a directory named like a parent path segment as inside the git work tree", async () => {
    await withTemp(async (dir) => {
      const nested = path.join(dir, "..foo");
      fs.mkdirSync(nested, { recursive: true });
      markGitRepo(dir);
      writeJson(path.join(nested, "armory.json"), {
        workspaceName: "demo",
        reposRoot: "./deps",
        repos: [],
      });
      const result = await run({ args: ["clone"], cwd: nested });
      assert.equal(result.code, 0);
      assert.equal(fs.existsSync(path.join(nested, ".gitignore")), true);
    });
  });
});
