import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Static build — deployable to Netlify / Render static sites / GitHub Pages.
// `base: './'` makes the bundle work from any subpath or even file://.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2020',
    rollupOptions: {
      output: {
        // Stable names (no content hashes) so re-deploying/re-copying the
        // dist folder never accumulates stale hashed files.
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/app.[ext]',
      },
    },
  },
});
