import assert from "node:assert/strict";
import { readFile, readdir, writeFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";
import { cleanBuildEnvironment, runPrivateCommand } from "../scripts/private-command.mjs";
import {
  validateSourceSha,
  readSourceRelease,
  stageTargetArtifacts,
  resolveElectronExecutable,
  addFixtureDiagnostics,
} from "../scripts/desktop-build.mjs";
import { fixture, version, sha } from "./releaseFixture.mjs";

test("source admission accepts immutable SHA only", () => {
  assert.equal(validateSourceSha(sha), sha);
  for (const input of ["main", "master", "a".repeat(39), "a".repeat(40) + "\n", "$(echo secret)"])
    assert.throws(() => validateSourceSha(input));
});

test("fixture diagnostics retain current Electron console message text and original entrypoint", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "flatt-fixture-console-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  await writeFile(join(output, "main.cjs"), "original fixture");
  await addFixtureDiagnostics(output);
  assert.equal(await readFile(join(output, "main.fixture.cjs"), "utf8"), "original fixture");
  let consoleListener;
  let originalRequired = false;
  const messages = [];
  runInNewContext(await readFile(join(output, "main.cjs"), "utf8"), {
    require(name) {
      if (name === "electron")
        return {
          app: {
            on(_event, listener) {
              listener(
                {},
                {
                  on(event, callback) {
                    if (event === "console-message") consoleListener = callback;
                  },
                },
              );
            },
          },
        };
      assert.equal(name, "./main.fixture.cjs");
      originalRequired = true;
    },
    console: { error: (...args) => messages.push(args.join(" ")) },
  });
  consoleListener({ level: "error", message: "fixture renderer failure" });
  assert.equal(originalRequired, true);
  assert.match(messages.join("\n"), /fixture renderer failure/);
});

test("Linux graphical validation resolves Electron from a hoisted workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flatt-hoisted-electron-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "packages/desktop"), { recursive: true });
  await writeFile(join(root, "packages/desktop/package.json"), '{"name":"desktop"}');
  await mkdir(join(root, "node_modules/electron"), { recursive: true });
  await writeFile(
    join(root, "node_modules/electron/index.js"),
    'module.exports = "/fixture/electron";',
  );
  assert.equal(resolveElectronExecutable(root), "/fixture/electron");
});

test("private subprocesses have no tokens or Actions control files", () => {
  const env = cleanBuildEnvironment({
    PATH: "bin",
    CI: "1",
    GH_TOKEN: "secret",
    FLATT_SOURCE_READ_TOKEN: "secret",
    ACTIONS_RUNTIME_TOKEN: "secret",
    GITHUB_OUTPUT: "output",
    GITHUB_ENV: "env",
    GITHUB_PATH: "path",
    GITHUB_STATE: "state",
    GITHUB_STEP_SUMMARY: "summary",
    CUSTOM_PASSWORD: "secret",
  });
  assert.deepEqual(env, { PATH: "bin", CI: "1" });
});

for (const code of [0, 1])
  test(`private stdout/stderr are discarded with exit ${code}`, async () => {
    const logs = [];
    const script = `process.stdout.write('private source and token\\n::error::source'); process.stderr.write('credential and source'); process.stdout.write('x'.repeat(2000000)); process.exit(${code});`;
    const run = runPrivateCommand("compile", process.execPath, ["-e", script], {
      report: (line) => logs.push(line),
    });
    if (code) await assert.rejects(run, /^Error: Private stage compile failed \(exit 1\)$/);
    else await run;
    assert.equal(logs.length, 2);
    assert.doesNotMatch(logs.join("\n"), /private source|token|credential|::error::|xxxx/);
  });

test("private spawn errors never expose command or credentials", async () => {
  await assert.rejects(
    runPrivateCommand("compile", "missing-private-secret-executable", [], { report: () => {} }),
    /^Error: Private stage compile failed to start$/,
  );
});

test("release metadata admits only explicitly public versioned notes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flatt-source-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "package.json"), JSON.stringify({ version }));
  await writeFile(join(root, "docs", `release-notes-${version}.md`), "Public hotfix notes");
  assert.equal((await readSourceRelease(root, sha)).version, version);
  await assert.rejects(readSourceRelease(root, sha, "9.9.9"), /version/);
  await writeFile(join(root, "docs", `release-notes-${version}.md`), "");
  await assert.rejects(readSourceRelease(root, sha), /notes/);
});

test("staging copies validated installers, never private source or build logs", async (t) => {
  const f = await fixture(t, ["linux-x64"]);
  const dist = join(f.input, "linux-x64");
  await writeFile(join(dist, "private-source.ts"), "private");
  await writeFile(join(dist, "build.log"), "credentials");
  const output = join(f.root, "staged");
  await stageTargetArtifacts(dist, output, "linux-x64", version, sha);
  const names = await readdir(output);
  assert.equal(names.length, 6);
  assert.ok(names.includes("release-provenance.json"));
  assert.ok(!names.includes("private-source.ts"));
  assert.ok(!names.includes("build.log"));
  await assert.rejects(stageTargetArtifacts(dist, output, "linux-x64", version, sha), /exist/i);
});

test("staging rejects symlinked artifacts before upload", async (t) => {
  const f = await fixture(t, ["linux-x64"]);
  const dist = join(f.input, "linux-x64");
  const name = `flatt-${version}-linux-x86_64.AppImage`;
  const source = join(dist, name);
  const bytes = await readFile(source);
  await rm(source);
  await writeFile(join(dist, "secret"), bytes);
  try {
    await symlink(join(dist, "secret"), source);
  } catch (error) {
    if (error.code === "EPERM") return t.skip("Windows symlink privilege unavailable");
    throw error;
  }
  await assert.rejects(
    stageTargetArtifacts(dist, join(f.root, "staged"), "linux-x64", version, sha),
  );
});

test("public workflow uses five native runners, isolated credentials and staged uploads", async () => {
  const raw = await readFile(
    new URL("../.github/workflows/build-desktop.yml", import.meta.url),
    "utf8",
  );
  const w = parse(raw);
  assert.deepEqual(Object.keys(w.on), ["workflow_dispatch"]);
  assert.equal(w.on.workflow_dispatch.inputs.publish.default, false);
  assert.equal(w.permissions.contents, "read");
  assert.equal(w.concurrency.group, "flatt-release-publication");
  assert.equal(w.concurrency["cancel-in-progress"], false);
  const matrix = w.jobs.build.strategy.matrix.include;
  assert.deepEqual(matrix.map((x) => x.id).sort(), [
    "linux-arm64",
    "linux-x64",
    "mac-arm64",
    "mac-x64",
    "windows-x64",
  ]);
  assert.equal(matrix.find((x) => x.id === "mac-x64").runner, "macos-15-intel");
  assert.equal(matrix.find((x) => x.id === "mac-arm64").runner, "macos-15");
  assert.deepEqual(w.jobs.publish.needs, ["preflight", "build"]);
  for (const job of Object.values(w.jobs)) {
    assert.equal(job.env?.GH_TOKEN, undefined);
    for (const step of job.steps) {
      if (step.uses?.startsWith("actions/checkout@"))
        assert.equal(step.with["persist-credentials"], false);
      if (step.with?.repository === "LuminaSoft-br/flatt-app") {
        assert.equal(step.with.token, "${{ secrets.FLATT_SOURCE_READ_TOKEN }}");
        assert.equal(
          step.with.ref,
          job === w.jobs.preflight
            ? "${{ inputs.source_sha }}"
            : "${{ needs.preflight.outputs.sha }}",
        );
      }
      assert.ok(!step.uses?.startsWith("actions/cache@"));
      assert.equal(step.with?.cache, undefined);
      if (step.uses?.startsWith("actions/upload-artifact@")) {
        if (step.with.path === "ota-evidence") {
          assert.equal(step.if, "matrix.id == 'windows-x64'");
          assert.match(step.with.name, /^ota-validation-/);
        } else if (step.with.path !== "release-staged") {
          assert.equal(step.if, "failure()");
          assert.match(step.with.name, /^encrypted-diagnostics-/);
          assert.equal(step.with.path, "${{ runner.temp }}/flatt-private-build-logs/*.enc.json");
        }
      }
      if (step.run) assert.doesNotMatch(step.run, /pnpm |set -x|printenv|--clobber/);
    }
  }
  assert.equal(w.jobs.publish.permissions.contents, "write");
  const installedGate = w.jobs.build.steps.findIndex(
    (s) => s.run === "node scripts/desktop-build.mjs installed-ota",
  );
  assert.ok(installedGate > 0);
  assert.equal(w.jobs.build.steps[installedGate].if, "matrix.id == 'windows-x64'");
  assert.ok(
    installedGate <
      w.jobs.build.steps.findIndex((s) => s.run === "node scripts/desktop-build.mjs stage"),
  );
  assert.match(raw, /--require-inventory/);
  assert.doesNotMatch(raw, /secrets: inherit/);
});
