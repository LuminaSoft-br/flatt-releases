import { resolve } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { assertReleaseIsNewer, validateReleaseArtifacts } from "./release-artifacts.mjs";

const [directory, version] = process.argv.slice(2);
if (!directory || !version)
  throw new Error("Usage: node scripts/verify-release.mjs <directory> <version>");
const plan = await validateReleaseArtifacts(resolve(directory), version);
if (process.argv[4])
  assertReleaseIsNewer(JSON.parse(await readFile(process.argv[4], "utf8")).flat(), version);
const allowed = new Set(plan.files.map((file) => file.name));
for (const name of await readdir(directory)) {
  if (!allowed.has(name)) throw new Error(`Unexpected release asset: ${name}`);
}
console.log(`Verified ${plan.files.length} assets for ${plan.tag}`);
