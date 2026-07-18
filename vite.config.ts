import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  base: './',
  plugins: [
    viteStaticCopy({
      targets: [
        { src: 'node_modules/cesium/Build/Cesium/Workers/**/*', dest: 'cesium', rename: { stripBase: 4 } },
        { src: 'node_modules/cesium/Build/Cesium/ThirdParty/**/*', dest: 'cesium', rename: { stripBase: 4 } },
        { src: 'node_modules/cesium/Build/Cesium/Assets/**/*', dest: 'cesium', rename: { stripBase: 4 } },
        { src: 'node_modules/cesium/Build/Cesium/Widgets/**/*', dest: 'cesium', rename: { stripBase: 4 } },
      ],
    }),
  ],
});
