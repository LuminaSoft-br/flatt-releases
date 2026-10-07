import { resolve } from "node:path";
import { validateReleaseArtifacts } from "./release-artifacts.mjs";

const [directory, version] = process.argv.slice(2);
if (!directory || !version) throw new Error("Usage: node scripts/verify-release.mjs <directory> <version>");
const plan = await validateReleaseArtifacts(resolve(directory), version);
console.log(`Verified ${plan.files.length} assets for ${plan.tag}`);
