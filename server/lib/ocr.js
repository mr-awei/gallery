import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

/**
 * 图片文字识别（OCR）
 *
 * 为什么不用 tesseract.js：它要额外拉 15MB+ 的 wasm 与中英语言包，且中文识别质量在
 * 设计稿/截图场景明显不如系统引擎。Windows 10/11 自带 Windows.Media.Ocr（离线、
 * 随系统语言包走、零依赖、零下载），这里通过 Windows PowerShell 5.1 的 WinRT 投影调用。
 *
 * 已知边界（如实说明，不假装通用）：
 * - 仅 Windows 可用；系统没装中文识别语言包时中文识别率会下降，接口会把实际使用的
 *   语言回给前端展示；
 * - macOS/Linux 会返回 available:false，前端按钮置灰并说明原因，而不是转圈后报错；
 * - 只做静态图，gif/video/3d 不处理。
 */

const TIMEOUT_MS = 60000;

function powershellExe() {
  if (process.platform !== 'win32') return '';
  const win = process.env.SystemRoot || 'C:\\Windows';
  const p = path.join(win, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(p) ? p : 'powershell.exe';
}

export function ocrPlatformSupported() {
  return Boolean(powershellExe());
}

const PS_SCRIPT = (imgPath, wantLang) => `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  # 类型投影必须带正确的 WinRT 命名空间，写错会让后面的 Await 抛一句毫无线索的
  # 「使用“1”个参数调用“Wait”时发生异常」。
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType=WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]

  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
  })[0]
  function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
  }

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('${imgPath.replace(/'/g, "''")}')) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $langs = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
  $engine = $null
  $used = ''
  $want = '${wantLang}'
  if ($want -and ($langs -contains $want)) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($want))
    $used = $want
  }
  if (-not $engine) {
    foreach ($t in @('zh-Hans-CN','zh-Hans','zh-CN')) {
      if ($langs -contains $t) {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($t))
        if ($engine) { $used = $t; break }
      }
    }
  }
  if (-not $engine) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($engine) { $used = $engine.RecognizerLanguage.LanguageTag }
  }
  if (-not $engine) { throw '这台机器的系统 OCR 没有任何可用识别语言' }

  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @()
  foreach ($l in $result.Lines) { $lines += $l.Text }
  @{ ok = $true; engine = 'windows-ocr'; lang = $used; langs = $langs; text = $result.Text; lines = $lines } | ConvertTo-Json -Compress -Depth 4
} catch {
  @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

/** 中英混排时 OCR 常在汉字之间插空格（「设 计 稿」），这里只在两侧都是汉字时收掉 */
export function tidyOcrText(raw) {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/([\u4e00-\u9fa5])[ \t]+(?=[\u4e00-\u9fa5])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 识别一张本地图片。
 * @returns {Promise<{ok:boolean, text:string, lines:string[], lang:string, engine:string, error?:string}>}
 */
export async function ocrImage(absPath, { lang = '' } = {}) {
  const exe = powershellExe();
  if (!exe) {
    return { ok: false, error: '当前系统不支持系统 OCR（仅 Windows 可用）', text: '', lines: [], lang: '', engine: '' };
  }
  if (!absPath || !fs.existsSync(absPath)) {
    return { ok: false, error: '文件不存在', text: '', lines: [], lang: '', engine: '' };
  }
  // WinRT 的 GetFileFromPathAsync 只认 Windows 原生路径：正斜杠会让它抛
  // 一句「Wait 时发生异常」，所以这里必须先规范成反斜杠绝对路径。
  const winPath = process.platform === 'win32' ? path.win32.normalize(path.resolve(absPath)) : absPath;
  // EncodedCommand 走 UTF-16LE base64：路径里的空格/引号/中文都不会被 shell 拆坏
  const encoded = Buffer.from(PS_SCRIPT(winPath, lang), 'utf16le').toString('base64');
  const { stdout } = await new Promise((resolve, reject) => {
    execFile(
      exe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err, out, errOut) => {
        if (err) {
          // 超时/被杀：给一句能读懂的话，别把整个 stderr 甩给用户
          const msg = err.killed ? '识别超时（图片过大或系统 OCR 无响应）' : String(errOut || err.message || '识别失败').slice(0, 300);
          reject(new Error(msg));
          return;
        }
        resolve({ stdout: out });
      }
    );
  });

  let parsed;
  try {
    parsed = JSON.parse(String(stdout).trim());
  } catch {
    throw new Error('OCR 输出解析失败（系统组件返回了非预期内容）');
  }
  if (!parsed?.ok) throw new Error(parsed?.error || '系统 OCR 识别失败');
  return {
    ok: true,
    text: tidyOcrText(parsed.text),
    lines: (parsed.lines || []).map((s) => String(s)).filter(Boolean),
    lang: String(parsed.lang || ''),
    engine: String(parsed.engine || 'windows-ocr'),
  };
}
