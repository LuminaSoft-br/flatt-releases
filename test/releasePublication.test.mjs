import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { readFile, readdir, writeFile } from "node:fs/promises";
import test from "node:test";
import { aggregateRelease } from "../scripts/aggregate-release.mjs";
import { publishRelease } from "../scripts/publish-release.mjs";
import { fixture, sha, version } from "./releaseFixture.mjs";

for (const scenario of [
  "new",
  "upload-failure",
  "resume",
  "wrong-inventory",
  "corrupt-existing",
  "extra-existing",
  "corrupt-download",
  "extra-uploaded",
]) {
  test(`inventory publication ${scenario} verifies before publishing and never overwrites`, async (t) => {
    const { input, output } = await fixture(t);
    await aggregateRelease(input, output, version, sha);
    const remote = new Map();
    const calls = [];
    const resumed = ["resume", "wrong-inventory", "corrupt-existing", "extra-existing"].includes(
      scenario,
    );
    if (resumed)
      remote.set("release-inventory.json", await readFile(join(output, "release-inventory.json")));
    if (scenario === "wrong-inventory") remote.get("release-inventory.json")[0] ^= 1;
    if (scenario === "corrupt-existing")
      remote.set(`flatt-${version}-win-x64.exe`, Buffer.from("corrupt"));
    if (scenario === "extra-existing") remote.set("private.ts", Buffer.from("source"));
    let exists = resumed;
    const run = async (args) => {
      calls.push(args);
      if (args[0] === "api")
        return JSON.stringify([
          exists
            ? [
                {
                  tag_name: `v${version}`,
                  draft: true,
                  assets: [...remote.keys()].map((name) => ({ name })),
                },
              ]
            : [],
        ]);
      if (args[1] === "create") {
        exists = true;
        return "";
      }
      if (args[1] === "upload") {
        const paths = args.slice(3, args.indexOf("--repo"));
        if (
          scenario === "upload-failure" &&
          paths.some((p) => basename(p) !== "release-inventory.json")
        )
          throw new Error("interrupted upload");
        for (const path of paths) {
          assert.equal(
            remote.has(basename(path)),
            false,
            "uploaded assets must not be overwritten",
          );
          remote.set(basename(path), await readFile(path));
        }
        if (scenario === "extra-uploaded") remote.set("private.ts", Buffer.from("extra"));
      }
      if (args[1] === "download") {
        const dir = args[args.indexOf("--dir") + 1];
        assert.deepEqual(
          await readdir(dir),
          [],
          "verification must retain only one downloaded asset",
        );
        const name = args[args.indexOf("--pattern") + 1];
        assert.ok(args.includes("--pattern"));
        const bytes = remote.get(name);
        assert.ok(bytes);
        await writeFile(join(dir, name), scenario === "corrupt-download" ? "corrupt" : bytes);
      }
      return "";
    };
    const action = publishRelease({
      directory: output,
      version,
      notes: "notes.md",
      publish: true,
      requireInventory: true,
      run,
    });
    const success = ["new", "resume"].includes(scenario);
    if (success) await action;
    else await assert.rejects(action);
    assert.equal(calls.filter((a) => a[1] === "edit").length, success ? 1 : 0);
    assert.equal(calls.filter((a) => a[1] === "create").length, resumed ? 0 : 1);
    if (success) assert.ok(calls.find((a) => a[1] === "edit").includes("--latest=true"));
    if (!resumed)
      assert.equal(basename(calls.find((a) => a[1] === "upload")[3]), "release-inventory.json");
    if (scenario === "upload-failure")
      assert.deepEqual([...remote.keys()], ["release-inventory.json"]);
    if (["wrong-inventory", "corrupt-existing", "extra-existing"].includes(scenario))
      assert.equal(calls.filter((a) => a[1] === "upload").length, 0);
  });
}
