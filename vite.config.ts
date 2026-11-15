import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    /**
     * 之前是空配置：所有页面、27 个对话框、灯箱文案全打进一个 1.29MB 的
     * index chunk，冷启动要先把它们全解析完才能出首屏（低配机器尤其明显）。
     *
     * 只把 React 运行时单独拆出去（浏览器缓存友好、升级动画/图表库时不必失效）；
     * 其余依赖**不**做 vendor 兜底 —— 手动聚合会把 three.js / 图表这类本该
     * 随页面按需加载的重库提成静态 chunk，首屏反而更慢。
     */
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          const p = id.slice(id.indexOf('node_modules')).replace(/\\/g, '/');
          if (/^node_modules\/(react|react-dom|scheduler|use-sync-external-store)\//.test(p)) return 'react';
          return undefined;
        },
      },
    },
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
