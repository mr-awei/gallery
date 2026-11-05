$root = 'e:\gemvault'
Set-Location $root
$files = git ls-files | Where-Object { $_ -match '\.(js|mjs|cjs|ts|tsx|jsx|json|md|yml|yaml|html|css|txt)$' -and $_ -ne 'package-lock.json' }
$rules = @(
  @('GemEnhance', 'TuKuEnhance'),
  @('gemRoute', 'tukuRoute'),
  @('gemcover-', 'tukucover-'),
  @('gemfont-', 'tukufont-'),
  @('gemr=', 'tukur='),
  @('gem.', 'tuku.'),
  @('gem.mp4', 'wallpaper.mp4'),
  @('id="gem"', 'id="tuku"'),
  @('url(#gem)', 'url(#tuku)')
)
$changed = @()
foreach ($f in $files) {
  $p = Join-Path $root $f
  if (-not (Test-Path $p)) { continue }
  $text = Get-Content $p -Raw -Encoding UTF8
  $orig = $text
  foreach ($r in $rules) { $text = $text.Replace($r[0], $r[1]) }
  if ($text -ne $orig) {
    [System.IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding($false)))
    $changed += $f
  }
}
"changed $($changed.Count) files:"
$changed
