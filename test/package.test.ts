import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { run, withTemp } from "./harness.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Manifest = {
  name: string;
  version: string;
  private?: boolean;
  type: string;
  bin: Record<string, string>;
  files: string[];
  exports: Record<string, string | Record<string, string>>;
};

const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
) as Manifest;

function runBin(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [path.join(ROOT, manifest.bin.armory), ...args], {
    cwd,
    encoding: "utf8",
    // Keep the developer's ARMORY_ROOT and home directory out of the run.
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      ARMORY_ROOT: path.join(cwd, "deps"),
      HOME: cwd,
      USERPROFILE: cwd,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// These run against dist/, which `npm test` builds first (see the pretest script).
describe("npm package", () => {
  it("is a publishable ESM package that exposes one armory bin", () => {
    assert.match(manifest.name, /^@[a-z0-9-]+\/armory$/);
    assert.match(manifest.version, /^\d+\.\d+\.\d+/);
    assert.notEqual(manifest.private, true);
    assert.equal(manifest.type, "module");
    assert.deepEqual(Object.keys(manifest.bin), ["armory"]);
    assert.deepEqual(manifest.files, ["dist"]);
  });

  it("builds a bin with a node shebang and resolvable library entry points", () => {
    const binPath = path.join(ROOT, manifest.bin.armory);
    assert.ok(fs.existsSync(binPath), `${manifest.bin.armory} is missing; run npm run build`);
    assert.match(fs.readFileSync(binPath, "utf8"), /^#!\/usr\/bin\/env node\r?\n/);

    const main = manifest.exports["."] as Record<string, string>;
    assert.ok(fs.existsSync(path.join(ROOT, main.default)));
    assert.ok(fs.existsSync(path.join(ROOT, main.types)));
  });

  it("emits no TypeScript import specifiers into dist", () => {
    const dist = path.join(ROOT, "dist");
    const emitted = fs.readdirSync(dist).filter((name) => name.endsWith(".js"));
    assert.ok(emitted.length > 1, "expected the build to emit one file per module");
    for (const name of emitted) {
      const source = fs.readFileSync(path.join(dist, name), "utf8");
      assert.doesNotMatch(source, /from\s+["']\.[^"']*\.ts["']/, `${name} imports a .ts file`);
    }
  });

  it("runs the built bin end to end", async () => {
    await withTemp(async (dir) => {
      const help = runBin(["--help"], dir);
      assert.equal(help.status, 0);
      assert.equal(help.stderr, "");
      assert.match(help.stdout, /^Usage: armory <command>/);

      const version = runBin(["--version"], dir);
      assert.equal(version.status, 0);
      assert.equal(version.stdout, `${manifest.version}\n`);

      const unknown = runBin(["rebase"], dir);
      assert.equal(unknown.status, 1);
      assert.equal(unknown.stderr, "armory: Unknown command: rebase\n");

      const init = runBin(["init"], dir);
      assert.equal(init.status, 0, init.stderr);
      assert.ok(fs.existsSync(path.join(dir, "armory.json")));
      assert.ok(fs.existsSync(path.join(dir, `${path.basename(dir)}.armory.code-workspace`)));
    });
  });

  it("prints the package version for --version without running a command", async () => {
    await withTemp(async (dir) => {
      const result = await run({ args: ["--version"], cwd: dir });
      assert.equal(result.code, 0);
      assert.equal(result.stdout, `${manifest.version}\n`);

      const withCommand = await run({ args: ["update", "--version"], cwd: dir });
      assert.equal(withCommand.code, 0);
      assert.deepEqual(withCommand.npmCalls, []);
    });
  });
});
