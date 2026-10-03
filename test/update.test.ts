import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { ARMORY_RAW_URL, gitCommands, run, withTemp } from "./harness.ts";

const VALID_SCRIPT = "#!/usr/bin/env node\nconst ARMORY_RAW_URL = \"kept\";\n";

describe("update", () => {
  it("replaces the running script from a local response and removes the temp file", async () => {
    await withTemp(async (dir) => {
      const scriptPath = path.join(dir, "armory.ts");
      fs.writeFileSync(scriptPath, "old script\n", "utf8");
      const fetchCalls: Array<{ url: string; headers: unknown }> = [];
      const result = await run({
        args: ["update"],
        cwd: dir,
        argv: ["node", scriptPath, "update"],
        pid: 4242,
        now: 1_700_000_000_000,
        fetch: async (url, init) => {
          fetchCalls.push({ url: String(url), headers: init?.headers });
          return new Response(VALID_SCRIPT, { status: 200, statusText: "OK" });
        },
      });
      assert.equal(result.code, 0);
      assert.deepEqual(fetchCalls, [{
        url: ARMORY_RAW_URL,
        headers: { "user-agent": "Armory self-update" },
      }]);
      assert.match(result.stdout, new RegExp(`update: downloading ${ARMORY_RAW_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(result.stdout, /updated:/);
      assert.equal(fs.readFileSync(scriptPath, "utf8"), VALID_SCRIPT);
      assert.equal(fs.existsSync(`${scriptPath}.update-4242-1700000000000`), false);
      assert.deepEqual(gitCommands(result.gitCalls), []);
      assert.equal(fs.existsSync(path.join(dir, "armory.json")), false);
    });
  });

  it("rejects a missing script path, network errors, HTTP errors, unreadable bodies, and unfamiliar payloads", async () => {
    await withTemp(async (dir) => {
      const scriptPath = path.join(dir, "armory.ts");
      fs.writeFileSync(scriptPath, "old script\n", "utf8");

      const missing = await run({
        args: ["update"],
        cwd: dir,
        argv: ["node", "", "update"],
      });
      assert.equal(missing.code, 1);
      assert.match(missing.stderr, /Could not determine the current armory\.ts path/);

      const network = await run({
        args: ["update"],
        cwd: dir,
        argv: ["node", scriptPath, "update"],
      });
      assert.match(network.stderr, /Failed to download update: Error: network disabled in tests/);
      assert.equal(fs.readFileSync(scriptPath, "utf8"), "old script\n");

      const http = await run({
        args: ["update"],
        cwd: dir,
        argv: ["node", scriptPath, "update"],
        fetch: async () => new Response("nope", { status: 503, statusText: "Service Unavailable" }),
      });
      assert.match(http.stderr, /HTTP 503 Service Unavailable/);

      const unreadable = await run({
        args: ["update"],
        cwd: dir,
        argv: ["node", scriptPath, "update"],
        fetch: async () => ({
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => {
            throw new Error("truncated");
          },
        }) as Response,
      });
      assert.match(unreadable.stderr, /Failed to read update response: Error: truncated/);

      for (const body of ["nope", "#!/usr/bin/env node\nnot armory\n", "ARMORY_RAW_URL without shebang\n"]) {
        const invalid = await run({
          args: ["update"],
          cwd: dir,
          argv: ["node", scriptPath, "update"],
          fetch: async () => new Response(body, { status: 200, statusText: "OK" }),
        });
        assert.equal(invalid.code, 1);
        assert.match(invalid.stderr, /did not look like a valid Armory script/);
        assert.equal(fs.readFileSync(scriptPath, "utf8"), "old script\n");
      }
    });
  });

  it("removes the temp file when the script cannot be replaced", async () => {
    await withTemp(async (dir) => {
      const scriptPath = path.join(dir, "armory.ts");
      fs.mkdirSync(scriptPath);
      const result = await run({
        args: ["update"],
        cwd: dir,
        argv: ["node", scriptPath, "update"],
        pid: 99,
        now: 5,
        fetch: async () => new Response(VALID_SCRIPT, { status: 200, statusText: "OK" }),
      });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Failed to replace/);
      assert.equal(fs.existsSync(`${scriptPath}.update-99-5`), false);
      assert.equal(fs.statSync(scriptPath).isDirectory(), true);
    });
  });
});
