import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
  base: "./",
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: "node_modules/cesium/Build/Cesium/Workers/**/*",
          dest: "cesium",
          rename: { stripBase: 4 },
        },
        {
          src: "node_modules/cesium/Build/Cesium/ThirdParty/**/*",
          dest: "cesium",
          rename: { stripBase: 4 },
        },
        {
          src: "node_modules/cesium/Build/Cesium/Assets/**/*",
          dest: "cesium",
          rename: { stripBase: 4 },
        },
        {
          src: "node_modules/cesium/Build/Cesium/Widgets/**/*",
          dest: "cesium",
          rename: { stripBase: 4 },
        },
      ],
    }),
    {
      name: "copy-deployment-config",
      apply: "build",
      async writeBundle(options) {
        const outputDirectory = resolve(options.dir ?? "dist");
        const copies = [
          ["deploy/.htaccess", ".htaccess"],
          ["LICENSE", "LICENSE"],
          ["PRIVACY.md", "PRIVACY.md"],
          ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
          ["node_modules/cesium/LICENSE.md", "third-party/cesium/LICENSE.md"],
          [
            "node_modules/cesium/ThirdParty.json",
            "third-party/cesium/ThirdParty.json",
          ],
          [
            "node_modules/cesium/ThirdParty.extra.json",
            "third-party/cesium/ThirdParty.extra.json",
          ],
          ["node_modules/three/LICENSE", "third-party/three/LICENSE"],
          [
            "node_modules/@mapbox/vector-tile/LICENSE.txt",
            "third-party/mapbox-vector-tile/LICENSE.txt",
          ],
          [
            "node_modules/@mapbox/point-geometry/LICENSE",
            "third-party/mapbox-point-geometry/LICENSE",
          ],
          ["node_modules/pbf/LICENSE", "third-party/pbf/LICENSE"],
          [
            "node_modules/resolve-protobuf-schema/LICENSE",
            "third-party/resolve-protobuf-schema/LICENSE",
          ],
          [
            "node_modules/protocol-buffers-schema/LICENSE",
            "third-party/protocol-buffers-schema/LICENSE",
          ],
        ] as const;
        await Promise.all(
          copies.map(async ([source, destination]) => {
            const output = resolve(outputDirectory, destination);
            await mkdir(dirname(output), { recursive: true });
            await copyFile(resolve(source), output);
          }),
        );
      },
    },
  ],
});
