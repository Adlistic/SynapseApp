; HyperVoice Code installer hooks.
;
; Before 0.3.3 the app was "Synapse" (id com.adlistic.synapse, program
; synapse2-desktop.exe). Its installer registered under a different name, so
; without this, updating from Synapse would leave both apps installed, and the
; old one would keep offering the update. After installing, quietly uninstall
; that old copy.
;
; Only removes it when the uninstall entry is provably ours: DisplayName
; "Synapse" AND MainBinaryName "synapse2-desktop.exe" (other software is also
; called Synapse). The silent uninstall never deletes app data, so the new app
; can still carry the old settings over on first start.

!macro NSIS_HOOK_POSTINSTALL
  Push $R0
  Push $R1
  Push $R2
  Push $R3

  StrCpy $R3 "Software\Microsoft\Windows\CurrentVersion\Uninstall\Synapse"
  ReadRegStr $R0 HKCU $R3 "DisplayName"
  ReadRegStr $R1 HKCU $R3 "MainBinaryName"
  ReadRegStr $R2 HKCU $R3 "InstallLocation"
  ${If} $R0 == "Synapse"
  ${AndIf} $R1 == "synapse2-desktop.exe"
  ${AndIf} $R2 != ""
    ; InstallLocation is stored with surrounding quotes.
    StrCpy $R0 $R2 1
    ${If} $R0 == '"'
      StrCpy $R2 $R2 -1 1
    ${EndIf}
    ${If} ${FileExists} "$R2\uninstall.exe"
    ${AndIf} $R2 != $INSTDIR
      ; An auto-update runs this installer with /UPDATE, which creates no
      ; shortcuts. Put ours wherever Synapse had one, before its uninstaller
      ; removes them, so the user isn't left without a way to open the app.
      ${If} ${FileExists} "$SMPROGRAMS\Synapse.lnk"
      ${AndIfNot} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
        CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
        !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      ${EndIf}
      ${If} ${FileExists} "$DESKTOP\Synapse.lnk"
      ${AndIfNot} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
        CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
        !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
      ${EndIf}
      DetailPrint "Removing the old Synapse install from $R2"
      ; _?= runs the uninstaller in place and waits for it to finish.
      ExecWait '"$R2\uninstall.exe" /S _?=$R2'
      Delete "$R2\uninstall.exe"
      RMDir "$R2"
    ${EndIf}
  ${EndIf}

  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
