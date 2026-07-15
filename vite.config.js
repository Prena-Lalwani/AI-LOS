import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Split the big third-party libs into their own long-cached chunks so
        // they aren't re-downloaded on deploys and don't bloat the entry chunk.
        // 'map' (Leaflet) only loads on the Dispatch route thanks to lazy().
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-charts': ['recharts'],
          'vendor-map': ['leaflet', 'react-leaflet'],
        },
      },
    },
  },
});
