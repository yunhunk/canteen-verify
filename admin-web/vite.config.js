import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5311,
    proxy: {
      // 开发环境走代理，避免浏览器跨域 + 不用在后端开 CORS
      '/api': {
        target: 'http://127.0.0.1:3311',
        changeOrigin: true,
      },
    },
  },
});
