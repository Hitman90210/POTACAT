; POTACAT installer customization
;  - diagnostic logging (potacat-install.log next to the installer .exe)
;  - stop the Remote Launcher before the app-running check so upgrades and
;    uninstalls don't get stuck on "POTACAT cannot be closed" (K6RBJ + others)

!define LOG_FILE "$EXEDIR\potacat-install.log"

; Helper: append a line to the log file. NSIS gotcha: FileOpen "a" does NOT
; seek to the end (the pointer starts at 0, silently overwriting prior
; lines — every log before 2026-07-19 only preserved its longest/last line),
; so the FileSeek is load-bearing.
!macro _LogWrite text
  FileOpen $9 "${LOG_FILE}" a
  StrCmp $9 "" +4
    FileSeek $9 0 END
    FileWrite $9 "${text}$\r$\n"
    FileClose $9
!macroend

; Stop the Remote Launcher if it's running as a POTACAT.exe — the "POTACAT
; cannot be closed / old version won't uninstall" bug (K6RBJ + others, v1.8.12
; release notes documented it as a known issue with a Task-Manager workaround).
;
; The launcher auto-starts at logon. On a machine WITHOUT system Node it runs as
; the install-dir Electron binary with ELECTRON_RUN_AS_NODE
; (POTACAT.exe <userData>\launcher.js). Windows locks a running .exe's image
; file, so that background POTACAT.exe (a) keeps <INSTDIR>\POTACAT.exe locked and
; (b) trips electron-builder's "is the app running" check by process name — but
; it has no window, so the graceful close never lands and the installer loops on
; "cannot be closed."
;
; HOW we stop it (rewritten 2026-07-19 after a Sophos Endpoint report): the
; original implementation always shelled out to powershell.exe with a CIM
; query. Sophos/EDR "Lockdown" policies kill any PowerShell whose process
; ancestry includes a browser (BrowserAncestorPowershell) — i.e. every user
; who runs the setup straight from their browser's download UI — and it fired
; for 100% of installs even though most users never enable the launcher.
;
; Current design, in order:
;   1. PID-file fast path — launchers ≥1.9.12 running as the Electron binary
;      advertise their PID in %APPDATA%\potacat\launcher.pid (scripts/
;      launcher.js). We terminate exactly that PID with in-process WinAPI
;      calls (OpenProcess/TerminateProcess via System.dll): no child process,
;      nothing for an EDR to block. The PID is verified to still map to a
;      POTACAT.exe image first, so a stale file after a crash (or PID reuse)
;      can't kill an innocent process. node.exe launchers don't write the
;      file — they run from %APPDATA% and never lock INSTDIR.
;   2. Legacy fallback — no PID file but POTACAT-Launcher.vbs exists in the
;      user's Startup folder (a pre-1.9.12 launcher is registered): the old
;      PowerShell CIM sweep, one last time. Its Name+CommandLine filter is
;      load-bearing (kills ONLY '*launcher.js*' POTACAT.exe; the GUI stays on
;      the stock graceful app-running check; powershell.exe never matches
;      itself). After one upgrade the new launcher writes the PID file and
;      this branch never runs again.
;   3. Nothing registered — do nothing at all. No process is spawned, so the
;      overwhelming majority of installs are invisible to EDR heuristics.
!macro _KillLauncher
  !define /redef _KLID ${__COUNTER__}
  IfFileExists "$APPDATA\potacat\launcher.pid" 0 kl_legacy_${_KLID}
    FileOpen $R0 "$APPDATA\potacat\launcher.pid" r
    StrCmp $R0 "" kl_legacy_${_KLID}
    FileRead $R0 $R1
    FileClose $R0
    IntOp $R1 $R1 + 0                       ; numeric coercion (garbage -> 0)
    IntCmp $R1 4 kl_stale_${_KLID} kl_stale_${_KLID} 0  ; require pid > 4
    ; PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE
    System::Call 'kernel32::OpenProcess(i 0x00101001, i 0, i R1) i .R2 ?e'
    Pop $R6
    IntCmp $R2 0 0 kl_open_ok_${_KLID} kl_open_ok_${_KLID}
    ; Open failed. ERROR_ACCESS_DENIED (5) means the launcher IS running but
    ; elevated above us — deleting the pid file here would blind every later
    ; retry (and the legacy sweep never fires when the file is absent). Keep
    ; the file, log it, and let the app-running check surface the conflict.
    IntCmp $R6 5 0 kl_stale_${_KLID} kl_stale_${_KLID}
    !insertmacro _LogWrite "KillLauncher: ACCESS DENIED opening pid=$R1 (elevated launcher?) - pid file kept, nothing killed"
    Goto kl_done_${_KLID}
  kl_open_ok_${_KLID}:
    ; PID-reuse guard: the PID must still be a POTACAT.exe image.
    System::Call 'kernel32::QueryFullProcessImageNameW(i R2, i 0, w .R3, *i ${NSIS_MAX_STRLEN}) i .R4'
    IntCmp $R4 0 kl_qfail_${_KLID}
    StrCpy $R5 $R3 "" -12                   ; last 12 chars of the image path
    StrCmp $R5 "\POTACAT.exe" 0 kl_notours_${_KLID}  ; StrCmp = case-insensitive
    System::Call 'kernel32::TerminateProcess(i R2, i 0) i .R4'
    System::Call 'kernel32::WaitForSingleObject(i R2, i 3000)'
    System::Call 'kernel32::CloseHandle(i R2)'
    Delete "$APPDATA\potacat\launcher.pid"
    !insertmacro _LogWrite "KillLauncher: terminated launcher pid=$R1 natively rc=$R4"
    Sleep 200                                ; let the image lock fully release
    Goto kl_done_${_KLID}
  kl_qfail_${_KLID}:
    ; Can't verify what the PID is — do NOT kill blind, leave the file alone.
    System::Call 'kernel32::CloseHandle(i R2)'
    !insertmacro _LogWrite "KillLauncher: could not query image for pid=$R1 - skipped (nothing killed)"
    Goto kl_done_${_KLID}
  kl_notours_${_KLID}:
    System::Call 'kernel32::CloseHandle(i R2)'
    Delete "$APPDATA\potacat\launcher.pid"   ; PID recycled by another program
    !insertmacro _LogWrite "KillLauncher: pid=$R1 is '$R3', not POTACAT.exe - stale pid file removed, nothing killed"
    Goto kl_done_${_KLID}
  kl_stale_${_KLID}:
    Delete "$APPDATA\potacat\launcher.pid"
    !insertmacro _LogWrite "KillLauncher: stale/invalid launcher.pid - launcher not running"
    Goto kl_done_${_KLID}
  kl_legacy_${_KLID}:
    ; Pre-1.9.12 launcher: only sweep if one is actually registered to
    ; auto-start; otherwise spawn nothing at all.
    IfFileExists "$APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\POTACAT-Launcher.vbs" 0 kl_none_${_KLID}
    nsExec::Exec `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { $$_.Name -eq 'POTACAT.exe' -and $$_.CommandLine -like '*launcher.js*' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
    Pop $R4
    !insertmacro _LogWrite "KillLauncher: legacy PowerShell sweep rc=$R4 (pre-pid-file launcher registered)"
    ; Give Windows a moment to release the .exe image lock before file ops.
    Sleep 800
    Goto kl_done_${_KLID}
  kl_none_${_KLID}:
    !insertmacro _LogWrite "KillLauncher: no launcher registered - nothing to stop"
  kl_done_${_KLID}:
!macroend

; =========================================================================
; Self-contained app-running check (customCheckAppRunning), 2026-08-03.
;
; Replaces electron-builder's stock check, which failed a long-time user with
; a FALSE "POTACAT cannot be closed" loop: the app visibly closed, Retry never
; cleared it, and restarting the installer didn't either. The stock check's
; verdict is based on PROCESS ENUMERATION (PowerShell CIM query or tasklist),
; and its kill is Stop-Process/taskkill — so any POTACAT/INSTDIR process that
; is enumerable but not killable (elevated, another session, or a kernel
; ghost wedged in a driver I/O — USB-serial CAT adapters are notorious) loops
; the dialog forever even when it no longer blocks the install.
;
; This implementation:
;   - enumerates processes whose image path is under $INSTDIR via in-process
;     WinAPI (Toolhelp snapshot + QueryFullProcessImageNameW) — catches the
;     GUI, the launcher, orphaned rigctld.exe, and Electron child ghosts; no
;     PowerShell at all (the stock check probed PowerShell on EVERY install —
;     the same spawn the 2026-07-19 Sophos rework eliminated from _KillLauncher)
;   - closes gracefully first (taskkill without /F = WM_CLOSE), then
;     TerminateProcess stragglers natively
;   - final verdict = CAN WE ACTUALLY LOCK $INSTDIR\POTACAT.exe, not "is
;     anything enumerable": an unkillable ghost that has already dropped its
;     image lock does not block the install (that was the false-loop case);
;     a process that truly holds the lock still gets the Retry dialog
;   - logs every branch + blocking PID/image to potacat-install.log so the
;     next report of this comes with data
;
; NOTE: defined for BOTH contexts — electron-builder inserts CHECK_APP_RUNNING
; in the installer (installSection) and the uninstaller (un.checkAppRunning),
; so all labels use the /redef ${__COUNTER__} pattern (same as _KillLauncher).
; This macro deliberately references NO electron-builder internals (no $pid,
; no GetProcessInfo, no IS_POWERSHELL_AVAILABLE) — the 3a05698 lesson.
; Registers: $R9=own pid, sweep uses $R0-$R8/$0/$5, flow uses $3/$4/$6/$7.
; _LogWrite owns $9.
; =========================================================================

; Enumerate (KILL=0) or terminate (KILL=1) every process whose image lives
; under "$INSTDIR\". Out: $R0 = count found, $5 = "[pid path] " list.
!macro _SweepInstDir KILL
  !define /redef _SW ${__COUNTER__}
  StrCpy $R0 0
  StrCpy $5 ""
  StrLen $R1 "$INSTDIR\"
  System::Call 'kernel32::CreateToolhelp32Snapshot(i 2, i 0) i .R2'
  IntCmp $R2 -1 sw_ret_${_SW}
  IntCmp $R2 0 sw_ret_${_SW}
  System::Alloc 1024
  Pop $R3
  System::Call "*$R3(i 556)"               ; PROCESSENTRY32W.dwSize (x86)
  System::Call 'kernel32::Process32FirstW(i R2, i R3) i .R4'
  sw_loop_${_SW}:
    IntCmp $R4 0 sw_free_${_SW}
    System::Call "*$R3(i, i, i .R5)"       ; th32ProcessID @ offset 8
    IntCmp $R5 $R9 sw_next_${_SW}          ; never touch our own process
    System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i R5) i .R6'
    IntCmp $R6 0 sw_next_${_SW}            ; other user / gone — can't be ours
    System::Call 'kernel32::QueryFullProcessImageNameW(i R6, i 0, w .R8, *i 1024) i .R7'
    System::Call 'kernel32::CloseHandle(i R6)'
    IntCmp $R7 0 sw_next_${_SW}
    StrCpy $0 $R8 $R1                      ; prefix compare incl. trailing \
    StrCmp $0 "$INSTDIR\" 0 sw_next_${_SW} ; StrCmp = case-insensitive
    IntOp $R0 $R0 + 1
    StrCpy $5 "$5[$R5 $R8] "
    !if ${KILL} == 1
      System::Call 'kernel32::OpenProcess(i 0x00100001, i 0, i R5) i .R6'
      IntCmp $R6 0 sw_next_${_SW}
      System::Call 'kernel32::TerminateProcess(i R6, i 0) i .R7'
      System::Call 'kernel32::WaitForSingleObject(i R6, i 3000)'
      System::Call 'kernel32::CloseHandle(i R6)'
      !insertmacro _LogWrite "appcheck: TerminateProcess pid=$R5 ($R8) rc=$R7"
    !endif
  sw_next_${_SW}:
    System::Call 'kernel32::Process32NextW(i R2, i R3) i .R4'
    Goto sw_loop_${_SW}
  sw_free_${_SW}:
    System::Free $R3
    System::Call 'kernel32::CloseHandle(i R2)'
  sw_ret_${_SW}:
!macroend

; Can $INSTDIR\POTACAT.exe be opened for exclusive write? Out: $3 = 1 locked,
; 0 free (or file absent — fresh install). One internal retry absorbs a
; transient AV/indexer hold so it can't fake a "still running" verdict.
!macro _ProbeExeLock
  !define /redef _PL ${__COUNTER__}
  StrCpy $3 0
  IfFileExists "$INSTDIR\POTACAT.exe" 0 pl_done_${_PL}
  ; GENERIC_WRITE, share none, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\POTACAT.exe", i 0x40000000, i 0, i 0, i 3, i 0x80, i 0) i .r4'
  IntCmp $4 -1 0 pl_free_${_PL} pl_free_${_PL}
    Sleep 700
    System::Call 'kernel32::CreateFileW(w "$INSTDIR\POTACAT.exe", i 0x40000000, i 0, i 0, i 3, i 0x80, i 0) i .r4'
    IntCmp $4 -1 0 pl_free_${_PL} pl_free_${_PL}
      StrCpy $3 1
      Goto pl_done_${_PL}
  pl_free_${_PL}:
    System::Call 'kernel32::CloseHandle(i r4)'
  pl_done_${_PL}:
!macroend

!macro customCheckAppRunning
  !define /redef _CAR ${__COUNTER__}
  !insertmacro _LogWrite "appcheck: begin (INSTDIR=$INSTDIR)"
  System::Call 'kernel32::GetCurrentProcessId() i .R9'
  !insertmacro _SweepInstDir 0
  IntCmp $R0 0 car_lockcheck_${_CAR}
  !insertmacro _LogWrite "appcheck: running under INSTDIR: $5"
  ${if} ${isUpdated}
    Goto car_close_${_CAR}                 ; auto-update: app is already exiting
  ${endif}
  MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK car_close_${_CAR}
  !insertmacro _LogWrite "appcheck: user cancelled at appRunning prompt"
  Quit
  car_close_${_CAR}:
    ; Graceful first: taskkill without /F posts WM_CLOSE, so the GUI runs its
    ; normal shutdown (PTT release, settings flush). Image-name scoped like
    ; the stock check; the INSTDIR-scoped force pass below catches the rest.
    nsExec::Exec '"$SYSDIR\cmd.exe" /C taskkill /IM "POTACAT.exe" /FI "USERNAME eq %USERNAME%"'
    Pop $7
    !insertmacro _LogWrite "appcheck: graceful taskkill rc=$7"
    StrCpy $6 0
  car_poll_${_CAR}:
    Sleep 500
    !insertmacro _SweepInstDir 0
    IntCmp $R0 0 car_lockcheck_${_CAR}
    IntOp $6 $6 + 1
    IntCmp $6 12 car_force_${_CAR} car_poll_${_CAR} car_force_${_CAR}
  car_force_${_CAR}:
    !insertmacro _LogWrite "appcheck: force phase, still running: $5"
    !insertmacro _SweepInstDir 1
    Sleep 800
    !insertmacro _SweepInstDir 0
    IntCmp $R0 0 car_lockcheck_${_CAR}
    ; Still enumerable after TerminateProcess. If the files are no longer
    ; locked these are kernel ghosts (process object pinned by a stuck driver
    ; I/O — dead USB-serial adapters do this); blocking the install on them
    ; is the false "cannot be closed" loop this rework exists to fix.
    !insertmacro _ProbeExeLock
    IntCmp $3 0 car_ghost_${_CAR}
    !insertmacro _LogWrite "appcheck: unkillable AND file locked: $5"
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY car_close_${_CAR}
    !insertmacro _LogWrite "appcheck: user cancelled at appCannotBeClosed"
    Quit
  car_ghost_${_CAR}:
    !insertmacro _LogWrite "appcheck: ghost process(es) remain ($5) but files are NOT locked - proceeding"
    Goto car_done_${_CAR}
  car_lockcheck_${_CAR}:
    ; Nothing of ours is running (or ghosts only) — but verify the actual
    ; contract: the exe must be writable. Locked with zero processes visible
    ; means another session/user holds it; nothing we can kill from here.
    !insertmacro _ProbeExeLock
    IntCmp $3 0 car_done_${_CAR}
    !insertmacro _LogWrite "appcheck: no INSTDIR processes visible but POTACAT.exe is LOCKED (another user session?)"
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY car_lockcheck_${_CAR}
    Quit
  car_done_${_CAR}:
    !insertmacro _LogWrite "appcheck: done"
!macroend

; customInit runs in the installer's .onInit, BEFORE installSection's
; CHECK_APP_RUNNING. Killing the launcher here means the app-running check then
; only sees the GUI (handled gracefully). The check itself is now ours too
; (customCheckAppRunning above) — self-contained, so no electron-builder
; internals are touched. (A prior attempt re-invoked _CHECK_APP_RUNNING /
; IS_POWERSHELL_AVAILABLE and broke the NSIS build, which is why it was
; reverted; both macros here avoid them entirely.)
!macro customInit
  !insertmacro _LogWrite "=== POTACAT Installer ==="
  !insertmacro _LogWrite "customInit: Install dir = $INSTDIR"
  !insertmacro _KillLauncher
!macroend

; customUnInit runs in the uninstaller's un.onInit. For an assisted (oneClick:
; false) uninstaller, un.checkAppRunning is deferred to the uninstall section
; (after un.onInit), so stopping the launcher here clears it before that check —
; fixing the standalone "old version won't uninstall" case too.
!macro customUnInit
  !insertmacro _LogWrite "customUnInit: stopping launcher before uninstall check"
  !insertmacro _KillLauncher
!macroend

!macro customInstall
  !insertmacro _LogWrite "customInstall: Installing to $INSTDIR"

  ; Verify the main exe was written
  IfFileExists "$INSTDIR\POTACAT.exe" 0 +3
    !insertmacro _LogWrite "customInstall: POTACAT.exe EXISTS - install appears successful"
    Goto +2
    !insertmacro _LogWrite "customInstall: WARNING - POTACAT.exe NOT FOUND after install"

  ; Register potacat:// protocol handler
  WriteRegStr HKCU "Software\Classes\potacat" "" "URL:POTACAT Protocol"
  WriteRegStr HKCU "Software\Classes\potacat" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\potacat\shell\open\command" "" '"$INSTDIR\POTACAT.exe" "%1"'
  !insertmacro _LogWrite "customInstall: Registered potacat:// protocol handler"

  !insertmacro _LogWrite "customInstall: Complete"
!macroend

!macro customUnInstall
  ; Remove potacat:// protocol handler
  DeleteRegKey HKCU "Software\Classes\potacat"
!macroend
