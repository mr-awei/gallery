// @ts-check
import { checkRuntime, downloadInstaller, runInstaller } from '../lib/runtime-check.js';
import { logOp } from '../oplog.js';

/** 下载进度 + 安装状态（模块级，单线程足够） */
const state = {}; // { [id]: { status, progress, message, error, needsReboot } }

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  /** 获取运行环境当前状态（检测是否装了 VC++ / DirectML / sharp / onnxruntime） */
  app.get('/api/runtime', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...checkRuntime(), state });
  });

  /** 下载某个组件的安装器 */
  app.post(
    '/api/runtime/:id/download',
    asyncRoute(async (req, res) => {
      const id = String(req.params.id || '');
      state[id] = { status: 'downloading', progress: 0, message: '准备下载…', error: '', needsReboot: false };
      // 后台异步跑，HTTP 立即返回
      downloadInstaller(id, {
        onProgress: ({ progress, message }) => {
          if (state[id]) {
            state[id].progress = progress;
            state[id].message = message;
          }
        },
      })
        .then((r) => {
          if (state[id]) {
            state[id].status = 'downloaded';
            state[id].progress = 100;
            state[id].message = '下载完成';
          }
        })
        .catch((err) => {
          if (state[id]) {
            state[id].status = 'error';
            state[id].error = err?.message ? String(err.message).slice(0, 300) : String(err).slice(0, 300);
          }
        });
      res.json({ ok: true, started: true });
    })
  );

  /** 静默执行安装器（需要用户确认 UAC） */
  app.post(
    '/api/runtime/:id/install',
    asyncRoute(async (req, res) => {
      const id = String(req.params.id || '');
      if (state[id]?.status !== 'downloaded') {
        // 还没下载就顺手下一次
        state[id] = { status: 'downloading', progress: 0, message: '下载安装器…', error: '', needsReboot: false };
        try {
          await downloadInstaller(id, {
            onProgress: ({ progress, message }) => {
              if (state[id]) { state[id].progress = progress; state[id].message = message; }
            },
          });
        } catch (err) {
          if (state[id]) { state[id].status = 'error'; state[id].error = String(err?.message || err); }
          return res.status(400).json({ ok: false, error: String(err?.message || err) });
        }
      }
      state[id].status = 'installing';
      state[id].message = '安装中（可能弹出 UAC 确认）…';
      try {
        const r = await runInstaller(id);
        state[id] = { status: 'done', progress: 100, message: r.needsReboot ? '安装完成，建议重启系统' : '安装完成', error: '', needsReboot: r.needsReboot };
        logOp({ op: 'runtime-install', summary: id });
        res.json({ ok: true, ...r });
      } catch (err) {
        state[id] = { status: 'error', error: String(err?.message || err), needsReboot: false };
        res.status(400).json({ ok: false, error: String(err?.message || err) });
      }
    })
  );
}
