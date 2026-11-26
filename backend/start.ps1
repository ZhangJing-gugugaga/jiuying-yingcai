param([switch]$Test)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$nodeCommand = Get-Command node -ErrorAction Stop
$taskNodeVersion = [version]((& $nodeCommand.Source -p 'process.versions.node') | Select-Object -Last 1)
if ($taskNodeVersion.Major -ne 24 -or $taskNodeVersion -lt [version]'24.19.0') { throw 'This project requires Node.js 24.19.0 or later within Node 24.' }
if (Test-Path -LiteralPath '.env') {
  foreach ($envLine in Get-Content -LiteralPath '.env' -Encoding UTF8) {
    $envTrimmed = $envLine.Trim()
    if (!$envTrimmed -or $envTrimmed.StartsWith('#')) { continue }
    if ($envTrimmed -notmatch '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { throw 'Invalid .env entry.' }
    $envKey = $Matches[1]
    $envValue = $Matches[2].Trim()
    if ($envValue.Length -ge 2 -and (($envValue.StartsWith('"') -and $envValue.EndsWith('"')) -or ($envValue.StartsWith("'") -and $envValue.EndsWith("'")))) { $envValue = $envValue.Substring(1, $envValue.Length - 2) }
    [Environment]::SetEnvironmentVariable($envKey, $envValue, 'Process')
  }
}
if ($Test) {
  $testFiles = @(Get-ChildItem -LiteralPath 'tests' -Filter '*.test.cjs' -File | ForEach-Object { $_.FullName })
  if (!$testFiles.Count) { throw 'No automated test files exist yet.' }
  & $nodeCommand.Source --test @testFiles
} else {
  & $nodeCommand.Source 'server/index.cjs'
}
exit $LASTEXITCODE
