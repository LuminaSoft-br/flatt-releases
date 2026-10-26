import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const remotePlatforms = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];
export const remoteManifestNames = remotePlatforms.map((platform) => `manifest-${platform}.json`);

function expectedMount(platform, id) {
  if (id === "server-bundle") return "server";
  if (id === "node-runtime") return `node/${platform}`;
  if (id === "node-pty" || id === "glm") return `${id}/${platform}`;
  return `tools/${platform}/${id}`;
}

function validateManifest(manifest, platform, version) {
  const ids = ["server-bundle", "node-runtime", "node-pty", "glm", "ripgrep"];
  if (platform.startsWith("linux-")) ids.push("bfs", "ugrep");
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.appVersion !== version ||
    manifest.platformArch !== platform ||
    !Array.isArray(manifest.components) ||
    manifest.components.length !== ids.length
  ) {
    throw new Error(`Invalid remote manifest for ${platform}/${version}`);
  }
  const seen = new Set();
  for (const component of manifest.components) {
    if (
      !ids.includes(component.id) ||
      seen.has(component.id) ||
      component.mount !== expectedMount(platform, component.id) ||
      typeof component.version !== "string" ||
      !component.version ||
      component.version.length > 200 ||
      typeof component.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(component.sha256) ||
      typeof component.artifactPath !== "string"
    ) {
      throw new Error(`Invalid remote component in ${platform}`);
    }
    seen.add(component.id);
  }
}

async function regularFile(root, name) {
  if (
    !name ||
    name.includes("\\") ||
    name.includes(":") ||
    name.startsWith("/") ||
    name.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Unsafe remote artifact path");
  }
  const path = join(root, name);
  const info = await lstat(path);
  const delta = relative(await realpath(root), await realpath(path));
  if (
    !info.isFile() ||
    info.size === 0 ||
    info.size >= 2 ** 31 ||
    delta === ".." ||
    delta.startsWith(`..${sep}`) ||
    isAbsolute(delta)
  ) {
    throw new Error(`Invalid remote artifact: ${name}`);
  }
  return path;
}

async function readManifest(root, name) {
  const path = await regularFile(root, name);
  if ((await lstat(path)).size > 1024 * 1024) throw new Error("Remote manifest is too large");
  return JSON.parse(await readFile(path, "utf8"));
}

async function checkArchive(root, name, expected) {
  if (!name.endsWith(".tar.gz")) throw new Error("Expected remote runtime archive");
  const path = await regularFile(root, name);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest("hex") !== expected) throw new Error(`Remote archive checksum mismatch: ${name}`);
  return path;
}

function archiveName(platform, component) {
  return `flatt-remote-${platform}-${component.id}-${component.sha256}.tar.gz`;
}

export async function stageRemoteReleaseAssets(mockCdnRoot, output, version) {
  if (
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
  ) {
    throw new Error("Expected a safe remote application version");
  }
  const planned = [];
  for (const platform of remotePlatforms) {
    const name = `manifest-${platform}.json`;
    const manifest = await readManifest(join(mockCdnRoot, "releases", version), name);
    validateManifest(manifest, platform, version);
    const components = [];
    for (const component of manifest.components) {
      const path = await checkArchive(mockCdnRoot, component.artifactPath, component.sha256);
      const filename = archiveName(platform, component);
      planned.push({ name: filename, path });
      const { id, mount, sha256, version: componentVersion } = component;
      components.push({ id, version: componentVersion, sha256, artifactPath: filename, mount });
    }
    planned.push({
      name,
      content:
        JSON.stringify(
          { schemaVersion: 1, appVersion: version, platformArch: platform, components },
          null,
          2,
        ) + "\n",
    });
  }
  // 旧发布只上传安装包，remote manifest 一直 404。只把已校验的运行时闭包改写成
  // GitHub 的平铺资产名；不上传 producer 目录，也不覆盖已存在的候选文件。
  await mkdir(output, { recursive: true });
  for (const file of planned) {
    if (file.path) await copyFile(file.path, join(output, file.name), constants.COPYFILE_EXCL);
    else await writeFile(join(output, file.name), file.content, { flag: "wx" });
  }
  return validateRemoteReleaseAssets(output, version, { required: true });
}

export async function validateRemoteReleaseAssets(directory, version, { required = false } = {}) {
  const names = await readdir(directory);
  const present = remoteManifestNames.filter((name) => names.includes(name));
  if (!present.length && !required) return [];
  if (present.length !== remoteManifestNames.length)
    throw new Error("Complete four-platform remote runtime manifests are required");
  const selected = [];
  for (const platform of remotePlatforms) {
    const name = `manifest-${platform}.json`;
    const manifest = await readManifest(directory, name);
    validateManifest(manifest, platform, version);
    selected.push(name);
    for (const component of manifest.components) {
      const filename = archiveName(platform, component);
      if (component.artifactPath !== filename)
        throw new Error("Remote release assets must use exact flat content-addressed filenames");
      await checkArchive(directory, filename, component.sha256);
      selected.push(filename);
    }
  }
  return selected;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [command, input, output, version] = process.argv.slice(2);
  if (command !== "stage" || !input || !output || !version)
    throw new Error("Usage: remote-release-assets.mjs stage <mock-cdn> <output> <version>");
  await stageRemoteReleaseAssets(input, output, version);
}
