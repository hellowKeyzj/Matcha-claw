; MatchaClaw Custom NSIS Installer/Uninstaller Script
;
; Install: enables long paths, adds resources\cli to user PATH for openclaw CLI.
; Uninstall: removes the PATH entry and optionally deletes user data.

!ifndef nsProcess::FindProcess
  !include "nsProcess.nsh"
!endif

!macro customHeader
  ShowInstDetails show
  ShowUninstDetails show
!macroend

!macro customCheckAppRunning
  SetDetailsPrint both
  DetailPrint "Preparing installation..."
  DetailPrint "Extracting MatchaClaw runtime files. This can take a few minutes on slower disks or when antivirus scanning is active."

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
      # allow app to exit without explicit kill
      Sleep 1000
      Goto doStopProcess
    ${endIf}
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK doStopProcess
    Quit

    doStopProcess:
    DetailPrint `Closing running "${PRODUCT_NAME}"...`

    # Silently kill the process using nsProcess instead of taskkill / cmd.exe
    ${nsProcess::KillProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    
    # to ensure that files are not "in-use"
    Sleep 300

    # Retry counter
    StrCpy $R1 0

    loop:
      IntOp $R1 $R1 + 1

      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
      ${if} $R0 == 0
        # wait to give a chance to exit gracefully
        Sleep 1000
        ${nsProcess::KillProcess} "${APP_EXECUTABLE_FILENAME}" $R0
        
        ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
        ${If} $R0 == 0
          DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
          Sleep 2000
        ${else}
          Goto not_running
        ${endIf}
      ${else}
        Goto not_running
      ${endIf}

      # App likely running with elevated permissions.
      # Ask user to close it manually
      ${if} $R1 > 1
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY loop
        Quit
      ${else}
        Goto loop
      ${endIf}
    not_running:
      ${nsProcess::Unload}
  ${endIf}

  ; Prevent NSIS itself from holding $INSTDIR as current working directory.
  SetOutPath $TEMP

  ; Move the previous install directory out of the way before extraction.
  ; This avoids upgrade hangs when one locked file blocks overwrite in-place.
  IfFileExists "$INSTDIR\" 0 _ccar_done
    StrCpy $R8 0

  _ccar_find_stale_slot:
    IfFileExists "$INSTDIR._stale_$R8\" 0 _ccar_try_rename
    IntOp $R8 $R8 + 1
    Goto _ccar_find_stale_slot

  _ccar_try_rename:
    ClearErrors
    Rename "$INSTDIR" "$INSTDIR._stale_$R8"
    IfErrors _ccar_rename_failed _ccar_rename_ok

  _ccar_rename_failed:
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Failed to prepare installation directory. Another process is still locking files under:$\r$\n$INSTDIR$\r$\nPlease close related processes and retry." /SD IDCANCEL IDRETRY _ccar_try_rename
    Quit

  _ccar_rename_ok:
    CreateDirectory "$INSTDIR"
    DetailPrint "Moved previous install directory to $INSTDIR._stale_$R8"

  _ccar_done:
!macroend

!macro customUnInstallCheck
  ${if} $R0 != 0
    DetailPrint "Old uninstaller exited with code $R0. Continue with overwrite install."
  ${endIf}
  ClearErrors
!macroend

!macro customUnInstallCheckCurrentUser
  ${if} $R0 != 0
    DetailPrint "Old uninstaller (current user) exited with code $R0. Continue with overwrite install."
  ${endIf}
  ClearErrors
!macroend

!macro customInstall
  DetailPrint "Core files extracted. Finalizing system integration..."

  ; Enable Windows long path support (Windows 10 1607+ / Windows 11).
  ; pnpm virtual store paths can exceed the default MAX_PATH limit of 260 chars.
  ; Writing to HKLM requires admin privileges; on per-user installs without
  ; elevation this call silently fails — no crash, just no key written.
  DetailPrint "Enabling long-path support (if permissions allow)..."
  WriteRegDWORD HKLM "SYSTEM\CurrentControlSet\Control\FileSystem" "LongPathsEnabled" 1

  ; Use PowerShell to update the current user's PATH.
  ; This avoids NSIS string-buffer limits and preserves long PATH values.
  DetailPrint "Updating user PATH for the OpenClaw CLI..."
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
    ; --- Always remove current user's AppData first ---
    ; NOTE: .openclaw directory is intentionally preserved (user configuration & skills)
    RMDir /r "$LOCALAPPDATA\MatchaClaw"
    RMDir /r "$APPDATA\MatchaClaw"

    ; --- For per-machine (all users) installs, enumerate all user profiles ---
    StrCpy $R0 0

  _cu_enumLoop:
    EnumRegKey $R1 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList" $R0
    StrCmp $R1 "" _cu_enumDone

    ReadRegStr $R2 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$R1" "ProfileImagePath"
    StrCmp $R2 "" _cu_enumNext

    ExpandEnvStrings $R2 $R2
    StrCmp $R2 $PROFILE _cu_enumNext

    ; NOTE: .openclaw directory is intentionally preserved for all users
    RMDir /r "$R2\AppData\Local\MatchaClaw"
    RMDir /r "$R2\AppData\Roaming\MatchaClaw"

  _cu_enumNext:
    IntOp $R0 $R0 + 1
    Goto _cu_enumLoop

  _cu_enumDone:
  _cu_skipRemove:
!macroend
