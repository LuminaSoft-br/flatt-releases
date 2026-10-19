import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { aggregateRelease } from "../scripts/aggregate-release.mjs";
import { publishRelease } from "../scripts/publish-release.mjs";
import { assertDraftRebuildAdmission } from "../scripts/desktop-build.mjs";
import { fixture, sha, version } from "./releaseFixture.mjs";

const oldSha = "1".repeat(40);
test("rebuild admission requires explicit immutable authorization and never admits a published tag", () => {
  const release = { tag: `v${version}`, sourceSha: sha };
  assert.doesNotThrow(() => assertDraftRebuildAdmission([], release));
  assert.doesNotThrow(() =>
    assertDraftRebuildAdmission([{ tag_name: release.tag, draft: true }], release, oldSha),
  );
  assert.throws(() =>
    assertDraftRebuildAdmission([{ tag_name: release.tag, draft: true }], release),
  );
  assert.throws(() =>
    assertDraftRebuildAdmission([{ tag_name: release.tag, draft: false }], release, oldSha),
  );
  assert.throws(() => assertDraftRebuildAdmission([], release, "master"));
});
for (const scenario of ["authorized", "wrong-source", "published", "published-during-check"]) {
  test(`draft replacement ${scenario} checks inventory and publication state before deletion`, async (t) => {
    const { input, output } = await fixture(t);
    await aggregateRelease(input, output, version, sha);
    let exists = true;
    let replaced = false;
    const remote = new Map([
      [
        "release-inventory.json",
        Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            version,
            sourceSha: scenario === "wrong-source" ? sha : oldSha,
          }),
        ),
      ],
    ]);
    const calls = [];
    const prior = () => ({
      id: 1,
      tag_name: `v${version}`,
      draft: scenario !== "published",
      assets: [...remote.keys()].map((name) => ({ name })),
    });
    const run = async (args) => {
      calls.push(args);
      if (args[0] === "api") {
        if (args.includes("DELETE")) {
          exists = false;
          replaced = true;
          remote.clear();
          return "";
        }
        if (args[1].endsWith("/1"))
          return JSON.stringify({ ...prior(), draft: scenario !== "published-during-check" });
        return JSON.stringify([exists ? [prior()] : []]);
      }
      if (args[1] === "download") {
        const name = args[args.indexOf("--pattern") + 1];
        await writeFile(join(args[args.indexOf("--dir") + 1], name), remote.get(name));
      }
      if (args[1] === "create") exists = true;
      if (args[1] === "upload")
        for (const path of args.slice(3, args.indexOf("--repo")))
          remote.set(basename(path), await readFile(path));
      return "";
    };
    const action = publishRelease({
      directory: output,
      version,
      notes: "notes.md",
      requireInventory: true,
      replaceDraftSourceSha: oldSha,
      run,
    });
    if (scenario === "authorized") await action;
    else await assert.rejects(action);
    assert.equal(replaced, scenario === "authorized");
    assert.equal(
      calls.some((c) => c[1] === "edit"),
      false,
    );
  });
}
