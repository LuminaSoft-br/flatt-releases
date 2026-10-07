import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateReleaseArtifacts } from "../scripts/release-artifacts.mjs";

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "flatt-release-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const body = Buffer.from("fixture installer, never publish");
  const version = "1.0.0-beta.1";
  const file = `flatt-${version}-win-x64.exe`;
  await writeFile(join(dir, file), body);
  if (!options.missingBlockmap) await writeFile(join(dir, `${file}.blockmap`), "blockmap");
  const hash = createHash("sha512").update(body).digest("base64");
  await writeFile(
    join(dir, "beta.yml"),
    `version: ${options.version ?? version}\nfiles:\n  - url: ${options.url ?? file}\n    sha512: ${options.corrupt ? "incorrect" : hash}\n    size: ${body.length}\n`,
  );
  await writeFile(join(dir, "private-source.ts"), "private source must never be uploaded");
  return { dir, version, file };
}

test("validates beta and uploads only referenced artifacts, manifest and blockmap", async (t) => {
  const { dir, version, file } = await fixture(t);
  const result = await validateReleaseArtifacts(dir, version);
  assert.equal(result.prerelease, true);
  assert.deepEqual(
    result.files.map((entry) => entry.name).sort(),
    ["beta.yml", file, `${file}.blockmap`].sort(),
  );
});
for (const [reason, options] of [
  ["checksum", { corrupt: true }],
  ["missing blockmap", { missingBlockmap: true }],
  ["wrong version", { version: "2.0.0-beta.1" }],
  ["path traversal", { url: "../secret.exe" }],
  ["remote URL", { url: "https://example.com/app.exe" }],
  ["source file", { url: "private-source.ts" }],
]) {
  test(`rejects ${reason} before remote writes`, async (t) => {
    const { dir, version } = await fixture(t, options);
    await assert.rejects(validateReleaseArtifacts(dir, version));
  });
}
test("rejects unsupported prerelease channels", async (t) => {
  const { dir } = await fixture(t);
  await assert.rejects(validateReleaseArtifacts(dir, "1.0.0-preview"));
});
