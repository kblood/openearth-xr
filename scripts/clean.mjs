import { readFile, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
if (packageJson.name !== "openearth-xr") {
  throw new Error(
    `Refusing to clean unexpected package '${packageJson.name ?? "unknown"}'`,
  );
}

const targets = {
  all: ["dist", "dist-lib", "coverage", "playwright-report", "test-results"],
  app: ["dist"],
  lib: ["dist-lib"],
};
const selection = process.argv[2] ?? "all";
const selectedTargets = targets[selection];
if (!selectedTargets) throw new Error(`Unknown clean target '${selection}'`);

for (const relative of selectedTargets) {
  const resolved = path.resolve(root, relative);
  if (path.dirname(resolved) !== root)
    throw new Error(`Unsafe clean target '${resolved}'`);
  await rm(resolved, { recursive: true, force: true });
}
