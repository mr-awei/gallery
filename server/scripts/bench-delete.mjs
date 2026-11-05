const fs = require('fs');
const { execSync } = require('child_process');
console.log('kb.js mtime:', fs.statSync('server/kb.js').mtime.toLocaleString());
const out = execSync(
  `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Select-Object ProcessId,CreationDate | Format-Table -AutoSize"`,
  { encoding: 'utf8' }
);
console.log(out);
