import { readFileSync, writeFileSync } from 'node:fs';

const zh = {
  saveFile: '保存文件',
  save: '保存',
  saveCanceled: '已取消保存',
  saveClip: '保存视频片段',
  saveDiagnostics: '保存诊断包',
  gif: 'GIF 动图',
  webm: 'WebM 视频',
  noLogDir: '暂无可用的日志目录',
  pickStorageDir: '选择图片保存文件夹',
  pickFile: '选择文件',
};
const en = {
  saveFile: 'Save file',
  save: 'Save',
  saveCanceled: 'Save canceled',
  saveClip: 'Save video clip',
  saveDiagnostics: 'Save diagnostics bundle',
  gif: 'GIF animation',
  webm: 'WebM video',
  noLogDir: 'No log directory available',
  pickStorageDir: 'Choose image folder',
  pickFile: 'Choose file',
};

for (const [f, d] of [['zh-CN', zh], ['en-US', en]]) {
  const p = `web/src/locales/${f}.json`;
  const j = JSON.parse(readFileSync(p, 'utf8'));
  j.dialog = { ...(j.dialog || {}), ...d };
  writeFileSync(p, JSON.stringify(j, null, 2) + '\n', 'utf8');
  console.log(f, 'dialog keys:', Object.keys(j.dialog).length);
}
