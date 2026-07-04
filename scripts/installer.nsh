; MatchaClaw Custom NSIS Installer/Uninstaller Script
;
; Install: enables long paths, adds resources\cli to user PATH for bundled CLIs.
; Uninstall: removes the PATH entry and optionally deletes user data.

!ifndef nsProcess::FindProcess
  !include "nsProcess.nsh"
!endif

!macro customHeader
  ; Show install details by default so users can see what stage is running.
  ShowInstDetails show
  ShowUninstDetails show
!macroend

!macro customCheckAppRunning
  ; Make stage logs visible on assisted installers (defaults to hidden).
  SetDetailsPrint both
  DetailPrint "Preparing installation..."
  DetailPrint "Extracting MatchaClaw runtime files. This can take a few minutes on slower disks or while antivirus scanning is active."

  ; Pre-emptively remove old shortcuts to prevent the Windows "Missing Shortcut"
  ; dialog during upgrades.  The built-in NSIS uninstaller deletes MatchaClaw.exe
  ; *before* removing shortcuts; Windows Shell link tracking can detect the
  ; broken target in that brief window and pop a resolver dialog.
  ; Delete is a silent no-op when the file doesn't exist (safe for fresh installs).
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}.lnk"

  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0

  ${if} $R0 == 0
    ${if} ${isUpdated}
      # Auto-update: the app is already shutting down (quitAndInstall was called).
      # Give the app a chance to stop the Gateway process tree before force-kill.
      DetailPrint `Waiting for "${PRODUCT_NAME}" to finish shutting down...`
      Sleep 8000
      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
      ${if} $R0 != 0
        # App exited cleanly. Still kill long-lived child processes that may
        # not have followed the app's graceful exit.
        nsExec::ExecToStack 'taskkill /F /IM openclaw-gateway.exe'
        Pop $0
        Pop $1
        Goto done_killing
      ${endIf}
    ${endIf}
    ${if} ${isUpdated} ; skip the dialog for auto-updates
    ${else}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK doStopProcess
      Quit
    ${endIf}

    doStopProcess:
    DetailPrint `Closing running "${PRODUCT_NAME}"...`

    ; Kill all processes whose executable lives inside $INSTDIR. This covers
    ; MatchaClaw.exe, openclaw-gateway.exe, bundled node/python/uv processes,
    ; and any child process that might hold file locks in the install dir.
    nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith('$INSTDIR', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
    Pop $0
    Pop $1

    ${if} $0 != 0
      ; PowerShell failed (policy restriction, etc.) - fall back to name-based kill.
      nsExec::ExecToStack 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
      Pop $0
      Pop $1
    ${endIf}

    ; Also kill the known detached Gateway process by name. Do not kill uv.exe
    ; globally because it is a common package manager outside MatchaClaw.
    nsExec::ExecToStack 'taskkill /F /IM openclaw-gateway.exe'
    Pop $0
    Pop $1

    ; Wait for Windows to fully release file handles after process termination.
    Sleep 5000
    DetailPrint "Processes terminated. Continuing installation..."

    done_killing:
      ${nsProcess::Unload}
  ${endIf}

  ; Even if MatchaClaw.exe was not detected, orphan child processes from a
  ; previous crash or unclean shutdown may still hold file locks inside $INSTDIR.
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith('$INSTDIR', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $0
  Pop $1

  ; Name-based fallback catches installs moved between directories.
  nsExec::ExecToStack 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Pop $1
  nsExec::ExecToStack 'taskkill /F /IM openclaw-gateway.exe'
  Pop $0
  Pop $1

  ; Brief wait for handle release. The main wait already ran if the app was open.
  Sleep 2000

  ; Prevent NSIS itself from holding $INSTDIR as current working directory before
  ; the rename check. Windows refuses to rename a directory held as CWD.
  SetOutPath $TEMP

  ; Move the old install directory aside before extraction. electron-builder
  ; extracts to a temp dir then CopyFiles into $INSTDIR; any locked file in the
  ; old tree makes CopyFiles fail and triggers the misleading "app cannot close"
  ; retry loop. Renaming the directory first gives extraction a clean target.
  IfFileExists "$INSTDIR\" 0 _instdir_clean
    StrCpy $R8 0
  _find_free_stale:
    IfFileExists "$INSTDIR._stale_$R8\" 0 _found_free_stale
    IntOp $R8 $R8 + 1
    Goto _find_free_stale

  _found_free_stale:
    ClearErrors
    Rename "$INSTDIR" "$INSTDIR._stale_$R8"
    IfErrors 0 _stale_moved
      nsExec::ExecToStack 'cmd.exe /c rd /s /q "$INSTDIR"'
      Pop $0
      Pop $1
      Sleep 2000
      CreateDirectory "$INSTDIR"
      Goto _instdir_clean
  _stale_moved:
    CreateDirectory "$INSTDIR"
  _instdir_clean:

  ; If a fallback delete left old files behind, remove the legacy skills subtree
  ; before extraction so stale bundled skills cannot survive an overwrite install.
  IfFileExists "$INSTDIR\resources\openclaw\skills\" 0 _openclaw_skills_clean
    DetailPrint "Removing stale bundled OpenClaw skills from previous install..."
    RMDir /r "$INSTDIR\resources\openclaw\skills"
    IfFileExists "$INSTDIR\resources\openclaw\skills\" 0 _openclaw_skills_clean
      nsExec::ExecToStack 'cmd.exe /c rd /s /q "$INSTDIR\resources\openclaw\skills"'
      Pop $0
      Pop $1
  _openclaw_skills_clean:

  ; Make electron-builder skip uninstallOldVersion. Its old uninstaller path has
  ; a hardcoded retry loop; when atomicRMDir hits an antivirus/indexer lock it
  ; repeatedly runs old-uninstaller.exe and finally shows appCannotBeClosed.
  ; The new installer writes fresh uninstall registry entries after extraction.
  DeleteRegValue SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
  DeleteRegValue SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString
  DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
  DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" QuietUninstallString
  !ifdef UNINSTALL_REGISTRY_KEY_2
    DeleteRegValue SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    DeleteRegValue SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}" QuietUninstallString
    DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY_2}" QuietUninstallString
  !endif
!macroend

!macro customUnInstallCheck
  ${if} $R0 != 0
    DetailPrint "Old uninstaller exited with code $R0. Continuing with overwrite install..."
  ${endIf}
  ClearErrors
!macroend

!macro customUnInstallCheckCurrentUser
  ${if} $R0 != 0
    DetailPrint "Old uninstaller (current user) exited with code $R0. Continuing..."
  ${endIf}
  ClearErrors
!macroend

!macro customInstall
  ; Async cleanup of old dirs left by the rename loop in customCheckAppRunning.
  ; Wait 60s before deletion to avoid I/O contention with first launch.
  IfFileExists "$INSTDIR._stale_0\" 0 _ci_stale_cleaned
    ExecShell "" "cmd.exe" `/c ping -n 61 127.0.0.1 >nul & cd /d "$INSTDIR\.." & for /d %D in ("$INSTDIR._stale_*") do rd /s /q "%D"` SW_HIDE
  _ci_stale_cleaned:

  DetailPrint "Core files extracted. Finalizing system integration..."

  ; Remove the legacy bundled OpenClaw skills directory during overwrite installs.
  ; Current builds use resources\preinstalled-skills; keeping the old subtree can
  ; leave stale skills such as apple-notes or discord visible after an upgrade.
  IfFileExists "$INSTDIR\resources\openclaw\skills\" 0 _ci_legacySkillsDone
    DetailPrint "Removing stale bundled OpenClaw skills from previous install..."
    RMDir /r "$INSTDIR\resources\openclaw\skills"
    IfFileExists "$INSTDIR\resources\openclaw\skills\" 0 _ci_legacySkillsDone
      nsExec::ExecToStack 'cmd.exe /c rd /s /q "$INSTDIR\resources\openclaw\skills"'
      Pop $0
      Pop $1
  _ci_legacySkillsDone:

  ; Enable Windows long path support (Windows 10 1607+ / Windows 11).
  ; pnpm virtual store paths can exceed the default MAX_PATH limit of 260 chars.
  ; Writing to HKLM requires admin privileges; on per-user installs without
  ; elevation this call silently fails — no crash, just no key written.
  DetailPrint "Enabling long-path support (if permissions allow)..."
  WriteRegDWORD HKLM "SYSTEM\CurrentControlSet\Control\FileSystem" "LongPathsEnabled" 1

  ; Add $INSTDIR to Windows Defender exclusions so real-time scanning does not
  ; block the first launch. Requires elevation; non-admin installs fail silently.
  DetailPrint "Configuring Windows Defender exclusion..."
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Add-MpPreference -ExclusionPath '$INSTDIR' -ErrorAction SilentlyContinue"`
  Pop $0
  Pop $1

  ; Use PowerShell to update the current user's PATH.
  ; This avoids NSIS string-buffer limits and preserves long PATH values.
  DetailPrint "Updating user PATH for bundled CLIs..."
  InitPluginsDir
  ClearErrors
  File "/oname=$PLUGINSDIR\update-user-path.ps1" "${PROJECT_DIR}\resources\cli\win32\update-user-path.ps1"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\update-user-path.ps1" -Action add -CliDir "$INSTDIR\resources\cli"'
  Pop $0
  Pop $1
  StrCmp $0 "error" 0 +2
    DetailPrint "Warning: Failed to launch PowerShell while updating PATH."
  StrCmp $0 "timeout" 0 +2
    DetailPrint "Warning: PowerShell PATH update timed out."
  StrCmp $0 "0" 0 +2
    Goto _ci_done
  DetailPrint "Warning: PowerShell PATH update exited with code $0."

  _ci_done:
  DetailPrint "Installation steps complete."
!macroend

!macro customUnInstall
  ; Remove Windows Defender exclusion added during install.
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Remove-MpPreference -ExclusionPath '$INSTDIR' -ErrorAction SilentlyContinue"`
  Pop $0
  Pop $1

  ; Remove resources\cli from user PATH via PowerShell so long PATH values are handled safely
  InitPluginsDir
  ClearErrors
  File "/oname=$PLUGINSDIR\update-user-path.ps1" "${PROJECT_DIR}\resources\cli\win32\update-user-path.ps1"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\update-user-path.ps1" -Action remove -CliDir "$INSTDIR\resources\cli"'
  Pop $0
  Pop $1
  StrCmp $0 "error" 0 +2
    DetailPrint "Warning: Failed to launch PowerShell while removing PATH entry."
  StrCmp $0 "timeout" 0 +2
    DetailPrint "Warning: PowerShell PATH removal timed out."
  StrCmp $0 "0" 0 +2
    Goto _cu_pathDone
  DetailPrint "Warning: PowerShell PATH removal exited with code $0."

  _cu_pathDone:

  ; Ask user if they want to remove AppData (preserves .openclaw)
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Do you want to remove MatchaClaw application data?$\r$\n$\r$\nThis will delete:$\r$\n  • AppData\Local\MatchaClaw (local app data)$\r$\n  • AppData\Roaming\MatchaClaw (roaming app data)$\r$\n$\r$\nYour .openclaw folder (configuration & skills) will be preserved.$\r$\nSelect 'No' to keep all data for future reinstallation." \
    /SD IDNO IDYES _cu_removeData IDNO _cu_skipRemove

  _cu_removeData:
    ; Kill lingering MatchaClaw processes before deleting electron-store data.
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 == 0
      nsExec::ExecToStack 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
      Pop $0
      Pop $1
    ${endIf}
    ${nsProcess::Unload}

    ; Wait for processes to fully exit and release file handles.
    Sleep 2000

    ; --- Always remove current user's AppData first ---
    ; NOTE: .openclaw directory is intentionally preserved (user configuration & skills)
    RMDir /r "$LOCALAPPDATA\MatchaClaw"
    RMDir /r "$APPDATA\MatchaClaw"

    ; Retry if directories still exist because a file handle was released late.
    IfFileExists "$LOCALAPPDATA\MatchaClaw\*.*" 0 _cu_localDone
      Sleep 3000
      RMDir /r "$LOCALAPPDATA\MatchaClaw"
      IfFileExists "$LOCALAPPDATA\MatchaClaw\*.*" 0 _cu_localDone
        nsExec::ExecToStack 'cmd.exe /c rd /s /q "$LOCALAPPDATA\MatchaClaw"'
        Pop $0
        Pop $1
    _cu_localDone:

    IfFileExists "$APPDATA\MatchaClaw\*.*" 0 _cu_roamingDone
      Sleep 3000
      RMDir /r "$APPDATA\MatchaClaw"
      IfFileExists "$APPDATA\MatchaClaw\*.*" 0 _cu_roamingDone
        nsExec::ExecToStack 'cmd.exe /c rd /s /q "$APPDATA\MatchaClaw"'
        Pop $0
        Pop $1
    _cu_roamingDone:

    StrCpy $R3 ""
    IfFileExists "$LOCALAPPDATA\MatchaClaw\*.*" 0 +2
      StrCpy $R3 "$R3$\r$\n  • $LOCALAPPDATA\MatchaClaw"
    IfFileExists "$APPDATA\MatchaClaw\*.*" 0 +2
      StrCpy $R3 "$R3$\r$\n  • $APPDATA\MatchaClaw"
    StrCmp $R3 "" _cu_cleanupOk
      MessageBox MB_OK|MB_ICONEXCLAMATION \
        "Some data directories could not be removed (files may be in use):$\r$\n$R3$\r$\n$\r$\nPlease delete them manually after restarting your computer."
    _cu_cleanupOk:

    ; --- For per-machine (all users) installs, enumerate all user profiles ---
    StrCpy $R0 0

  _cu_enumLoop:
    EnumRegKey $R1 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList" $R0
    StrCmp $R1 "" _cu_enumDone

    ReadRegStr $R2 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$R1" "ProfileImagePath"
    StrCmp $R2 "" _cu_enumNext

    ; ExpandEnvStrings requires distinct src and dest registers.
    ExpandEnvStrings $R3 $R2
    StrCmp $R3 $PROFILE _cu_enumNext

    ; NOTE: .openclaw directory is intentionally preserved for all users
    RMDir /r "$R3\AppData\Local\MatchaClaw"
    RMDir /r "$R3\AppData\Roaming\MatchaClaw"

  _cu_enumNext:
    IntOp $R0 $R0 + 1
    Goto _cu_enumLoop

  _cu_enumDone:
  _cu_skipRemove:
!macroend
