import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");
const required = [
  ".htaccess",
  "index.html",
  "LICENSE",
  "manifest.webmanifest",
  "openearth-icon.svg",
  "PRIVACY.md",
  "sw.js",
  "THIRD_PARTY_NOTICES.md",
  "cesium/Workers/createGeometry.js",
  "cesium/Assets/approximateTerrainHeights.json",
  "third-party/cesium/LICENSE.md",
  "third-party/mapbox-point-geometry/LICENSE",
  "third-party/mapbox-vector-tile/LICENSE.txt",
  "third-party/pbf/LICENSE",
  "third-party/protocol-buffers-schema/LICENSE",
  "third-party/resolve-protobuf-schema/LICENSE",
  "third-party/three/LICENSE",
];

for (const relative of required) {
  const file = path.join(dist, relative);
  if (!(await isFile(file)))
    throw new Error(`Browser build is missing ${relative}`);
}

const html = await readFile(path.join(dist, "index.html"), "utf8");
if (html.includes("/src/"))
  throw new Error("Production index still references a source entrypoint");
if (!html.includes("./assets/"))
  throw new Error("Production assets are not subdirectory-safe relative URLs");

const manifest = JSON.parse(
  await readFile(path.join(dist, "manifest.webmanifest"), "utf8"),
);
if (manifest.start_url !== "./" || manifest.scope !== "./")
  throw new Error("PWA manifest is not subdirectory-safe");
for (const icon of manifest.icons ?? []) {
  const iconPath = String(icon.src).replace(/^\.\//, "");
  if (!(await isFile(path.join(dist, iconPath))))
    throw new Error(`PWA manifest icon is missing: ${iconPath}`);
}

const serviceWorker = await readFile(path.join(dist, "sw.js"), "utf8");
if (!serviceWorker.includes("url.origin !== self.location.origin"))
  throw new Error(
    "Service worker does not enforce same-origin runtime caching",
  );
for (const cacheBoundary of [
  "CACHE_PREFIX = 'openearth-'",
  "SHELL_CACHE",
  "RUNTIME_CACHE",
  "key.startsWith(CACHE_PREFIX)",
]) {
  if (!serviceWorker.includes(cacheBoundary))
    throw new Error(
      `Service worker cache boundary is missing: ${cacheBoundary}`,
    );
}
for (const forbiddenHost of [
  "tile.openstreetmap.org",
  "basemaps.cartocdn.com",
  "tiles.openfreemap.org",
  "nominatim.openstreetmap.org",
]) {
  if (serviceWorker.includes(forbiddenHost))
    throw new Error(
      `Service worker must not cache third-party data: ${forbiddenHost}`,
    );
}

const apacheConfig = await readFile(path.join(dist, ".htaccess"), "utf8");
for (const expectedPolicy of [
  "application/manifest+json",
  "geolocation=(self)",
  "xr-spatial-tracking=(self)",
  "https://nominatim.openstreetmap.org",
]) {
  if (!apacheConfig.includes(expectedPolicy))
    throw new Error(`Deployment headers are missing: ${expectedPolicy}`);
}

const assetFiles = await walk(path.join(dist, "assets"));
const scripts = assetFiles.filter((file) => file.endsWith(".js"));
const styles = assetFiles.filter((file) => file.endsWith(".css"));
if (scripts.length === 0 || styles.length === 0)
  throw new Error("Production JS or CSS asset is missing");

const largestScript = Math.max(
  ...(await Promise.all(scripts.map(async (file) => (await stat(file)).size))),
);
if (largestScript > 5_250_000) {
  throw new Error(
    `Initial JavaScript budget exceeded: ${largestScript.toLocaleString()} bytes`,
  );
}

console.log(
  `Verified browser distribution (${scripts.length} JS, ${styles.length} CSS, largest JS ${largestScript} bytes).`,
);

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(target)));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}
