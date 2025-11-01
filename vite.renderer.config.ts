import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vitejs.dev/config
export default defineConfig({
  plugins: [vue(), vueDevTools()],
  // Don't set root - use the Electron project root
  // This ensures preload script works correctly
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./chitchat-web/src', import.meta.url)),
    },
  },
  // Use a relative base so built asset URLs work under the file:// protocol in Electron
  base: './',
  build: {
    outDir: '.vite/renderer/main_window',
    emptyOutDir: true,
  },
})