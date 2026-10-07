import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("rejects unexpected public release assets", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "flatt-public-assets-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const version = "1.0.0-beta.1";
  const file = `flatt-${version}-win-x64.exe`;
  const body = Buffer.from("fixture, not an installer");
  await writeFile(join(dir, file), body);
  await writeFile(join(dir, `${file}.blockmap`), "fixture");
  await writeFile(join(dir, "beta.yml"), `version: ${version}\nfiles:\n  - url: ${file}\n    size: ${body.length}\n    sha512: ${createHash("sha512").update(body).digest("base64")}\n`);
  const run = () => spawnSync(process.execPath, ["scripts/verify-release.mjs", dir, version], { encoding: "utf8" });
  assert.equal(run().status, 0);
  await writeFile(join(dir, "unexpected.txt"), "must not be published");
  const rejected = run();
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Unexpected release asset/);
});
