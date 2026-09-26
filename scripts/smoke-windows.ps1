# Package smoke test for a Windows build leg (release.yml, `smoke_test: true`).
#
#   pwsh -File smoke-windows.ps1 -BundleDir <dir> -Version <x.y.z[-pre]> -Bundles <csv>
#
# Get-AuthenticodeSignature proves an installer is signed; it says nothing about
# whether it installs or whether the app then starts. This does:
#
# - msi: ProductVersion, read through the WindowsInstaller.Installer COM object
#   without installing, must equal the release version.
# - nsis: the *-setup.exe is run silently (/S) into a scratch directory (/D=,
#   which NSIS requires to be the LAST argument, unquoted), then the installed
#   main executable is launched and must still be running after
#   $env:SMOKE_SECONDS seconds (default 10). The main executable is the one the
#   installer registered as the uninstall entry's DisplayIcon — tauri's NSIS
#   template writes "$INSTDIR\<main binary>.exe" there — because sidecars are
#   installed next to it and a directory glob cannot tell them apart. On
#   failure the install directory, the app's output and recent Application
#   event log errors are printed.
#
# Every failure is reported before exiting non-zero.
param(
  [Parameter(Mandatory)] [string] $BundleDir,
  [Parameter(Mandatory)] [string] $Version,
  [Parameter(Mandatory)] [string] $Bundles
)
$ErrorActionPreference = 'Stop'
$alive = if ($env:SMOKE_SECONDS) { [int]$env:SMOKE_SECONDS } else { 10 }
$formats = $Bundles -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
$failed = $false
$started = Get-Date

function Show-Diagnostics([string] $installDir, [string] $logBase) {
  if ($installDir -and (Test-Path $installDir)) {
    Write-Output "--- install directory ---"
    Get-ChildItem -Path $installDir -Recurse -File | Select-Object -First 50 | ForEach-Object { Write-Output $_.FullName }
  }
  foreach ($log in @("$logBase.out", "$logBase.err")) {
    if (Test-Path $log) { Write-Output "--- $(Split-Path $log -Leaf) ---"; Get-Content $log -Tail 200 }
  }
  Write-Output "--- Application event log errors since the smoke test started ---"
  Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Level = 2; StartTime = $started } -ErrorAction SilentlyContinue |
    Select-Object -First 20 | ForEach-Object { Write-Output "$($_.TimeCreated) $($_.ProviderName): $($_.Message)" }
}

if ($formats -contains 'msi') {
  $msis = @(Get-ChildItem -Path (Join-Path $BundleDir 'msi') -Filter '*.msi' -ErrorAction SilentlyContinue)
  if ($msis.Count -eq 0) {
    Write-Output "::error::msi is in this leg's bundle list but there is no .msi under $BundleDir\msi"
    $failed = $true
  } else {
    $installer = New-Object -ComObject WindowsInstaller.Installer
  }
  foreach ($msi in $msis) {
    $db = $installer.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $installer, @($msi.FullName, 0))
    $view = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db, @("SELECT Value FROM Property WHERE Property = 'ProductVersion'"))
    $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null) | Out-Null
    $record = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
    $productVersion = if ($record) { $record.GetType().InvokeMember('StringData', 'GetProperty', $null, $record, @(1)) } else { '' }
    $view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null) | Out-Null
    if ($productVersion -eq $Version) {
      Write-Output "msi: $($msi.Name) ProductVersion $productVersion"
    } else {
      Write-Output "::error::$($msi.Name) has ProductVersion '$productVersion', expected '$Version'"
      $failed = $true
    }
  }
}

if ($formats -contains 'nsis') {
  $setup = Get-ChildItem -Path (Join-Path $BundleDir 'nsis') -Filter '*-setup.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $setup) {
    Write-Output "::error::nsis is in this leg's bundle list but there is no *-setup.exe under $BundleDir\nsis"
    $failed = $true
  } else {
    $installDir = Join-Path $env:RUNNER_TEMP 'nsis-smoke'
    $logBase = Join-Path $env:RUNNER_TEMP 'nsis-smoke-app'
    $install = Start-Process -FilePath $setup.FullName -ArgumentList '/S', "/D=$installDir" -PassThru
    if (-not $install.WaitForExit(300000)) {
      $install.Kill($true)
      Write-Output "::error::$($setup.Name) /S did not finish within 300 s"
      Show-Diagnostics $installDir $logBase
      exit 1
    }
    if ($install.ExitCode -ne 0) {
      Write-Output "::error::$($setup.Name) /S exited with $($install.ExitCode)"
      Show-Diagnostics $installDir $logBase
      exit 1
    }

    $exe = $null
    $keys = @(
      'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
      'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
      'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($entry in Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue) {
      if ($entry.InstallLocation -and $entry.InstallLocation.Trim('"') -eq $installDir -and $entry.DisplayIcon) {
        $exe = $entry.DisplayIcon.Trim('"')
        break
      }
    }
    if (-not $exe) {
      $candidates = @(Get-ChildItem -Path $installDir -Filter '*.exe' | Where-Object { $_.Name -ne 'uninstall.exe' })
      if ($candidates.Count -eq 1) { $exe = $candidates[0].FullName }
    }
    if (-not $exe -or -not (Test-Path $exe)) {
      Write-Output "::error::Could not identify the installed main executable in $installDir (no uninstall entry with a DisplayIcon for it, and not exactly one .exe besides uninstall.exe)"
      Show-Diagnostics $installDir $logBase
      exit 1
    }

    $app = Start-Process -FilePath $exe -PassThru -RedirectStandardOutput "$logBase.out" -RedirectStandardError "$logBase.err"
    if ($app.WaitForExit($alive * 1000)) {
      Write-Output "::error::$(Split-Path $exe -Leaf) exited during startup with $($app.ExitCode) instead of running for $alive s"
      Show-Diagnostics $installDir $logBase
      $failed = $true
    } else {
      Write-Output "nsis: installed $($setup.Name); $(Split-Path $exe -Leaf) still running after $alive s"
      $app.Kill($true)
    }
  }
}

if ($failed) { exit 1 }
