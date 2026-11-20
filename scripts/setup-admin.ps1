param([string]$Username,[string]$Name,[string]$Database='var/production.db')
$ErrorActionPreference='Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
if (!$Username) { $Username=Read-Host '管理员登录名' }
if (!$Name) { $Name=Read-Host '管理员姓名' }
$password=Read-Host '初始密码（至少12位，不显示）' -AsSecureString
$pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
try {
 $env:ADMIN_INITIAL_USERNAME=$Username
 $env:ADMIN_INITIAL_NAME=$Name
 $env:ADMIN_INITIAL_PASSWORD=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
 $env:DB_PATH=$Database
 node scripts/setup-admin.cjs
 if ($LASTEXITCODE -ne 0) { throw '管理员初始化失败。' }
} finally {
 [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
 Remove-Item Env:ADMIN_INITIAL_PASSWORD -ErrorAction SilentlyContinue
 Remove-Item Env:ADMIN_INITIAL_USERNAME -ErrorAction SilentlyContinue
 Remove-Item Env:ADMIN_INITIAL_NAME -ErrorAction SilentlyContinue
}
