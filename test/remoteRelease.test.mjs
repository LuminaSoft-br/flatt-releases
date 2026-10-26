import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  stageRemoteReleaseAssets,
  validateRemoteReleaseAssets,
} from "../scripts/remote-release-assets.mjs";
import { aggregateRelease, createTargetProvenance } from "../scripts/aggregate-release.mjs";
import { validateReleaseArtifacts } from "../scripts/release-artifacts.mjs";
import { publishRelease } from "../scripts/publish-release.mjs";
import { fixture as nativeFixture, version, sha } from "./releaseFixture.mjs";

const platforms = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];

async function producer(t) {
  const root = await mkdtemp(join(tmpdir(), "flatt-remote-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "mock-cdn");
  const output = join(root, "staged");
  await mkdir(join(input, "releases", version), { recursive: true });
  for (const platform of platforms) {
    const ids = ["server-bundle", "node-runtime", "node-pty", "glm", "ripgrep"];
    if (platform.startsWith("linux-")) ids.push("bfs", "ugrep");
    const components = [];
    await mkdir(join(input, "components", platform), { recursive: true });
    for (const id of ids) {
      const data = Buffer.from(`runtime archive fixture ${platform} ${id}`);
      const artifactPath = `components/${platform}/${id}.tar.gz`;
      await writeFile(join(input, artifactPath), data);
      const mount =
        id === "server-bundle"
          ? "server"
          : id === "node-runtime"
            ? `node/${platform}`
            : id === "node-pty" || id === "glm"
              ? `${id}/${platform}`
              : `tools/${platform}/${id}`;
      components.push({
        id,
        version: "v1.0.0+fixture",
        sha256: createHash("sha256").update(data).digest("hex"),
        artifactPath,
        mount,
      });
    }
    await writeFile(
      join(input, "releases", version, `manifest-${platform}.json`),
      JSON.stringify({ schemaVersion: 1, appVersion: version, platformArch: platform, components }),
    );
  }
  return { root, input, output };
}

async function mutateManifest(f, change) {
  const path = join(f.input, "releases", version, "manifest-linux-x64.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  change(manifest);
  await writeFile(path, JSON.stringify(manifest));
}

test("remote release staging validates four platforms and emits flat hash-addressed assets", async (t) => {
  const f = await producer(t);
  await stageRemoteReleaseAssets(f.input, f.output, version);
  const names = await validateRemoteReleaseAssets(f.output, version, { required: true });
  assert.equal(names.length, 28);
  assert.deepEqual((await readdir(f.output)).sort(), [...names].sort());
  for (const platform of platforms) {
    const manifest = JSON.parse(
      await readFile(join(f.output, `manifest-${platform}.json`), "utf8"),
    );
    for (const component of manifest.components) {
      assert.equal(
        component.artifactPath,
        `flatt-remote-${platform}-${component.id}-${component.sha256}.tar.gz`,
      );
      assert.ok(!component.artifactPath.includes("/"));
    }
  }
});

for (const [label, mutate] of [
  [
    "version mismatch",
    (m) => {
      m.appVersion = "9.9.9";
    },
  ],
  [
    "platform mismatch",
    (m) => {
      m.platformArch = "darwin-x64";
    },
  ],
  [
    "missing component",
    (m) => {
      m.components.pop();
    },
  ],
  [
    "duplicate component",
    (m) => {
      m.components.push(m.components[0]);
    },
  ],
  [
    "wrong mount",
    (m) => {
      m.components[0].mount = "../server";
    },
  ],
  [
    "unsafe archive path",
    (m) => {
      m.components[0].artifactPath = "../secret.tar.gz";
    },
  ],
  [
    "wrong checksum",
    (m) => {
      m.components[0].sha256 = "0".repeat(64);
    },
  ],
]) {
  test(`remote release staging rejects ${label}`, async (t) => {
    const f = await producer(t);
    await mutateManifest(f, mutate);
    await assert.rejects(stageRemoteReleaseAssets(f.input, f.output, version));
  });
}

test("remote release staging rejects symlinked archive inputs", async (t) => {
  const f = await producer(t);
  const path = join(f.input, "components/linux-x64/server-bundle.tar.gz");
  const data = await readFile(path);
  await rm(path);
  const target = join(f.root, "private-file");
  await writeFile(target, data);
  try {
    await symlink(target, path);
  } catch (error) {
    if (error.code === "EPERM") return t.skip("Windows symlink privilege unavailable");
    throw error;
  }
  await assert.rejects(stageRemoteReleaseAssets(f.input, f.output, version));
});

test("remote release staging rejects unsafe version directories without overwriting existing assets", async (t) => {
  const f = await producer(t);
  await assert.rejects(
    stageRemoteReleaseAssets(f.input, f.output, "../1.2.3"),
    /application version/,
  );
  await stageRemoteReleaseAssets(f.input, f.output, version);
  const name = "manifest-linux-x64.json";
  const before = await readFile(join(f.output, name));
  await assert.rejects(stageRemoteReleaseAssets(f.input, f.output, version), /exist/i);
  assert.deepEqual(await readFile(join(f.output, name)), before);
});

test("remote release validation rejects partial platform sets and corrupt archives", async (t) => {
  const f = await producer(t);
  await stageRemoteReleaseAssets(f.input, f.output, version);
  const names = await validateRemoteReleaseAssets(f.output, version);
  await writeFile(
    join(
      f.output,
      names.find((name) => name.endsWith(".tar.gz")),
    ),
    "corrupt",
  );
  await assert.rejects(validateRemoteReleaseAssets(f.output, version), /checksum/i);
  await rm(join(f.output, "manifest-linux-arm64.json"));
  await assert.rejects(validateRemoteReleaseAssets(f.output, version));
});

test("new release gates reject installer-only artifacts while historical verification remains valid", async (t) => {
  const f = await nativeFixture(t);
  await assert.rejects(
    aggregateRelease(f.input, f.output, version, sha, { requireRemote: true }),
    /remote/i,
  );
  await aggregateRelease(f.input, f.output, version, sha);
  await validateReleaseArtifacts(f.output, version);
  await assert.rejects(
    publishRelease({ directory: f.output, version, check: true, requireRemoteAssets: true }),
    /remote/i,
  );
});

test("remote artifacts participate in native provenance, final inventory and publication validation", async (t) => {
  const remote = await producer(t);
  const f = await nativeFixture(t);
  const linux = join(f.input, "linux-x64");
  await stageRemoteReleaseAssets(remote.input, linux, version);
  const provenance = await createTargetProvenance(linux, "linux-x64", version, sha);
  assert.ok(provenance.files.some((file) => file.name === "manifest-linux-arm64.json"));
  await aggregateRelease(f.input, f.output, version, sha, { requireRemote: true });
  const plan = await publishRelease({
    directory: f.output,
    version,
    check: true,
    requireInventory: true,
    requireRemoteAssets: true,
  });
  assert.ok(plan.inventory.files.some((file) => file.name === "manifest-darwin-x64.json"));
  const archive = plan.files.find((file) => file.name.startsWith("flatt-remote-"));
  await writeFile(join(f.output, archive.name), "tampered");
  await assert.rejects(validateReleaseArtifacts(f.output, version), /checksum/i);
});
