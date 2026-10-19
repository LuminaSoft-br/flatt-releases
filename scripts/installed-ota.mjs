import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { releaseVersion } from "./release-artifacts.mjs";
import { runPrivateCommand } from "./private-command.mjs";

const assertions = [
  "productionProvider",
  "realInstallers",
  "interruptedDownload",
  "retry",
  "progress",
  "ready",
  "explicitInstall",
  "relaunched",
  "retainedSettings",
  "retainedData",
];
export function validateOtaEvidence(value, from, to) {
  const keys = ["from", "to", ...assertions];
  if (
    !value ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((k) => !keys.includes(k)) ||
    value.from !== from ||
    value.to !== to ||
    assertions.some((k) => value[k] !== true)
  )
    throw new Error("Incomplete or unsafe installed OTA evidence");
  return value;
}

export async function runInstalledOtaValidation(source, version, options = {}) {
  const run = options.run ?? runPrivateCommand;
  const temporary = options.temporary ?? process.env.RUNNER_TEMP;
  const predecessor = releaseVersion(version).prerelease ? "0.0.0-beta.0" : `${version}-beta.0`;
  const path = join(source, "package.json");
  const original = await readFile(path, "utf8");
  const pkg = JSON.parse(original);
  if (pkg.version !== version) throw new Error("OTA source version mismatch");
  pkg.version = predecessor;
  await writeFile(path, JSON.stringify(pkg, null, 2) + "\n");
  try {
    await run(
      "ota-predecessor-compile",
      "pnpm",
      ["--filter", "@flatt/desktop", "build:no-runtime-assets"],
      { cwd: source },
    );
    await run(
      "ota-predecessor-package",
      "pnpm",
      ["bundle:desktop", "--os", "win", "--arch", "x64", "--skip-prepare", "--skip-build"],
      {
        cwd: source,
        extraEnv: {
          FLATT_DESKTOP_DIST_DIR: "ota-validation-dist",
          FLATT_CUA_HELPER_SOURCE: join(temporary, "cua-helper"),
        },
      },
    );
  } finally {
    // 仅验证前身改变版本；最终发布安装包保持原版本/目录，失败也必须还原私有 checkout 元数据。
    await writeFile(path, original);
  }
  const output = join(temporary, "installed-ota-validation");
  await run(
    "installed-ota-test",
    process.execPath,
    [
      "packages/desktop/test/installedOtaWindows.e2e.mjs",
      join(source, "packages/desktop/ota-validation-dist", `flatt-${predecessor}-win-x64.exe`),
      join(source, "packages/desktop/dist-ci"),
      output,
      predecessor,
      version,
    ],
    { cwd: source },
  );
  const result = validateOtaEvidence(
    JSON.parse(await readFile(join(output, "result.json"), "utf8")),
    predecessor,
    version,
  );
  const staged = options.evidence ?? resolve("ota-evidence");
  await mkdir(staged, { recursive: false });
  await writeFile(join(staged, "installed-ota.json"), JSON.stringify(result, null, 2) + "\n");
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `\nInstalled Windows OTA: \`${predecessor}\` → \`${version}\`.\n\nAll ${assertions.length} installed-upgrade assertions passed.\n`,
    );
  console.log(`[release] installed Windows OTA verified: ${predecessor} -> ${version}`);
}
