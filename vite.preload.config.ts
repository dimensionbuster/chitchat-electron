import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        // Ensure preload script is not tree-shaken
        preserveEntrySignatures: 'strict',
      },
    },
  },
});
