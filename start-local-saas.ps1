param(
  [string]$CatalogDatabase = "bobo_saas_catalog_local",
  [string]$CatalogDatabaseUser = "bobo_saas_catalog_app",
  [string]$TenantSlug = "future-machinery",
  [string]$TenantDatabase = "bobo_tenant_future_machinery",
  [string]$TenantDatabaseUser = "bobo_tenant_future_machinery_app",
  [string]$DatabaseHost = "127.0.0.1",
  [int]$DatabasePort = 3306,
  [int]$AppPort = 3002,
  [switch]$ResetCredentials
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodeExecutable = if ($nodeCommand) { $nodeCommand.Source } else { "" }
if (-not $nodeExecutable) {
  $bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if (Test-Path $bundledNode) { $nodeExecutable = $bundledNode }
}
if (-not $nodeExecutable) { throw "Node.js was not found. Install Node.js LTS and reopen PowerShell." }
if (-not (Test-NetConnection -ComputerName $DatabaseHost -Port $DatabasePort -InformationLevel Quiet)) {
  throw "Cannot connect to MySQL at ${DatabaseHost}:$DatabasePort. Start MySQL or specify the correct address and port."
}
if (-not (Test-Path (Join-Path $projectRoot "node_modules\mysql2"))) {
  throw "Project dependencies are missing. Install them with pnpm install --frozen-lockfile."
}

$settingsDirectory = Join-Path $env:LOCALAPPDATA "FutureMachinery\BoboSaaS"
$settingsPath = Join-Path $settingsDirectory "local-secrets.json"
$settings = $null
if ((Test-Path $settingsPath) -and -not $ResetCredentials) {
  try { $settings = Get-Content -Raw -LiteralPath $settingsPath | ConvertFrom-Json }
  catch { throw "Saved local credentials cannot be read. Run with -ResetCredentials to set them again." }
}

if (-not $settings) {
  Write-Host "首次运行需要保存平台目录和未来机械独立租户库的凭据；之后双击启动不再询问。"
  $catalogPasswordSecure = Read-Host "SaaS catalog MySQL password" -AsSecureString
  $tenantPasswordSecure = Read-Host "Future Machinery tenant MySQL password" -AsSecureString
  $tenantAdminName = Read-Host "Future Machinery initial admin name"
  $tenantAdminPhone = Read-Host "Future Machinery initial admin phone"
  $tenantAdminPasswordSecure = Read-Host "Future Machinery initial admin password, minimum 8 characters" -AsSecureString
  if ($tenantAdminPasswordSecure.Length -lt 8) { throw "Future Machinery initial admin password must contain at least 8 characters." }
  $platformUser = Read-Host "Platform admin username [platform-admin]"
  if ([string]::IsNullOrWhiteSpace($platformUser)) { $platformUser = "platform-admin" }
  $platformPasswordSecure = Read-Host "Platform admin password, minimum 12 characters" -AsSecureString
  if ($platformPasswordSecure.Length -lt 12) { throw "Platform admin password must contain at least 12 characters." }

  $secretBytes = New-Object byte[] 48
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($secretBytes) } finally { $random.Dispose() }
  $sessionSecret = [Convert]::ToBase64String($secretBytes)
  $tvSecretBytes = New-Object byte[] 48
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($tvSecretBytes) } finally { $random.Dispose() }

  New-Item -ItemType Directory -Path $settingsDirectory -Force | Out-Null
  $settings = [ordered]@{
    catalogPassword = ConvertFrom-SecureString $catalogPasswordSecure
    tenantPassword = ConvertFrom-SecureString $tenantPasswordSecure
    tenantAdminName = $tenantAdminName
    tenantAdminPhone = $tenantAdminPhone
    tenantAdminPassword = ConvertFrom-SecureString $tenantAdminPasswordSecure
    platformUser = $platformUser
    platformPassword = ConvertFrom-SecureString $platformPasswordSecure
    sessionSecret = $sessionSecret
    tvSecret = [Convert]::ToBase64String($tvSecretBytes)
  }
  $temporaryPath = "$settingsPath.tmp"
  $settings | ConvertTo-Json | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
  Move-Item -LiteralPath $temporaryPath -Destination $settingsPath -Force
}

$catalogPasswordValue = [string]$settings.catalogPassword
if (-not $catalogPasswordValue) {
  Write-Host "平台目录库已与旧本地数据库分离，请输入新目录库应用账号的密码。"
  $catalogPasswordSecure = Read-Host "SaaS catalog MySQL password" -AsSecureString
  $settings | Add-Member -MemberType NoteProperty -Name catalogPassword -Value (ConvertFrom-SecureString $catalogPasswordSecure) -Force
  $catalogPasswordValue = [string]$settings.catalogPassword
  $settings | ConvertTo-Json | Set-Content -LiteralPath $settingsPath -Encoding UTF8
}
if (-not $settings.tenantPassword) {
  Write-Host "请先按 docs/local-mysql-startup.md 预配未来机械独立租户库。此密码只需保存一次。"
  $tenantPasswordSecure = Read-Host "Future Machinery tenant MySQL password" -AsSecureString
  $settings | Add-Member -MemberType NoteProperty -Name tenantPassword -Value (ConvertFrom-SecureString $tenantPasswordSecure) -Force
  $settings | ConvertTo-Json | Set-Content -LiteralPath $settingsPath -Encoding UTF8
}
if (-not $settings.tenantAdminPassword) {
  $tenantAdminName = Read-Host "Future Machinery initial admin name"
  $tenantAdminPhone = Read-Host "Future Machinery initial admin phone"
  $tenantAdminPasswordSecure = Read-Host "Future Machinery initial admin password, minimum 8 characters" -AsSecureString
  if ($tenantAdminPasswordSecure.Length -lt 8) { throw "Future Machinery initial admin password must contain at least 8 characters." }
  $settings | Add-Member -MemberType NoteProperty -Name tenantAdminName -Value $tenantAdminName -Force
  $settings | Add-Member -MemberType NoteProperty -Name tenantAdminPhone -Value $tenantAdminPhone -Force
  $settings | Add-Member -MemberType NoteProperty -Name tenantAdminPassword -Value (ConvertFrom-SecureString $tenantAdminPasswordSecure) -Force
  $settings | ConvertTo-Json | Set-Content -LiteralPath $settingsPath -Encoding UTF8
}
if (-not $settings.tenantProvisionerUser) {
  $tenantProvisionerUser = Read-Host "MySQL tenant database provisioner user [root]"
  if ([string]::IsNullOrWhiteSpace($tenantProvisionerUser)) { $tenantProvisionerUser = "root" }
  $settings | Add-Member -MemberType NoteProperty -Name tenantProvisionerUser -Value $tenantProvisionerUser -Force
}
if (-not $settings.tenantProvisionerPassword) {
  $tenantProvisionerPasswordSecure = Read-Host "MySQL tenant database provisioner password" -AsSecureString
  $settings | Add-Member -MemberType NoteProperty -Name tenantProvisionerPassword -Value (ConvertFrom-SecureString $tenantProvisionerPasswordSecure) -Force
}
if (-not $settings.tenantCredentialSecret) {
  $tenantCredentialBytes = New-Object byte[] 48
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($tenantCredentialBytes) } finally { $random.Dispose() }
  $tenantCredentialSecretText = [Convert]::ToBase64String($tenantCredentialBytes)
  $tenantCredentialSecretSecure = ConvertTo-SecureString $tenantCredentialSecretText -AsPlainText -Force
  $settings | Add-Member -MemberType NoteProperty -Name tenantCredentialSecret -Value (ConvertFrom-SecureString $tenantCredentialSecretSecure) -Force
}
$settings | ConvertTo-Json | Set-Content -LiteralPath $settingsPath -Encoding UTF8
if ([string]::IsNullOrWhiteSpace([string]$settings.tenantAdminName) -or [string]$settings.tenantAdminPhone -notmatch '^\+?[0-9]{7,18}$') {
  throw "未来机械初始管理员姓名或手机号无效。请运行 -ResetCredentials 重新设置。"
}
if ([string]::IsNullOrWhiteSpace($catalogPasswordValue)) {
  $savedSettings = Get-Content -Raw -LiteralPath $settingsPath | ConvertFrom-Json
  $catalogPasswordValue = [string]$savedSettings.catalogPassword
}
if ([string]::IsNullOrWhiteSpace($catalogPasswordValue)) {
  throw "Saved SaaS catalog MySQL password is empty. Re-enter the local catalog password when prompted."
}
$catalogPasswordSecure = ConvertTo-SecureString -String $catalogPasswordValue
$tenantPasswordSecure = ConvertTo-SecureString ([string]$settings.tenantPassword)
$tenantAdminPasswordSecure = ConvertTo-SecureString ([string]$settings.tenantAdminPassword)
$platformPasswordSecure = ConvertTo-SecureString ([string]$settings.platformPassword)
$tenantProvisionerPasswordSecure = ConvertTo-SecureString ([string]$settings.tenantProvisionerPassword)
$tenantCredentialSecretSecure = ConvertTo-SecureString ([string]$settings.tenantCredentialSecret)
$bstrCatalog = [IntPtr]::Zero
$bstrTenant = [IntPtr]::Zero
$bstrTenantAdmin = [IntPtr]::Zero
$bstrPlatform = [IntPtr]::Zero
$bstrTenantProvisioner = [IntPtr]::Zero
$bstrTenantCredentialSecret = [IntPtr]::Zero
try {
  $bstrCatalog = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($catalogPasswordSecure)
  $bstrTenant = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($tenantPasswordSecure)
  $bstrTenantAdmin = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($tenantAdminPasswordSecure)
  $bstrPlatform = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($platformPasswordSecure)
  $bstrTenantProvisioner = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($tenantProvisionerPasswordSecure)
  $bstrTenantCredentialSecret = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($tenantCredentialSecretSecure)
  $env:DB_DRIVER = "mysql"
  $env:SAAS_ENABLED = "true"
  $env:SAAS_CATALOG_MYSQL_HOST = $DatabaseHost
  $env:SAAS_CATALOG_MYSQL_PORT = [string]$DatabasePort
  $env:SAAS_CATALOG_MYSQL_DATABASE = $CatalogDatabase
  $env:SAAS_CATALOG_MYSQL_USER = $CatalogDatabaseUser
  $env:SAAS_CATALOG_MYSQL_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstrCatalog)
  $tenantPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstrTenant)
  $tenantConfig = @{
    $TenantSlug = @{
      host = $DatabaseHost
      port = $DatabasePort
      database = $TenantDatabase
      user = $TenantDatabaseUser
      password = $tenantPassword
    }
  }
  $env:SAAS_TENANT_DATABASES_JSON = $tenantConfig | ConvertTo-Json -Compress -Depth 4
  $env:SAAS_TENANT_DATABASE_HOST = $DatabaseHost
  $env:SAAS_TENANT_DATABASE_PORT = [string]$DatabasePort
  $env:SAAS_TENANT_DATABASE_ACCOUNT_HOST = "127.0.0.1"
  $env:SAAS_TENANT_PROVISIONER_HOST = $DatabaseHost
  $env:SAAS_TENANT_PROVISIONER_PORT = [string]$DatabasePort
  $env:SAAS_TENANT_PROVISIONER_USER = [string]$settings.tenantProvisionerUser
  $env:SAAS_TENANT_PROVISIONER_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstrTenantProvisioner)
  $env:SAAS_TENANT_CREDENTIAL_SECRET = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstrTenantCredentialSecret)
  $env:SAAS_FUTURE_MACHINERY_ADMIN_NAME = [string]$settings.tenantAdminName
  $env:SAAS_FUTURE_MACHINERY_ADMIN_PHONE = [string]$settings.tenantAdminPhone
  $env:SAAS_FUTURE_MACHINERY_ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstrTenantAdmin)
  $env:SAAS_SESSION_SECRET = [string]$settings.sessionSecret
  $env:SAAS_PLATFORM_ADMIN_USER = [string]$settings.platformUser
  $env:SAAS_PLATFORM_ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstrPlatform)
  $env:TV_VIEW_TOKEN_SECRET = [string]$settings.tvSecret
  $env:PORT = [string]$AppPort
  $env:BOBO_RELEASE_TAG = "bobo-v0.5.0-saas.12"
  $env:BOBO_GIT_COMMIT = "local-preview"

  Write-Host "Starting the local SaaS app: http://localhost:$AppPort"
  Write-Host "Platform admin: http://localhost:$AppPort/platform-admin.html"
  Push-Location $projectRoot
  try { & $nodeExecutable server.js } finally { Pop-Location }
} finally {
  if ($bstrCatalog -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstrCatalog) }
  if ($bstrTenant -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstrTenant) }
  if ($bstrTenantAdmin -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstrTenantAdmin) }
  if ($bstrPlatform -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstrPlatform) }
  Remove-Item Env:SAAS_CATALOG_MYSQL_PASSWORD, Env:SAAS_TENANT_DATABASES_JSON, Env:SAAS_TENANT_PROVISIONER_PASSWORD, Env:SAAS_TENANT_CREDENTIAL_SECRET, Env:SAAS_FUTURE_MACHINERY_ADMIN_PASSWORD, Env:SAAS_SESSION_SECRET, Env:SAAS_PLATFORM_ADMIN_PASSWORD, Env:TV_VIEW_TOKEN_SECRET -ErrorAction SilentlyContinue
  if ($bstrTenantProvisioner -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstrTenantProvisioner) }
  if ($bstrTenantCredentialSecret -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstrTenantCredentialSecret) }
}

