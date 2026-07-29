import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (!tag) throw new Error("Pass a release tag or set GITHUB_REF_NAME");
if (tag !== `v${packageJson.version}`) {
  throw new Error(
    `Tag '${tag}' does not match package version '${packageJson.version}'`,
  );
}
console.log(`${tag} matches package.json.`);
