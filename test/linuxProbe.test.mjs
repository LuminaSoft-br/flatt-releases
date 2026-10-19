import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { createLinuxElectronLauncher } from "../scripts/desktop-build.mjs";

test("optional Linux launcher admits a fixed window manager and quotes executable paths", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "flatt-x11-launcher-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await createLinuxElectronLauncher("/bin/electron", dir, "none"), "/bin/electron");
  await assert.rejects(createLinuxElectronLauncher("/bin/electron", dir, "other; secret"));
  const path = await createLinuxElectronLauncher("/a' b/electron", dir, "openbox");
  const script = await readFile(path, "utf8");
  assert.match(script, /_NET_SUPPORTING_WM_CHECK/);
  assert.match(script, /openbox --sm-disable/);
  assert.ok(script.includes("'/a'\"'\"' b/electron'"));
  assert.match(script, /--ozone-platform=x11/);
});

test("Linux probe is manual, source-pinned, read-only and retains encrypted diagnostics only", async () => {
  const w = parse(
    await readFile(
      new URL("../.github/workflows/diagnose-linux-responsiveness.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(Object.keys(w.on), ["workflow_dispatch"]);
  assert.equal(w.permissions.contents, "read");
  assert.deepEqual(w.jobs.probe.strategy.matrix.window_manager, ["none", "openbox"]);
  for (const step of w.jobs.probe.steps) {
    if (step.uses?.startsWith("actions/checkout@"))
      assert.equal(step.with["persist-credentials"], false);
    if (step.with?.repository === "LuminaSoft-br/flatt-app")
      assert.equal(step.with.ref, "${{ inputs.source_sha }}");
    if (step.uses?.startsWith("actions/upload-artifact@")) {
      assert.equal(step.if, "failure()");
      assert.match(step.with.path, /\.enc\.json$/);
    }
  }
});
