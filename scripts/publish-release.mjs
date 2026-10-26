import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertReleaseIsNewer,
  fileSha512,
  validateReleaseArtifacts,
} from "./release-artifacts.mjs";
import { validateRemoteReleaseAssets } from "./remote-release-assets.mjs";

const repository = "LuminaSoft-br/flatt-releases";

export async function gh(args, environment = {}) {
  return new Promise((accept, reject) => {
    const child = spawn("gh", args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...environment },
    });
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      error += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? accept(output) : reject(new Error(error.trim() || `gh exited ${code}`)),
    );
  });
}

async function verifyRemoteFiles(files, tag, run) {
  const downloaded = await mkdtemp(join(tmpdir(), "flatt-release-verify-"));
  try {
    // 整批 redownload 会再次占用 8 GB；逐个下载、验哈希并丢弃临时副本，保持安装包原件不变。
    for (const file of files) {
      await run([
        "release",
        "download",
        tag,
        "--repo",
        repository,
        "--dir",
        downloaded,
        "--pattern",
        file.name,
      ]);
      const names = await readdir(downloaded);
      const path = join(downloaded, file.name);
      if (
        names.length !== 1 ||
        names[0] !== file.name ||
        (await stat(path)).size !== file.size ||
        (await fileSha512(path)) !== file.sha512
      )
        throw new Error(
          `Uploaded artifact failed verification: ${file.name}; release remains draft`,
        );
      await rm(path);
    }
  } finally {
    await rm(downloaded, { recursive: true, force: true });
  }
}

export async function publishRelease({
  directory,
  version,
  notes,
  publish = false,
  check = false,
  requireInventory = false,
  requireRemoteAssets = false,
  replaceDraftSourceSha,
  run = gh,
}) {
  if (replaceDraftSourceSha && (!requireInventory || !/^[a-f0-9]{40}$/.test(replaceDraftSourceSha)))
    throw new Error("Draft replacement requires an exact source SHA and complete inventory");
  const plan = await validateReleaseArtifacts(directory, version);
  if (requireRemoteAssets)
    await validateRemoteReleaseAssets(directory, version, { required: true });
  if (requireInventory && !plan.inventory)
    throw new Error("Complete five-target release inventory is required");
  console.log(`[release] validated ${plan.files.length} assets for ${plan.tag}`);
  if (check) return plan;
  const existing = JSON.parse(
    await run(["api", `repos/${repository}/releases`, "--paginate", "--slurp"]),
  ).flat();
  let prior = existing.find((release) => release.tag_name === plan.tag);
  if (prior && !prior.draft) {
    throw new Error(
      `Release ${plan.tag} already exists; published assets must never be overwritten`,
    );
  }
  assertReleaseIsNewer(existing, version);
  if (prior && replaceDraftSourceSha) {
    const inspection = await mkdtemp(join(tmpdir(), "flatt-old-draft-"));
    try {
      await run([
        "release",
        "download",
        plan.tag,
        "--repo",
        repository,
        "--dir",
        inspection,
        "--pattern",
        "release-inventory.json",
      ]);
      const inventory = JSON.parse(
        await readFile(join(inspection, "release-inventory.json"), "utf8"),
      );
      if (
        inventory.schemaVersion !== 1 ||
        inventory.version !== version ||
        inventory.sourceSha !== replaceDraftSourceSha
      )
        throw new Error("Draft replacement source does not match authorized inventory");
      const current = JSON.parse(await run(["api", `repos/${repository}/releases/${prior.id}`]));
      if (!current.draft || current.id !== prior.id || current.tag_name !== plan.tag)
        throw new Error("Draft state changed; replacement stopped");
      // 仅在完整新产物已验证且旧 source 明确授权后删除未发布 draft，绝不覆盖已发布版本。
      await run(["api", "--method", "DELETE", `repos/${repository}/releases/${prior.id}`]);
      prior = undefined;
    } finally {
      await rm(inspection, { recursive: true, force: true });
    }
  }
  const args = [
    "release",
    "create",
    plan.tag,
    "--repo",
    repository,
    "--draft",
    "--title",
    `Flatt ${version}`,
    "--notes-file",
    notes,
  ];
  if (plan.prerelease) args.push("--prerelease");
  let pending = plan.files;
  if (prior) {
    // 仅允许同一 inventory 的中断 draft 续传；未知 draft 或已上传字节不一致时绝不覆盖。
    if (!plan.inventory || !prior.assets?.some((a) => a.name === "release-inventory.json"))
      throw new Error("Existing draft has no matching inventory; do not overwrite it");
    const names = prior.assets.map((asset) => asset.name);
    if (
      new Set(names).size !== names.length ||
      names.some((name) => !plan.files.some((file) => file.name === name))
    )
      throw new Error("Existing draft has unexpected assets");
    await verifyRemoteFiles(
      plan.files.filter((file) => names.includes(file.name)),
      plan.tag,
      run,
    );
    pending = plan.files.filter((file) => !names.includes(file.name));
  } else {
    await run(args);
    const inventory = plan.files.find((f) => f.name === "release-inventory.json");
    if (inventory) {
      await run(["release", "upload", plan.tag, inventory.path, "--repo", repository]);
      pending = plan.files.filter((f) => f !== inventory);
    }
  }
  if (pending.length)
    await run(["release", "upload", plan.tag, ...pending.map((f) => f.path), "--repo", repository]);
  const uploaded = JSON.parse(
    await run(["api", `repos/${repository}/releases`, "--paginate", "--slurp"]),
  )
    .flat()
    .find((release) => release.tag_name === plan.tag);
  const names = uploaded?.assets?.map((asset) => asset.name);
  if (
    !names ||
    names.length !== plan.files.length ||
    new Set(names).size !== names.length ||
    names.some((name) => !plan.files.some((file) => file.name === name))
  )
    throw new Error("Unexpected or missing uploaded asset; release remains draft");
  await verifyRemoteFiles(plan.files, plan.tag, run);
  if (publish) {
    const current = JSON.parse(
      await run(["api", `repos/${repository}/releases`, "--paginate", "--slurp"]),
    ).flat();
    if (current.some((r) => r.tag_name === plan.tag && !r.draft))
      throw new Error("Release already published; assets are immutable");
    assertReleaseIsNewer(current, version);
    await run([
      "release",
      "edit",
      plan.tag,
      "--repo",
      repository,
      "--draft=false",
      `--latest=${!plan.prerelease}`,
    ]);
  }
  console.log(
    `[release] ${publish ? "published" : "verified draft"}: https://github.com/${repository}/releases/tag/${plan.tag}`,
  );
  return plan;
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.includes("--help")) {
    console.log(
      "Usage: pnpm release:desktop --dir <artifacts> --version <X.Y.Z[-beta.N]> --notes <file> [--publish | --check] [--require-inventory] [--require-remote-assets] [--replace-draft-source-sha <old-sha>]",
    );
    return;
  }
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--publish" || arg === "--check") options[arg.slice(2)] = true;
    else if (arg === "--require-inventory") options.requireInventory = true;
    else if (arg === "--require-remote-assets") options.requireRemoteAssets = true;
    else if (
      ["--dir", "--version", "--notes", "--replace-draft-source-sha"].includes(arg) &&
      args[index + 1] &&
      !args[index + 1].startsWith("--")
    )
      options[arg === "--replace-draft-source-sha" ? "replaceDraftSourceSha" : arg.slice(2)] =
        args[++index];
    else throw new Error(`Invalid argument: ${arg}`);
  }
  if (
    !options.dir ||
    !options.version ||
    (!options.check && !options.notes) ||
    (options.check && options.publish)
  ) {
    throw new Error("Provide --dir, --version and --notes; --check is validation only");
  }
  if (options.notes) await stat(resolve(options.notes));
  await publishRelease({
    ...options,
    directory: resolve(options.dir),
    notes: options.notes && resolve(options.notes),
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`[release] ${error.message}`);
    process.exitCode = 1;
  });
}
