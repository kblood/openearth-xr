import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { npmCli } from "./npm-cli.mjs";

const temporary = await mkdtemp(path.join(os.tmpdir(), "openearth-pack-"));

try {
  const [command, args] = npmCli([
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    temporary,
  ]);
  const output = execFileSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, npm_config_ignore_scripts: "true" },
    maxBuffer: 10 * 1024 * 1024,
  });
  const [packed] = parseJsonArraySuffix(output);
  if (!packed) throw new Error("npm pack returned no package metadata");
  const paths = new Set(packed.files.map((entry) => entry.path));
  const required = [
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "PRIVACY.md",
    "README.md",
    "SECURITY.md",
    "THIRD_PARTY_NOTICES.md",
    "dist-lib/adapters.js",
    "dist-lib/buildings.js",
    "dist-lib/core.js",
    "dist-lib/openearth.js",
    "dist-lib/openearth.js.map",
    "dist-lib/raster.js",
    "dist-lib/types/adapters/OpenMaps.d.ts",
    "dist-lib/types/entries/adapters.d.ts",
    "dist-lib/types/entries/buildings.d.ts",
    "dist-lib/types/entries/core.d.ts",
    "dist-lib/types/entries/raster.d.ts",
    "dist-lib/types/entries/xr.d.ts",
    "dist-lib/types/index.d.ts",
    "dist-lib/types/xr/XrSky.d.ts",
    "dist-lib/xr.js",
    "docs/integration.md",
    "docs/providers-and-licenses.md",
    "src/index.ts",
  ];
  for (const requiredPath of required) {
    if (!paths.has(requiredPath))
      throw new Error(`npm package is missing ${requiredPath}`);
  }
  for (const browserOnlyPath of [
    "dist-lib/manifest.webmanifest",
    "dist-lib/openearth-icon.svg",
    "dist-lib/sw.js",
  ]) {
    if (paths.has(browserOnlyPath))
      throw new Error(
        `npm library contains browser-only asset ${browserOnlyPath}`,
      );
  }

  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  for (const [subpath, conditions] of Object.entries(packageJson.exports)) {
    if (subpath === "./package.json") continue;
    for (const condition of ["types", "import", "default"]) {
      const target = String(conditions[condition]).replace(/^\.\//, "");
      if (!paths.has(target))
        throw new Error(
          `Package export ${subpath} (${condition}) is missing ${target}`,
        );
    }
  }

  const runtimeChecks = {
    adapters: ["OpenMapsRasterProvider", "createOpenEarthRegionProvider"],
    buildings: ["MvtBuildingProvider"],
    core: ["normalizeView"],
    raster: ["CompositeXyzTileProvider"],
    xr: ["XrGlobeRenderer", "createXrStarField"],
  };
  for (const [subpath, expectedNames] of Object.entries(runtimeChecks)) {
    const entry = await import(`${packageJson.name}/${subpath}`);
    for (const expected of expectedNames) {
      if (!(expected in entry))
        throw new Error(`Runtime export ${subpath} is missing ${expected}`);
    }
  }

  const maps = [...paths].filter(
    (entry) => entry.startsWith("dist-lib/") && entry.endsWith(".js.map"),
  );
  if (maps.length === 0)
    throw new Error("npm library has no JavaScript source maps");
  for (const mapPath of maps) {
    const sourceMap = JSON.parse(await readFile(mapPath, "utf8"));
    for (const [index, source] of (sourceMap.sources ?? []).entries()) {
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(mapPath), source),
      );
      const embedded = typeof sourceMap.sourcesContent?.[index] === "string";
      if (!paths.has(target) && !embedded)
        throw new Error(
          `JavaScript source map target is unavailable: ${target}`,
        );
    }
  }
  if (packed.size > 500_000)
    throw new Error(`Packed library budget exceeded: ${packed.size} bytes`);
  console.log(
    `Verified ${packed.filename} (${packed.entryCount} files, ${packed.size} bytes).`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}

/** npm 10 can prefix --json output with lifecycle stdout even with ignore-scripts. */
function parseJsonArraySuffix(output) {
  const trimmed = output.trim();
  for (
    let start = trimmed.lastIndexOf("[");
    start >= 0;
    start = trimmed.lastIndexOf("[", start - 1)
  ) {
    try {
      const value = JSON.parse(trimmed.slice(start));
      if (Array.isArray(value)) return value;
    } catch {
      // Continue backwards until the top-level npm metadata array is found.
    }
  }
  throw new Error("npm pack did not emit a valid JSON metadata array");
}
