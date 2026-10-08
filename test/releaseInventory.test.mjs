import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import { aggregateRelease, releaseTargets } from "../scripts/aggregate-release.mjs";
import { validateReleaseArtifacts } from "../scripts/release-artifacts.mjs";

import { fixture, sha, version } from "./releaseFixture.mjs";

test("aggregates five targets, both mac ZIPs and every Linux installer without external AppImage blockmaps", async (t) => {
  const { input, output } = await fixture(t);
  await aggregateRelease(input, output, version, sha);
  const plan = await validateReleaseArtifacts(output, version);
  assert.equal(plan.inventory.targets.length, 5);
  const mac = parse(await readFile(join(output, "latest-mac.yml"), "utf8"));
  assert.equal(mac.files.length, 2);
  assert.equal(mac.path, mac.files[0].url);
  for (const arch of ["x64", "arm64"]) {
    for (const extension of ["AppImage", "deb", "rpm", "pkg.tar.zst"])
      assert.ok(plan.files.some((f) => f.name === `flatt-${version}-linux-${arch}.${extension}`));
  }
  assert.ok(plan.files.some((f) => f.name === "latest-linux-arm64.yml"));
  assert.ok(plan.files.some((f) => f.name === "release-inventory.json"));
  assert.ok(plan.files.every((f) => !f.name.includes("provenance")));
});

test("missing target prevents aggregation", async (t) => {
  const { input, output } = await fixture(t, releaseTargets.slice(1));
  await assert.rejects(aggregateRelease(input, output, version, sha), /target/i);
});

test("beta aggregation keeps beta manifests separate from stable", async (t) => {
  const beta = "1.2.3-beta.1";
  const { input, output } = await fixture(t, releaseTargets, beta);
  const plan = await aggregateRelease(input, output, beta, sha);
  assert.equal(plan.prerelease, true);
  assert.equal(plan.tag, `v${beta}`);
  assert.ok(plan.files.some((f) => f.name === "beta-mac.yml"));
  assert.ok(plan.files.some((f) => f.name === "beta-linux-arm64.yml"));
  assert.ok(plan.files.every((f) => !f.name.startsWith("latest")));
});

for (const issue of [
  "hash",
  "source",
  "traversal",
  "extra",
  "missing-linux-format",
  "duplicate-target",
]) {
  test(`aggregation rejects ${issue} before publishing`, async (t) => {
    const { input, output } = await fixture(t);
    const dir = join(input, "linux-x64");
    const path = join(dir, "release-provenance.json");
    const provenance = JSON.parse(await readFile(path, "utf8"));
    if (issue === "hash") await writeFile(join(dir, `flatt-${version}-linux-x64.deb`), "corrupt");
    if (issue === "source") provenance.sourceSha = "b".repeat(40);
    if (issue === "traversal") provenance.files[0].name = "../private.ts";
    if (issue === "extra") await writeFile(join(dir, "private.ts"), "source");
    if (issue === "missing-linux-format")
      provenance.files = provenance.files.filter((f) => !f.name.endsWith(".rpm"));
    if (issue === "duplicate-target") provenance.target = "linux-arm64";
    await writeFile(path, JSON.stringify(provenance));
    await assert.rejects(aggregateRelease(input, output, version, sha));
  });
}

for (const issue of [
  "hash",
  "duplicate",
  "missing-target",
  "missing-mac-arch",
  "source-file",
  "private-metadata",
]) {
  test(`public inventory validation rejects ${issue}`, async (t) => {
    const { input, output } = await fixture(t);
    await aggregateRelease(input, output, version, sha);
    const inventoryPath = join(output, "release-inventory.json");
    const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
    if (issue === "hash") inventory.files[0].sha512 = "incorrect";
    if (issue === "private-metadata") inventory.privateSource = "must not enter public assets";
    if (issue === "duplicate") inventory.files.push(inventory.files[0]);
    if (issue === "missing-target") inventory.targets.pop();
    if (issue === "source-file") inventory.files[0].name = "private.ts";
    if (issue === "missing-mac-arch") {
      const path = join(output, "latest-mac.yml");
      const manifest = parse(await readFile(path, "utf8"));
      manifest.files.pop();
      const bytes = Buffer.from(stringify(manifest));
      await writeFile(path, bytes);
      const entry = inventory.files.find((f) => f.name === "latest-mac.yml");
      entry.size = bytes.length;
      entry.sha512 = createHash("sha512").update(bytes).digest("base64");
    }
    await writeFile(inventoryPath, JSON.stringify(inventory));
    await assert.rejects(validateReleaseArtifacts(output, version));
  });
}
