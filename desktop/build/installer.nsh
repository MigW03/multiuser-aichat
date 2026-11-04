; Nido's uninstaller (electron-builder's one-click NSIS installer, picked up from build/installer.nsh).
;
; Uninstalling keeps the person's data by default: their sign-in, the list of shared folders and files, connected tool servers
; and custom panels sit in %APPDATA%\Multiuser Chat (the folder keeps the app's old name), so a reinstall finds them again and
; nothing is lost silently. An uninstall the person starts asks once whether to delete that folder too; the answer defaults to No.
; Updates run the old uninstaller silently (/S): they never ask and never delete.

Var NidoEraseData

!macro customUnInit
  StrCpy $NidoEraseData "0"
  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "/S" $R1
  ${If} ${Errors}
    ; no /S: a person is uninstalling (the one-click uninstaller has already asked "are you sure")
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your Nido data on this computer?$\r$\n$\r$\nThis removes your sign-in, your list of shared folders and files (the files themselves are not touched), your connected tool servers and your custom panels.$\r$\n$\r$\nChoose No to keep them for a later reinstall." IDNO nidoKeepData
    StrCpy $NidoEraseData "1"
    nidoKeepData:
  ${EndIf}
!macroend

!macro customUnInstall
  ${If} $NidoEraseData == "1"
    RMDir /r "$APPDATA\Multiuser Chat"
  ${EndIf}
!macroend
