$root = 'e:\gemvault'
Set-Location $root
$files = git ls-files | Where-Object { $_ -match '\.(js|mjs|cjs|ts|tsx|jsx|json|md|yml|yaml|html|css|txt)$' -and $_ -ne 'package-lock.json' }
$rules = @(
  @('Gallery-Setup-', 'TuKu-Setup-'),
  @('com.gem.gallery', 'com.tuku.gallery'),
  @('gem-gallery', 'tuku-gallery'),
  @('GemDesktop', 'TukuDesktop'),
  @('GemLive', 'TukuLive'),
  @('GemVault', 'TuKu'),
  @('GEM_', 'TUKU_'),
  @('.gemvault', '.tuku'),
  @('gem_', 'tuku_'),
  @('gem-', 'tuku-'),
  @('gem:', 'tuku:'),
  @('gemPort', 'tukuPort'),
  @('__gem', '__tuku')
)
$changed = @()
foreach ($f in $files) {
  $p = Join-Path $root $f
  if (-not (Test-Path $p)) { continue }
  $text = Get-Content $p -Raw -Encoding UTF8
  $orig = $text
  foreach ($r in $rules) { $text = $text.Replace($r[0], $r[1]) }
  # 项目目录本身叫 gemvault（磁盘路径），只替换独立出现的标识
  $text = [regex]::Replace($text, '(?<![/\\])gemvault(?![\\/])', 'tuku')
  if ($text -ne $orig) {
    [System.IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding($false)))
    $changed += $f
  }
}
"changed $($changed.Count) files:"
$changed
