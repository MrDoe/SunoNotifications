import fs from "node:fs";
import path from "node:path";

const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const manifestPath = path.join(workspaceRoot, "firefox-plugin", "manifest.json");

function bumpVersion(version) {
  const parts = version.split(".");

  if (parts.length < 2 || parts.length > 4 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new Error(`Unsupported version format: ${version}. Expected 2-4 numeric segments like 0.9.4`);
  }

  const nums = parts.map((p) => Number.parseInt(p, 10));
  nums[nums.length - 1] += 1;

  return nums.join(".");
}

function main() {
  const raw = fs.readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw);

  if (!manifest.version || typeof manifest.version !== "string") {
    throw new Error("manifest.json has no valid string 'version' field");
  }

  const oldVersion = manifest.version;
  const newVersion = bumpVersion(oldVersion);

  manifest.version = newVersion;

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Firefox manifest version bumped: ${oldVersion} -> ${newVersion}`);
}

try {
  main();
} catch (err) {
  console.error(`Version bump failed: ${err.message}`);
  process.exit(1);
}
