import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import {
  aggregateRelease,
  createTargetProvenance,
  releaseTargets,
} from "../scripts/aggregate-release.mjs";
import {
  validateManifestTargetCoverage,
  validateReleaseArtifacts,
} from "../scripts/release-artifacts.mjs";

import { fixture, nativeLinuxSuffixes, sha, version } from "./releaseFixture.mjs";

for (const target of releaseTargets) {
  test(`accepts original native ${target} manifest coverage`, async () => {
    const manifest = parse(
      await readFile(
        join(import.meta.dirname, "fixtures/native-release-manifests", `${target}.yml`),
        "utf8",
      ),
    );
    assert.doesNotThrow(() => validateManifestTargetCoverage(manifest, [target], manifest.version));
  });
}

test("AppImage-only Linux metadata retains all package formats in inventory", async (t) => {
  const { input, output } = await fixture(t, releaseTargets, version, { linuxAppImageOnly: true });
  const plan = await aggregateRelease(input, output, version, sha);
  const manifest = parse(await readFile(join(output, "latest-linux.yml"), "utf8"));
  assert.equal(manifest.files.length, 1);
  for (const suffix of nativeLinuxSuffixes.x64)
    assert.ok(plan.files.some((file) => file.name === `flatt-${version}-linux-${suffix}`));
});

test("aggregates five targets, both mac ZIPs and every Linux installer without external AppImage blockmaps", async (t) => {
  const { input, output } = await fixture(t);
  await aggregateRelease(input, output, version, sha);
  const plan = await validateReleaseArtifacts(output, version);
  assert.equal(plan.inventory.targets.length, 5);
  const mac = parse(await readFile(join(output, "latest-mac.yml"), "utf8"));
  assert.equal(mac.files.length, 2);
  assert.equal(mac.path, mac.files[0].url);
  for (const arch of ["x64", "arm64"]) {
    for (const suffix of nativeLinuxSuffixes[arch])
      assert.ok(plan.files.some((f) => f.name === `flatt-${version}-linux-${suffix}`));
  }
  assert.ok(plan.files.some((f) => f.name === "latest-linux-arm64.yml"));
  assert.ok(plan.files.some((f) => f.name === "release-inventory.json"));
  assert.ok(plan.files.every((f) => !f.name.includes("provenance")));
});

test("missing target prevents aggregation", async (t) => {
  const { input, output } = await fixture(t, releaseTargets.slice(1));
  await assert.rejects(aggregateRelease(input, output, version, sha), /target/i);
});

test("preserves native macOS ZIP and DMG metadata for both architectures", async (t) => {
  const { input, output } = await fixture(t, releaseTargets, version, { macDmgManifest: true });
  const originals = [];
  for (const target of ["mac-x64", "mac-arm64"])
    originals.push(...parse(await readFile(join(input, target, "latest-mac.yml"), "utf8")).files);
  await aggregateRelease(input, output, version, sha);
  const mac = parse(await readFile(join(output, "latest-mac.yml"), "utf8"));
  assert.deepEqual(mac.files, originals);
  assert.equal(mac.files.length, 4);
  await validateReleaseArtifacts(output, version);
});

for (const issue of ["dmg-checksum", "dmg-only", "duplicate-dmg", "foreign-architecture"]) {
  test(`native macOS provenance rejects ${issue}`, async (t) => {
    const { input } = await fixture(t, releaseTargets, version, { macDmgManifest: true });
    const dir = join(input, "mac-arm64");
    const path = join(dir, "latest-mac.yml");
    const manifest = parse(await readFile(path, "utf8"));
    if (issue === "dmg-checksum") manifest.files[1].sha512 = "corrupt";
    if (issue === "dmg-only") manifest.files.shift();
    if (issue === "duplicate-dmg") manifest.files.push(manifest.files[1]);
    if (issue === "foreign-architecture") {
      const foreign = `flatt-${version}-mac-x64.dmg`;
      await writeFile(join(dir, foreign), "foreign installer");
      manifest.files.push({
        url: foreign,
        size: 17,
        sha512: createHash("sha512").update("foreign installer").digest("base64"),
      });
    }
    await writeFile(path, stringify(manifest));
    await assert.rejects(createTargetProvenance(dir, "mac-arm64", version, sha));
  });
}

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
  "wrong-linux-alias",
]) {
  test(`aggregation rejects ${issue} before publishing`, async (t) => {
    const { input, output } = await fixture(t);
    const dir = join(input, "linux-x64");
    const path = join(dir, "release-provenance.json");
    const provenance = JSON.parse(await readFile(path, "utf8"));
    if (issue === "hash") await writeFile(join(dir, `flatt-${version}-linux-amd64.deb`), "corrupt");
    if (issue === "source") provenance.sourceSha = "b".repeat(40);
    if (issue === "traversal") provenance.files[0].name = "../private.ts";
    if (issue === "extra") await writeFile(join(dir, "private.ts"), "source");
    if (issue === "missing-linux-format")
      provenance.files = provenance.files.filter((f) => !f.name.endsWith(".rpm"));
    if (issue === "duplicate-target") provenance.target = "linux-arm64";
    if (issue === "wrong-linux-alias")
      provenance.files.find((file) =>
        file.name.endsWith(".deb"),
      ).name = `flatt-${version}-linux-x64.deb`;
    await writeFile(path, JSON.stringify(provenance));
    await assert.rejects(
      aggregateRelease(input, output, version, sha),
      issue === "hash" ? /checksum/ : undefined,
    );
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
