import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist-lib',
    emptyOutDir: false,
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'openearth.js',
    },
    rollupOptions: {
      // Host applications keep one Cesium and Three.js runtime. This avoids
      // multi-megabyte duplicate engines and WebXR singleton conflicts.
      external: [/^cesium(?:\/|$)/, /^three(?:\/|$)/],
    },
  },
});
