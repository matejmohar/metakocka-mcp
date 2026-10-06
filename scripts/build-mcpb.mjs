// Builds dist/ and packs a self-contained .mcpb bundle into release/.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
if (manifest.version !== version) {
  throw new Error(`manifest.json version ${manifest.version} != package.json ${version}. Run: node scripts/sync-version.mjs`);
}

const stage = "build/mcpb";
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
mkdirSync("release", { recursive: true });

run("npm", ["run", "build"]);
cpSync("dist", `${stage}/dist`, { recursive: true });
for (const f of ["manifest.json", "package.json", "package-lock.json", "LICENSE", "README.md"]) cpSync(f, `${stage}/${f}`);
run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage });

const out = `release/metakocka-mcp-${version}.mcpb`;
run("npx", ["mcpb", "validate", `${stage}/manifest.json`]);
run("npx", ["mcpb", "pack", stage, out]);
console.log(`\nBuilt ${out}`);
