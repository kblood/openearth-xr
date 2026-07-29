import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist-lib",
    // build:lib removes this directory before declarations are emitted. Vite
    // must preserve those declarations while it writes the ESM bundle.
    emptyOutDir: false,
    sourcemap: true,
    lib: {
      entry: {
        index: "src/index.ts",
        adapters: "src/entries/adapters.ts",
        buildings: "src/entries/buildings.ts",
        core: "src/entries/core.ts",
        raster: "src/entries/raster.ts",
        xr: "src/entries/xr.ts",
      },
      formats: ["es"],
      fileName: (_format, entryName) =>
        entryName === "index" ? "openearth.js" : `${entryName}.js`,
    },
    rollupOptions: {
      // Host applications keep one Cesium and Three.js runtime. This avoids
      // multi-megabyte duplicate engines and WebXR singleton conflicts.
      external: [
        /^@mapbox\/vector-tile(?:\/|$)/,
        /^cesium(?:\/|$)/,
        /^pbf(?:\/|$)/,
        /^three(?:\/|$)/,
      ],
    },
  },
});
