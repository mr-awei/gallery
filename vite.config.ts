import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // 后端地址可用环境变量覆盖（多实例/测试时用），默认 3001
      '/api': process.env.TUKU_API_PROXY || 'http://localhost:3001',
      '/files': process.env.TUKU_API_PROXY || 'http://localhost:3001',
    },
  },
});
