import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { PACKAGE_NAME } from "../src/index.ts";
import { markGitRepo, run, withTemp } from "./harness.ts";

const INSTALL_ARGS = ["install", "--global", `${PACKAGE_NAME}@latest`];
const INSTALL_LINE = `npm ${INSTALL_ARGS.join(" ")}`;

describe("update", () => {
  it("installs the latest package globally with npm and touches nothing else", async () => {
    await withTemp(async (dir) => {
      const result = await run({ args: ["update"], cwd: dir, platform: "linux" });
      assert.equal(result.code, 0);
      assert.deepEqual(result.npmCalls, [
        { command: "npm", args: INSTALL_ARGS, cwd: undefined, shell: false, stdio: "inherit" },
      ]);
      assert.equal(result.stdout, `update: ${INSTALL_LINE}\nupdated: ${PACKAGE_NAME}\n`);
      assert.equal(result.stderr, "");
      assert.deepEqual(result.gitCalls, []);
      assert.deepEqual(fs.readdirSync(dir), []);
    });
  });

  it("runs npm through a shell on Windows without passing separate arguments", async () => {
    await withTemp(async (dir) => {
      const result = await run({ args: ["update"], cwd: dir, platform: "win32" });
      assert.equal(result.code, 0);
      assert.deepEqual(result.npmCalls, [
        { command: INSTALL_LINE, args: [], cwd: undefined, shell: true, stdio: "inherit" },
      ]);
    });
  });

  it("does not need an armory.json and ignores one that is invalid", async () => {
    await withTemp(async (dir) => {
      fs.writeFileSync(path.join(dir, "armory.json"), "{ not json", "utf8");
      const result = await run({ args: ["update"], cwd: dir, platform: "linux" });
      assert.equal(result.code, 0);
      assert.equal(result.npmCalls.length, 1);
    });
  });

  it("fails when npm cannot be started or exits non-zero", async () => {
    await withTemp(async (dir) => {
      const missing = await run({
        args: ["update"],
        cwd: dir,
        platform: "linux",
        failNpm: () => ({ error: new Error("spawnSync npm ENOENT") }),
      });
      assert.equal(missing.code, 1);
      assert.match(missing.stderr, /armory: Failed to run npm: spawnSync npm ENOENT/);
      assert.doesNotMatch(missing.stdout, /updated:/);

      const failed = await run({
        args: ["update"],
        cwd: dir,
        platform: "linux",
        failNpm: () => ({ status: 243 }),
      });
      assert.equal(failed.code, 1);
      assert.ok(failed.stderr.includes(`armory: ${INSTALL_LINE} exited with code 243`));
      assert.doesNotMatch(failed.stdout, /updated:/);

      const killed = await run({
        args: ["update"],
        cwd: dir,
        platform: "linux",
        failNpm: () => ({ status: null }),
      });
      assert.equal(killed.code, 1);
      assert.match(killed.stderr, /exited with code unknown/);
    });
  });

  it("pulls and rebuilds in place when the package is a git checkout", async () => {
    await withTemp(async (dir) => {
      const checkout = path.join(dir, "Armory");
      markGitRepo(checkout);
      const project = path.join(dir, "project");
      fs.mkdirSync(project);

      const result = await run({
        args: ["update"],
        cwd: project,
        platform: "linux",
        packageRoot: checkout,
      });
      assert.equal(result.code, 0);
      assert.deepEqual(result.gitCalls, [
        { args: ["pull", "--ff-only"], cwd: checkout, stdio: "inherit" },
      ]);
      assert.deepEqual(result.npmCalls, [
        { command: "npm", args: ["install"], cwd: checkout, shell: false, stdio: "inherit" },
        { command: "npm", args: ["run", "build"], cwd: checkout, shell: false, stdio: "inherit" },
      ]);
      assert.equal(
        result.stdout,
        [
          `update: source checkout at ${checkout}`,
          "update: git pull --ff-only",
          "update: npm install",
          "update: npm run build",
          `updated: ${PACKAGE_NAME}`,
          "",
        ].join("\n"),
      );
      assert.deepEqual(fs.readdirSync(project), []);

      const windows = await run({
        args: ["update"],
        cwd: project,
        platform: "win32",
        packageRoot: checkout,
      });
      assert.deepEqual(windows.npmCalls, [
        { command: "npm install", args: [], cwd: checkout, shell: true, stdio: "inherit" },
        { command: "npm run build", args: [], cwd: checkout, shell: true, stdio: "inherit" },
      ]);
    });
  });

  it("stops a checkout update at the first failing step and never installs from the registry", async () => {
    await withTemp(async (dir) => {
      const checkout = path.join(dir, "Armory");
      markGitRepo(checkout);

      const pull = await run({
        args: ["update"],
        cwd: dir,
        platform: "linux",
        packageRoot: checkout,
        failGit: () => ({ status: 1 }),
      });
      assert.equal(pull.code, 1);
      assert.ok(pull.stderr.includes(`armory: git pull --ff-only exited with code 1 in ${checkout}`));
      assert.deepEqual(pull.npmCalls, []);

      const noGit = await run({
        args: ["update"],
        cwd: dir,
        platform: "linux",
        packageRoot: checkout,
        failGit: () => ({ error: new Error("spawnSync git ENOENT") }),
      });
      assert.match(noGit.stderr, /Failed to run git: spawnSync git ENOENT/);
      assert.deepEqual(noGit.npmCalls, []);

      const install = await run({
        args: ["update"],
        cwd: dir,
        platform: "linux",
        packageRoot: checkout,
        failNpm: (call) => (call.args[0] === "install" ? { status: 1 } : undefined),
      });
      assert.equal(install.code, 1);
      assert.ok(install.stderr.includes(`armory: npm install exited with code 1 in ${checkout}`));
      assert.deepEqual(install.npmCalls.map((call) => call.args), [["install"]]);

      const build = await run({
        args: ["update"],
        cwd: dir,
        platform: "linux",
        packageRoot: checkout,
        failNpm: (call) => (call.args[0] === "run" ? { status: 2 } : undefined),
      });
      assert.equal(build.code, 1);
      assert.ok(build.stderr.includes(`armory: npm run build exited with code 2 in ${checkout}`));
      assert.doesNotMatch(build.stdout, /updated:/);
      for (const result of [pull, noGit, install, build]) {
        assert.ok(result.npmCalls.every((call) => !call.args.includes("--global")));
      }
    });
  });

  it("rejects extra arguments instead of passing them to npm", async () => {
    await withTemp(async (dir) => {
      const result = await run({ args: ["update", "left-pad"], cwd: dir, platform: "linux" });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Unexpected extra argument: left-pad/);
      assert.deepEqual(result.npmCalls, []);
    });
  });
});
