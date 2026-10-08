import { createHash } from "node:crypto";
import { open, readFile, readdir, lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import semver from "semver";
import { parse } from "yaml";

export const releaseTargets = ["windows-x64", "linux-x64", "linux-arm64", "mac-x64", "mac-arm64"];

function hasOnlyKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

export function releaseVersion(version) {
  if (semver.valid(version) !== version) throw new Error("Expected canonical semantic version");
  const prerelease = semver.prerelease(version);
  if (
    prerelease &&
    (prerelease.length !== 2 || prerelease[0] !== "beta" || typeof prerelease[1] !== "number")
  )
    throw new Error("Test releases must use X.Y.Z-beta.N");
  return {
    version,
    tag: `v${version}`,
    prerelease: Boolean(prerelease),
    channel: prerelease ? "beta" : "latest",
  };
}

export function assertReleaseIsNewer(releases, version) {
  if (releaseVersion(version).prerelease) return;
  for (const release of releases) {
    const prior = release.tag_name?.replace(/^v/, "");
    if (
      !release.draft &&
      !release.prerelease &&
      semver.valid(prior) &&
      !semver.prerelease(prior) &&
      !semver.gt(version, prior)
    )
      throw new Error(`Stable version ${version} must be newer than ${prior}`);
  }
}

export function targetFiles(target, version) {
  if (!releaseTargets.includes(target)) throw new Error(`Unknown target: ${target}`);
  const [os, arch] = target === "windows-x64" ? ["win", "x64"] : target.split("-");
  const prefix = `flatt-${version}-${os}-${arch}`;
  const installers =
    os === "win"
      ? [`${prefix}.exe`, `${prefix}.exe.blockmap`]
      : os === "mac"
        ? [`${prefix}.zip`, `${prefix}.zip.blockmap`, `${prefix}.dmg`]
        : ["AppImage", "deb", "rpm", "pkg.tar.zst"].map((ext) => `${prefix}.${ext}`);
  const { channel } = releaseVersion(version);
  const manifest =
    os === "win"
      ? `${channel}.yml`
      : os === "mac"
        ? `${channel}-mac.yml`
        : `${channel}-linux${arch === "arm64" ? "-arm64" : ""}.yml`;
  return {
    required: [...installers, manifest],
    optional: os === "mac" ? [`${prefix}.dmg.blockmap`] : [],
    manifest,
    installer: `${prefix}.${os === "win" ? "exe" : os === "mac" ? "zip" : "AppImage"}`,
    manifestCompanions: os === "mac" ? [`${prefix}.dmg`] : [],
  };
}

export function validateManifestTargetCoverage(manifest, targets, version) {
  const specs = targets.map((target) => targetFiles(target, version));
  const urls = manifest.files?.map((file) => file.url);
  const allowed = new Set(specs.flatMap((spec) => [spec.installer, ...spec.manifestCompanions]));
  // 实际 Electron Builder 26.8.1 同时写入 ZIP 与 DMG；必须验证全部引用，且不能让 DMG 替代升级所需的 ZIP。
  if (
    !Array.isArray(urls) ||
    new Set(urls).size !== urls.length ||
    specs.some((spec) => !urls.includes(spec.installer)) ||
    urls.some((url) => !allowed.has(url))
  )
    throw new Error("Incomplete manifest target coverage");
}

export async function checkedFile(directory, name) {
  if (
    typeof name !== "string" ||
    basename(name) !== name ||
    /[\\/:]/.test(name) ||
    name === "." ||
    name === ".."
  )
    throw new Error(`Invalid artifact path: ${String(name)}`);
  const path = join(directory, name);
  const info = await lstat(path);
  if (!info.isFile() || info.size === 0) throw new Error(`Missing or empty artifact: ${name}`);
  return { name, path, size: info.size, sha512: await fileSha512(path) };
}

export async function verifyFileList(directory, entries, allowed, required = []) {
  if (!Array.isArray(entries) || !entries.length) throw new Error("Missing artifact inventory");
  const files = new Map();
  for (const entry of entries) {
    if (
      !hasOnlyKeys(entry, ["name", "size", "sha512"]) ||
      !allowed.has(entry.name) ||
      files.has(entry.name)
    )
      throw new Error(`Invalid or duplicate inventory file: ${entry?.name}`);
    const actual = await checkedFile(directory, entry.name);
    if (entry.size !== actual.size || entry.sha512 !== actual.sha512)
      throw new Error(`Size/checksum mismatch: ${entry.name}`);
    files.set(entry.name, actual);
  }
  for (const name of required)
    if (!files.has(name)) throw new Error(`Missing required artifact: ${name}`);
  return files;
}

export async function fileSha512(path) {
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha512");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest("base64");
  } finally {
    await handle.close();
  }
}

export async function validateReleaseArtifacts(directory, version) {
  const { channel, ...release } = releaseVersion(version);
  const names = await readdir(directory);
  const manifests = names.filter((name) =>
    /^(latest|beta)(-mac|-linux(?:-arm64)?)?\.yml$/.test(name),
  );
  if (!manifests.length) throw new Error("No update manifests found");
  let inventory;
  let files = new Map();
  if (names.includes("release-inventory.json")) {
    inventory = JSON.parse(await readFile(join(directory, "release-inventory.json"), "utf8"));
    if (
      !hasOnlyKeys(inventory, ["schemaVersion", "version", "sourceSha", "targets", "files"]) ||
      inventory.schemaVersion !== 1 ||
      inventory.version !== version ||
      !/^[a-f0-9]{40}$/.test(inventory.sourceSha ?? "") ||
      !Array.isArray(inventory.targets)
    )
      throw new Error("Invalid release inventory");
    if (
      inventory.targets.length !== releaseTargets.length ||
      new Set(inventory.targets.map((t) => t.target)).size !== releaseTargets.length ||
      inventory.targets.some(
        (t) =>
          !hasOnlyKeys(t, ["target", "sourceSha"]) ||
          !releaseTargets.includes(t.target) ||
          t.sourceSha !== inventory.sourceSha,
      )
    )
      throw new Error("Incomplete or mismatched release targets");
    const required = [...new Set(releaseTargets.flatMap((t) => targetFiles(t, version).required))];
    const allowed = new Set([
      ...required,
      ...releaseTargets.flatMap((t) => targetFiles(t, version).optional),
    ]);
    files = await verifyFileList(directory, inventory.files, allowed, required);
    for (const name of names)
      if (name !== "release-inventory.json" && !files.has(name))
        throw new Error(`Unexpected release asset: ${name}`);
  }
  const add = async (name) => {
    if (files.has(name)) return files.get(name);
    const entry = await checkedFile(directory, name);
    files.set(name, entry);
    return entry;
  };
  for (const name of manifests) {
    if (!name.startsWith(channel)) throw new Error(`Mixed release channels: ${name}`);
    const manifest = parse(await readFile(join(directory, name), "utf8"));
    if (manifest?.version !== version) throw new Error(`Version mismatch: ${name}`);
    if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.packages) {
      throw new Error(`Expected full installer manifest: ${name}`);
    }
    if (inventory) {
      validateManifestTargetCoverage(
        manifest,
        releaseTargets.filter((t) => targetFiles(t, version).manifest === name),
        version,
      );
      if (
        manifest.path &&
        !manifest.files.some((f) => f.url === manifest.path && f.sha512 === manifest.sha512)
      )
        throw new Error(`Incoherent legacy manifest fields: ${name}`);
    }
    for (const file of manifest.files) {
      const filename = file.url;
      // 修复依据：公开发布只接收 manifest 引用的安装包，不能把源码或本地路径作为资产上传。
      if (
        typeof filename !== "string" ||
        basename(filename) !== filename ||
        !/^flatt-[A-Za-z0-9_.-]+\.(exe|zip|dmg|AppImage|deb|rpm|pkg\.tar\.zst)$/.test(filename) ||
        !filename.includes(`-${version}-`) ||
        filename.includes("_TEST")
      ) {
        throw new Error(`Invalid installer filename: ${String(filename)}`);
      }
      const entry = await add(filename);
      if (file.size !== entry.size || file.sha512 !== entry.sha512) {
        throw new Error(`Size/checksum mismatch: ${filename}`);
      }
      // AppImage 的差分 blockmap 内嵌于安装包；CI 的真实产物没有外部 sidecar，不能据此拒绝 Linux 发布。
      if (/\.(exe|zip)$/.test(filename)) await add(`${filename}.blockmap`);
      if (filename.endsWith(".zip")) {
        const dmg = filename.replace(/\.zip$/, ".dmg");
        if (names.includes(dmg)) {
          await add(dmg);
          if (names.includes(`${dmg}.blockmap`)) await add(`${dmg}.blockmap`);
        }
      }
    }
    await add(name);
  }
  if (inventory) await add("release-inventory.json");
  return {
    ...release,
    inventory,
    files: [...files.values()],
  };
}
