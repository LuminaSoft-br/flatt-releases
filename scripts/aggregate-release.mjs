import { cp, link, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import {
  checkedFile,
  releaseTargets,
  releaseVersion,
  targetFiles,
  validateReleaseArtifacts,
  validateManifestTargetCoverage,
  verifyFileList,
} from "./release-artifacts.mjs";

export { releaseTargets };

const serializable = ({ name, size, sha512 }) => ({ name, size, sha512 });

function checkSource(sourceSha) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? "")) throw new Error("Expected full source SHA");
}

export async function createTargetProvenance(directory, target, version, sourceSha) {
  checkSource(sourceSha);
  const { required, optional, manifest } = targetFiles(target, version);
  const names = await readdir(directory);
  const selected = [...required, ...optional.filter((n) => names.includes(n))];
  await validateReleaseArtifacts(directory, version);
  validateManifestTargetCoverage(
    parse(await readFile(join(directory, manifest), "utf8")),
    [target],
    version,
  );
  const files = await Promise.all(selected.map((n) => checkedFile(directory, n)));
  const provenance = {
    schemaVersion: 1,
    version,
    sourceSha,
    target,
    files: files.map(serializable),
  };
  await writeFile(join(directory, "release-provenance.json"), JSON.stringify(provenance, null, 2));
  return provenance;
}

export async function aggregateRelease(
  input,
  output,
  version,
  sourceSha,
  { linkFiles = false } = {},
) {
  releaseVersion(version);
  checkSource(sourceSha);
  const directories = await readdir(input, { withFileTypes: true });
  if (directories.length !== releaseTargets.length || directories.some((d) => !d.isDirectory()))
    throw new Error("Expected exactly five target directories");
  const targets = new Map();
  for (const directory of directories) {
    const dir = join(input, directory.name);
    const provenance = JSON.parse(await readFile(join(dir, "release-provenance.json"), "utf8"));
    if (
      provenance.schemaVersion !== 1 ||
      provenance.version !== version ||
      provenance.sourceSha !== sourceSha ||
      !releaseTargets.includes(provenance.target) ||
      targets.has(provenance.target)
    )
      throw new Error("Invalid, duplicate or mismatched target provenance");
    const spec = targetFiles(provenance.target, version);
    const files = await verifyFileList(
      dir,
      provenance.files,
      new Set([...spec.required, ...spec.optional]),
      spec.required,
    );
    const names = await readdir(dir);
    if (names.some((n) => n !== "release-provenance.json" && !files.has(n)))
      throw new Error("Unexpected file in target artifact");
    await validateReleaseArtifacts(dir, version);
    const manifest = parse(await readFile(join(dir, spec.manifest), "utf8"));
    validateManifestTargetCoverage(manifest, [provenance.target], version);
    targets.set(provenance.target, { dir, provenance, files, manifest, spec });
  }
  // 两个 macOS build 的 manifest 同名，先逐个验签再合并，禁止平铺下载时覆盖 ARM64 或 x64。
  await mkdir(output, { recursive: false });
  const copied = new Set();
  for (const target of releaseTargets) {
    const entry = targets.get(target);
    for (const file of entry.files.values()) {
      if (target.startsWith("mac-") && file.name === entry.spec.manifest) continue;
      if (copied.has(file.name)) throw new Error(`Duplicate aggregate filename: ${file.name}`);
      // CI staging 的安装包不可变；显式 hard-link 避免 ENOSPC，本地默认仍复制独立文件。
      if (linkFiles) await link(file.path, join(output, file.name));
      else await cp(file.path, join(output, file.name), { errorOnExist: true, force: false });
      copied.add(file.name);
    }
  }
  const x64 = targets.get("mac-x64");
  const arm64 = targets.get("mac-arm64");
  const merged = { ...x64.manifest, files: [...x64.manifest.files, ...arm64.manifest.files] };
  await writeFile(join(output, x64.spec.manifest), stringify(merged));
  copied.add(x64.spec.manifest);
  const files = await Promise.all([...copied].sort().map((n) => checkedFile(output, n)));
  const inventory = {
    schemaVersion: 1,
    version,
    sourceSha,
    targets: releaseTargets.map((t) => ({ target: t, sourceSha })),
    files: files.map(serializable),
  };
  await writeFile(join(output, "release-inventory.json"), JSON.stringify(inventory, null, 2));
  return validateReleaseArtifacts(output, version);
}

async function main() {
  const [command, directory, arg, version, sourceSha, mode] = process.argv.slice(2);
  if (mode && mode !== "--link-files") throw new Error("Invalid aggregation mode");
  if (command === "provenance" && sourceSha)
    await createTargetProvenance(resolve(directory), arg, version, sourceSha);
  else if (command === "aggregate" && sourceSha)
    await aggregateRelease(resolve(directory), resolve(arg), version, sourceSha, {
      linkFiles: mode === "--link-files",
    });
  else
    throw new Error(
      "Usage: aggregate-release.mjs provenance <dir> <target> <version> <sha> | aggregate <input> <output> <version> <sha>",
    );
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main();
