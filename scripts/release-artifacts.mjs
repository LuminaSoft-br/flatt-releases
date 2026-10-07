import { createHash } from "node:crypto";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import semver from "semver";
import { parse } from "yaml";

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
  if (semver.valid(version) !== version) throw new Error("Expected canonical semantic version");
  const prerelease = semver.prerelease(version);
  if (
    prerelease &&
    (prerelease.length !== 2 || prerelease[0] !== "beta" || typeof prerelease[1] !== "number")
  ) {
    throw new Error("Test releases must use X.Y.Z-beta.N");
  }
  const channel = prerelease ? "beta" : "latest";
  const names = await readdir(directory);
  const manifests = names.filter((name) =>
    /^(latest|beta)(-mac|-linux(?:-arm64)?)?\.yml$/.test(name),
  );
  if (!manifests.length) throw new Error("No update manifests found");
  const files = new Map();
  const add = async (name) => {
    const path = join(directory, name);
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) throw new Error(`Missing or empty artifact: ${name}`);
    const entry = { name, path, size: info.size, sha512: await fileSha512(path) };
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
    for (const file of manifest.files) {
      const filename = file.url;
      // 修复依据：公开发布只接收 manifest 引用的安装包，不能把源码或本地路径作为资产上传。
      if (
        typeof filename !== "string" ||
        basename(filename) !== filename ||
        !/^flatt-[A-Za-z0-9_.-]+\.(exe|zip|AppImage|deb|rpm|pkg\.tar\.zst)$/.test(filename) ||
        !filename.includes(`-${version}-`) ||
        filename.includes("_TEST")
      ) {
        throw new Error(`Invalid installer filename: ${String(filename)}`);
      }
      const entry = await add(filename);
      if (file.size !== entry.size || file.sha512 !== entry.sha512) {
        throw new Error(`Size/checksum mismatch: ${filename}`);
      }
      if (/\.(exe|zip|AppImage)$/.test(filename)) await add(`${filename}.blockmap`);
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
  return {
    version,
    tag: `v${version}`,
    prerelease: Boolean(prerelease),
    files: [...files.values()],
  };
}
