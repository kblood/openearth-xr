import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");
const packageJson = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
  encoding: "utf8",
}).trim();
const releaseId =
  process.env.OPENEARTH_RELEASE_ID ?? `v${packageJson.version}-${commit}`;
if (!/^[A-Za-z0-9._-]+$/.test(releaseId))
  throw new Error(`Unsafe release id '${releaseId}'`);

await writeFile(
  path.join(dist, "release.json"),
  `${JSON.stringify({ name: packageJson.name, version: packageJson.version, commit, releaseId, builtAt: new Date().toISOString() }, null, 2)}\n`,
);

const checksumPath = path.join(dist, "SHA256SUMS");
const files = (await walk(dist))
  .filter((file) => file !== checksumPath)
  .sort((left, right) => left.localeCompare(right));
const checksums = [];
for (const file of files) {
  const digest = createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
  const relative = path.relative(dist, file).split(path.sep).join("/");
  checksums.push(`${digest}  ./${relative}`);
}
await writeFile(checksumPath, `${checksums.join("\n")}\n`);
console.log(releaseId);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(target)));
    else if (entry.isFile() && (await stat(target)).isFile())
      files.push(target);
  }
  return files;
}
