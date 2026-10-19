import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInstalledOtaValidation, validateOtaEvidence } from "../scripts/installed-ota.mjs";

const evidence = {
  from: "0.0.2-beta.0",
  to: "0.0.2",
  productionProvider: true,
  realInstallers: true,
  interruptedDownload: true,
  retry: true,
  progress: true,
  ready: true,
  explicitInstall: true,
  relaunched: true,
  retainedSettings: true,
  retainedData: true,
};
test("public OTA evidence admits only exact versions and successful fixed assertions", () => {
  assert.deepEqual(validateOtaEvidence(evidence, "0.0.2-beta.0", "0.0.2"), evidence);
  for (const wrong of [
    { ...evidence, retry: false },
    { ...evidence, to: "0.0.1" },
    { ...evidence, token: "private" },
  ])
    assert.throws(() => validateOtaEvidence(wrong, "0.0.2-beta.0", "0.0.2"));
});
test("predecessor build restores source version on failure and never overwrites final installers", async (t) => {
  const source = await mkdtemp(join(tmpdir(), "flatt-ota-build-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  const original = JSON.stringify({ name: "flatt", version: "0.0.2" });
  await writeFile(join(source, "package.json"), original);
  await mkdir(join(source, "packages/desktop/dist-ci"), { recursive: true });
  const final = join(source, "packages/desktop/dist-ci/final.exe");
  await writeFile(final, "final installer");
  const stages = [];
  await assert.rejects(
    runInstalledOtaValidation(source, "0.0.2", {
      temporary: source,
      run: async (stage, _command, _args, options) => {
        stages.push(stage);
        assert.equal(
          JSON.parse(await readFile(join(source, "package.json"), "utf8")).version,
          "0.0.2-beta.0",
        );
        if (stage === "ota-predecessor-package") {
          assert.equal(options.extraEnv.FLATT_DESKTOP_DIST_DIR, "ota-validation-dist");
          throw new Error("build failed");
        }
      },
    }),
    /build failed/,
  );
  assert.deepEqual(stages, ["ota-predecessor-compile", "ota-predecessor-package"]);
  assert.equal(await readFile(join(source, "package.json"), "utf8"), original);
  assert.equal(await readFile(final, "utf8"), "final installer");
});
