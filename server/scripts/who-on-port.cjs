const { execSync } = require('child_process');
const fs = require('fs');
const net = execSync('netstat -ano | findstr :3001 | findstr LISTENING', { encoding: 'utf8' });
console.log(net.trim());
const pid = net.trim().split(/\s+/).pop();
const out = execSync(
  `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"ProcessId=${pid}\\" | Select-Object ProcessId,CreationDate,CommandLine | Format-List"`,
  { encoding: 'utf8' }
);
console.log(out);
// 相对仓库根跑（npm run 的 cwd）
console.log('library.js mtime:', fs.statSync('server/library.js').mtime.toLocaleString());
console.log('app.js     mtime:', fs.statSync('server/app.js').mtime.toLocaleString());
