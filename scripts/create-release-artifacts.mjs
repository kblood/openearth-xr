import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { npmCli } from "./npm-cli.mjs";

const root = process.cwd();
const output = path.join(root, "release-artifacts");
const packageJson = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const version = packageJson.version;
const tar = process.platform === "win32" ? "tar.exe" : "tar";

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
execFileSync(process.execPath, ["scripts/create-site-manifest.mjs"], {
  cwd: root,
  stdio: "inherit",
});
const [npmPack, npmPackArgs] = npmCli([
  "pack",
  "--ignore-scripts",
  "--pack-destination",
  output,
]);
execFileSync(npmPack, npmPackArgs, {
  cwd: root,
  stdio: "inherit",
});

const siteArchive = path.join(output, `openearth-site-v${version}.tar.gz`);
execFileSync(tar, ["-czf", siteArchive, "-C", path.join(root, "dist"), "."], {
  cwd: root,
  stdio: "inherit",
});

const [npmSbom, npmSbomArgs] = npmCli([
  "sbom",
  "--omit=dev",
  "--sbom-format=cyclonedx",
]);
const sbom = spawnSync(npmSbom, npmSbomArgs, {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 50 * 1024 * 1024,
});
if (sbom.status !== 0) throw new Error(`npm sbom failed:\n${sbom.stderr}`);
await writeFile(
  path.join(output, `openearth-v${version}.cdx.json`),
  sbom.stdout,
);

const files = (await readdir(output))
  .filter((name) => name !== "SHA256SUMS")
  .sort();
const sums = [];
for (const name of files) {
  const digest = createHash("sha256")
    .update(await readFile(path.join(output, name)))
    .digest("hex");
  sums.push(`${digest}  ${name}`);
}
await writeFile(path.join(output, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log(`Created ${files.length} release artifacts in ${output}`);
