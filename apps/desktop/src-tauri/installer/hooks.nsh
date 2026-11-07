; 不替用户终止桌宠/Runtime；运行中的文件只能由显式退出流程释放。
!macro ManekiRequireUnlocked filename
  ${If} ${FileExists} "$R8\${filename}"
    System::Call 'kernel32::CreateFileW(w "$R8\${filename}", i 0x40000000, i 7, p 0, i 3, i 0, p 0) i .r0'
    ${If} $0 == -1
      IfSilent +2
      MessageBox MB_ICONSTOP "Please exit Maneki assistant before installing or uninstalling. No process was stopped."
      SetErrorLevel 32
      Quit
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p r0)'
  ${EndIf}
!macroend

!macro ManekiDefineGuard prefix
Function ${prefix}ManekiCheckPath
  Exch $R8
  Push $0
  !insertmacro ManekiRequireUnlocked "${MAINBINARYNAME}.exe"
  !insertmacro ManekiRequireUnlocked "maneki-runtime.exe"
  Pop $0
  Pop $R8
FunctionEnd
!macroend

!macro ManekiCheckInstallPaths
  Push "$INSTDIR"
  Call ManekiCheckPath
  Push $R8
  ReadRegStr $R8 SHCTX "${MANUPRODUCTKEY}" ""
  Push "$R8"
  Call ManekiCheckPath
  Pop $R8
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro ManekiCheckInstallPaths
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --assistant register' $0
  ${If} $0 != 0
    IfSilent +2
    MessageBox MB_ICONSTOP "Maneki entry registration failed. Please start the installed app once before using dsh."
    SetErrorLevel 5
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Push "$INSTDIR"
  Call un.ManekiCheckPath
  ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --assistant unregister' $0
  ${If} $0 != 0
    SetErrorLevel 5
    Abort
  ${EndIf}
!macroend
