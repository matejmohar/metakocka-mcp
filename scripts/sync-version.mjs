// Copies the version from package.json into manifest.json and src/version.ts.
// Runs automatically on `npm version <x>`.
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = version;
writeFileSync("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

writeFileSync(
  "src/version.ts",
  `// Keep in sync with package.json (scripts/sync-version.mjs does it on \`npm version\`).\nexport const VERSION = "${version}";\n`,
);
console.log(`Synced version ${version}`);
