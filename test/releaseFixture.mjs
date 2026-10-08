import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { createTargetProvenance, releaseTargets } from "../scripts/aggregate-release.mjs";

export const version = "1.2.3";
export const sha = "a".repeat(40);

// 文件名来自已成功的原生构建 37679956573，不能用统一的 x64/arm64 后缀伪造 Linux fixture。
export const nativeLinuxSuffixes = {
  x64: ["x86_64.AppImage", "amd64.deb", "x86_64.rpm", "x64.pkg.tar.zst"],
  arm64: ["arm64.AppImage", "arm64.deb", "aarch64.rpm", "aarch64.pkg.tar.zst"],
};

export async function fixture(
  t,
  selected = releaseTargets,
  fixtureVersion = version,
  options = {},
) {
  const version = fixtureVersion;
  const channel = version.includes("-beta.") ? "beta" : "latest";
  const root = await mkdtemp(join(tmpdir(), "flatt-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "input");
  await mkdir(input);
  for (const target of selected) {
    const dir = join(input, target);
    await mkdir(dir);
    const [os, arch] = target === "windows-x64" ? ["win", "x64"] : target.split("-");
    const extensions =
      os === "win"
        ? ["exe"]
        : os === "mac"
          ? ["zip", "dmg"]
          : ["AppImage", "deb", "rpm", "pkg.tar.zst"];
    const entries = [];
    for (const extension of extensions) {
      const name =
        os === "linux"
          ? `flatt-${version}-linux-${nativeLinuxSuffixes[arch].find((name) => name.endsWith(`.${extension}`))}`
          : `flatt-${version}-${os}-${arch}.${extension}`;
      const bytes = Buffer.from(`synthetic ${target} ${extension}, never publish`);
      await writeFile(join(dir, name), bytes);
      if (["exe", "zip", "dmg"].includes(extension))
        await writeFile(join(dir, `${name}.blockmap`), "blockmap fixture");
      if (
        ["exe", "zip", "AppImage"].includes(extension) ||
        (os === "linux" && !options.linuxAppImageOnly) ||
        (extension === "dmg" && options.macDmgManifest)
      )
        entries.push({
          url: name,
          size: bytes.length,
          sha512: createHash("sha512").update(bytes).digest("base64"),
        });
    }
    const manifest =
      os === "win"
        ? `${channel}.yml`
        : os === "mac"
          ? `${channel}-mac.yml`
          : `${channel}-linux${arch === "arm64" ? "-arm64" : ""}.yml`;
    await writeFile(
      join(dir, manifest),
      stringify({ version, files: entries, path: entries[0].url, sha512: entries[0].sha512 }),
    );
    await createTargetProvenance(dir, target, version, sha);
  }
  return { root, input, output: join(root, "output") };
}
