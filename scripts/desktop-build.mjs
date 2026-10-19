import {
  appendFile,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createTargetProvenance } from "./aggregate-release.mjs";
import {
  assertReleaseIsNewer,
  releaseTargets,
  releaseVersion,
  targetFiles,
  verifyFileList,
} from "./release-artifacts.mjs";
import { runPrivateCommand } from "./private-command.mjs";

export function validateSourceSha(value) {
  if (typeof value !== "string" || value.length !== 40 || !/^[a-f0-9]{40}$/.test(value))
    throw new Error("Expected immutable full source SHA");
  return value;
}

export function resolveElectronExecutable(source) {
  // 修复依据：源仓库采用 hoisted 布局，desktop/node_modules 不存在；使用 Electron 的公开入口解析真实可执行文件。
  return createRequire(join(source, "packages/desktop/package.json"))("electron");
}

export async function readSourceRelease(root, sourceSha, expectedVersion) {
  validateSourceSha(sourceSha);
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const release = releaseVersion(version);
  if (expectedVersion && version !== expectedVersion) throw new Error("Source version mismatch");
  // 只有约定的公开版本说明可跨越私有/公开边界，不能接受任意 Markdown 路径。
  const notesPath = resolve(root, "docs", `release-notes-${version}.md`);
  if (!(await lstat(notesPath)).isFile() || (await realpath(notesPath)) !== notesPath)
    throw new Error("Expected regular public release notes");
  let notes = await readFile(notesPath, "utf8");
  if (!notes.trim() || Buffer.byteLength(notes) > 65536)
    throw new Error("Invalid public release notes");
  const caveat =
    "macOS installers are unsigned and not notarized. Manual installation may require approval in macOS Privacy & Security settings. Automatic updates on macOS are not supported for these unsigned builds.";
  if (!notes.includes(caveat)) notes = `${notes.trim()}\n\n${caveat}\n`;
  return { ...release, sourceSha, notes };
}

export async function stageTargetArtifacts(directory, output, target, version, sourceSha) {
  const provenance = await createTargetProvenance(directory, target, version, sourceSha);
  const spec = targetFiles(target, version);
  const files = await verifyFileList(
    directory,
    provenance.files,
    new Set([...spec.required, ...spec.optional]),
    spec.required,
  );
  await mkdir(output, { recursive: false });
  for (const file of files.values()) await copyFile(file.path, join(output, file.name));
  await copyFile(
    join(directory, "release-provenance.json"),
    join(output, "release-provenance.json"),
  );
  await verifyFileList(
    output,
    provenance.files,
    new Set([...spec.required, ...spec.optional]),
    spec.required,
  );
  if ((await readdir(output)).length !== files.size + 1) throw new Error("Unexpected staged asset");
}

async function prepareMetadata(source, sourceSha) {
  const release = await readSourceRelease(source, sourceSha);
  const response = await fetch(
    "https://api.github.com/repos/LuminaSoft-br/flatt-releases/releases?per_page=100",
    {
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
    },
  );
  if (!response.ok) throw new Error("Cannot check existing public releases");
  const existing = await response.json();
  if (existing.some((item) => item.tag_name === release.tag))
    throw new Error("Release tag already exists");
  assertReleaseIsNewer(existing, release.version);
  const staged = resolve("release-staged");
  await mkdir(staged, { recursive: false });
  await writeFile(join(staged, "release-notes.md"), release.notes);
  await appendFile(process.env.GITHUB_OUTPUT, `version=${release.version}\nsha=${sourceSha}\n`);
  console.log(`[release] admitted ${release.tag}, source ${sourceSha}`);
}

async function windowsRuntime(source) {
  const archive = join(process.env.RUNNER_TEMP, "flatt-cua-win32-x64.zip");
  const helper = join(process.env.RUNNER_TEMP, "cua-helper");
  const token = process.env.FLATT_SOURCE_READ_TOKEN;
  if (!token) throw new Error("Missing read-only source credential");
  await runPrivateCommand(
    "windows-runtime-download",
    "gh",
    [
      "release",
      "download",
      "desktop-runtime-win32-x64-20261007",
      "--repo",
      "LuminaSoft-br/flatt-app",
      "--pattern",
      "flatt-cua-win32-x64.zip",
      "--dir",
      process.env.RUNNER_TEMP,
    ],
    {
      cwd: source,
      extraEnv: { GH_TOKEN: token },
    },
  );
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest("hex") !== "e3de5e9addef3d3ef3dc7310dd2454f09de00964db49661648925547b698b648")
    throw new Error("Pinned native runtime integrity mismatch");
  await runPrivateCommand(
    "windows-runtime-extract",
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Expand-Archive -LiteralPath $env:FLATT_RUNTIME_ARCHIVE -DestinationPath $env:FLATT_RUNTIME_HELPER",
    ],
    {
      extraEnv: { FLATT_RUNTIME_ARCHIVE: archive, FLATT_RUNTIME_HELPER: helper },
    },
  );
}

async function main() {
  const stage = process.argv[2];
  const sourceSha = validateSourceSha(process.env.SOURCE_SHA);
  if (stage === "validate-input") {
    if (!process.env.FLATT_SOURCE_READ_TOKEN)
      throw new Error("Missing read-only source credential");
    return;
  }
  const source = resolve(".private-source");
  if (stage === "preflight") return prepareMetadata(source, sourceSha);
  const target = process.env.TARGET;
  if (!releaseTargets.includes(target)) throw new Error("Unsupported native target");
  const version = process.env.RELEASE_VERSION;
  await readSourceRelease(source, sourceSha, version);
  if (stage === "windows-runtime") return windowsRuntime(source);
  if (stage === "verify") {
    for (const command of ["typecheck", "lint"])
      await runPrivateCommand(command, "pnpm", [command], { cwd: source });
    await runPrivateCommand("architecture", "pnpm", ["architecture:check", "--changed"], {
      cwd: source,
    });
    await runPrivateCommand(
      "regression-tests",
      "pnpm",
      [
        "exec",
        "tsx",
        "--test",
        "apps/flatt-cli/packages/core/test/autoCompactPolicy.test.ts",
        "apps/flatt-cli/packages/core/test/modelRequestRetention.test.ts",
        "apps/flatt-cli/packages/bootstrap/test/modelRequestReplay.test.ts",
        "packages/desktop/test/asyncLogWriter.test.ts",
        "packages/shared/test/memoryDiagnosticsLimits.test.ts",
        "packages/ui/test/highlightScheduler.test.ts",
        "packages/ui/test/rendererMemoryDiagnostics.test.ts",
      ],
      { cwd: source, extraEnv: { TSX_TSCONFIG_PATH: join(source, "packages/ui/tsconfig.json") } },
    );
    return;
  }
  if (stage === "linux-regression") {
    if (process.platform !== "linux" || target !== "linux-x64")
      throw new Error("Linux regression requires Linux x64");
    const harness = "packages/desktop/test/longSessionLinux.e2e.mjs";
    const output = join(process.env.RUNNER_TEMP, "long-session-regression");
    await runPrivateCommand("linux-harness-build", process.execPath, [harness, "prepare", output], {
      cwd: source,
    });
    await runPrivateCommand(
      "linux-electron-regression",
      process.execPath,
      [harness, "run", output, resolveElectronExecutable(source)],
      { cwd: source },
    );
    return;
  }
  if (stage === "stage") {
    await stageTargetArtifacts(
      join(source, "packages/desktop/dist-ci"),
      resolve("release-staged"),
      target,
      version,
      sourceSha,
    );
    console.log(`[release] validated staged installers for ${target}`);
    return;
  }
  const [os, arch] = target === "windows-x64" ? ["win", "x64"] : target.split("-");
  const commands = {
    install: ["install", "--frozen-lockfile"],
    runtime: ["--filter", "@flatt/desktop", "prepare:runtime-assets"],
    compile: ["--filter", "@flatt/desktop", "build:no-runtime-assets"],
    package: ["bundle:desktop", "--os", os, "--arch", arch, "--skip-prepare", "--skip-build"],
  };
  if (!commands[stage]) throw new Error("Unknown private build stage");
  await runPrivateCommand(stage, "pnpm", commands[stage], {
    cwd: source,
    extraEnv: { FLATT_CUA_HELPER_SOURCE: join(process.env.RUNNER_TEMP, "cua-helper") },
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    // 私有 JSON/编译异常可能包含源码或凭据；公开日志只暴露固定阶段名。
    console.error("[private-build] stage failed; private output withheld");
    process.exitCode = 1;
  });
}
