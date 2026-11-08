import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(`${APP}\\node_modules\\electron\\dist\\electron.exe`, ['.'], {
  cwd: APP,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
});
const out = fs.createWriteStream(`${APP}\\e.log`, { encoding: 'utf8' });
child.stdout.on('data', (d) => out.write(d));
child.stderr.on('data', (d) => out.write(d));
child.on('exit', (c) => { out.write(`\n[electron exit ${c}]\n`); out.end(); process.exit(0); });
child.on('error', (e) => { out.write(`\n[spawn error ${e.message}]\n`); });
fs.writeFileSync(`${APP}\\e_pid.txt`, String(child.pid));
setInterval(() => {}, 5000);
