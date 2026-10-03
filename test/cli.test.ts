import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { gitCommands, run, withTemp, writeJson } from "./harness.ts";

describe("cli", () => {
  it("prints help and exits 1 when no command is given", async () => {
    await withTemp(async (dir) => {
      const result = await run({ args: [], cwd: dir });
      assert.equal(result.code, 1);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /Usage: node armory\.ts <command>/);
      assert.match(result.stdout, /init\s+Create armory\.json/);
      assert.deepEqual(gitCommands(result.gitCalls), []);
      assert.equal(fs.existsSync(path.join(dir, "armory.json")), false);
    });
  });

  it("prints help and exits 0 for --help, including when a command is also present", async () => {
    await withTemp(async (dir) => {
      const help = await run({ args: ["--help"], cwd: dir });
      assert.equal(help.code, 0);
      assert.match(help.stdout, /sync\s+Recursively clone, then fetch, then pull/);

      const withCommand = await run({ args: ["clone", "--help"], cwd: dir });
      assert.equal(withCommand.code, 0);
      assert.match(withCommand.stdout, /Usage: node armory\.ts <command>/);
      assert.deepEqual(gitCommands(withCommand.gitCalls), []);
    });
  });

  it("rejects unknown options and unknown commands", async () => {
    await withTemp(async (dir) => {
      const option = await run({ args: ["--bogus"], cwd: dir });
      assert.equal(option.code, 1);
      assert.match(option.stderr, /armory: Unknown option: --bogus/);

      const command = await run({ args: ["rebase"], cwd: dir });
      assert.equal(command.code, 1);
      assert.match(command.stderr, /armory: Unknown command: rebase/);

      const optionBeforeCommand = await run({ args: ["--dry-run", "clone"], cwd: dir });
      assert.equal(optionBeforeCommand.code, 1);
      assert.match(optionBeforeCommand.stderr, /Unknown option: --dry-run/);
    });
  });

  it("ignores tokens that follow a recognized command", async () => {
    await withTemp(async (dir) => {
      writeJson(path.join(dir, "armory.json"), {
        workspaceName: "demo",
        reposRoot: "./deps",
        repos: [],
      });
      const result = await run({ args: ["clone", "extra"], cwd: dir });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /workspace:/);
    });
  });
});
