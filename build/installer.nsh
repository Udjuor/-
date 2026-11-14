; Дополнительные шаги установщика. Подключается из electron-builder (nsis.include).
!include "FileFunc.nsh"
!include "WordFunc.nsh"

!define CAL_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define CAL_RUN_NAME "Kerdiis"
!define CAL_OLD_NAME "StudentCalendar"

; Папка программы задаётся здесь, иначе обновление оставит её под прежним именем.
!macro preInit
  SetRegView 64
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "$PROGRAMFILES64\Kerdiis"
  SetRegView 32
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "$PROGRAMFILES64\Kerdiis"
!macroend

; Прошлые версии назывались StudentCalendar.exe: проверка установщика их не видит.
!macro customInit
  nsExec::Exec 'taskkill /F /IM ${CAL_OLD_NAME}.exe'
  Pop $R9
!macroend

!macro customInstall
  ; Переменные объявлены здесь: сборка программы удаления этот макрос не использует.
  Var /GLOBAL calHome
  Var /GLOBAL calOldHome
  Var /GLOBAL calOutput
  Var /GLOBAL calArgs
  Var /GLOBAL calSyncKey
  Var /GLOBAL calPeers
  Var /GLOBAL calEdition
  Var /GLOBAL calFile

  ; Автозапуск для всех учётных записей компьютера. Запись видна
  ; в «Параметры → Приложения → Автозагрузка» и в диспетчере задач.
  WriteRegStr HKLM "${CAL_RUN_KEY}" "${CAL_RUN_NAME}" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  DeleteRegValue HKLM "${CAL_RUN_KEY}" "${CAL_OLD_NAME}"

  ; Общая папка настроек и данных. Без этого права на запись были бы только
  ; у той учётной записи, которая запустила программу первой.
  ; S-1-5-32-545 — группа «Пользователи», имя зависит от языка Windows, SID нет.
  ReadEnvStr $calHome "ProgramData"
  StrCpy $calOldHome "$calHome\${CAL_OLD_NAME}"
  StrCpy $calHome "$calHome\${CAL_RUN_NAME}"
  ; Данные прошлых версий переезжают целиком. Если папка занята, программа продолжит работать в ней.
  ${If} ${FileExists} "$calOldHome\*.*"
  ${AndIfNot} ${FileExists} "$calHome\*.*"
    ClearErrors
    Rename "$calOldHome" "$calHome"
    ClearErrors
    ${If} ${FileExists} "$calOldHome\*.*"
      StrCpy $calHome "$calOldHome"
    ${EndIf}
  ${EndIf}
  CreateDirectory "$calHome"
  nsExec::Exec 'icacls "$calHome" /grant *S-1-5-32-545:(OI)(CI)M /T /Q'
  Pop $calOutput

  ; Обмен между устройствами идёт по локальной сети: без правила брандмауэр
  ; не пропустит входящие подключения.
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${CAL_OLD_NAME}"'
  Pop $calOutput
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${CAL_RUN_NAME}"'
  Pop $calOutput
  nsExec::Exec 'netsh advfirewall firewall add rule name="${CAL_RUN_NAME}" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" enable=yes profile=any'
  Pop $calOutput
  ; Порты обмена отдельно: правило на программу перестаёт действовать, если папку программы поменяли.
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Kerdiis sync"'
  Pop $calOutput
  nsExec::Exec 'netsh advfirewall firewall add rule name="Kerdiis sync" dir=in action=allow protocol=TCP localport=47800,47880 enable=yes profile=any'
  Pop $calOutput
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Kerdiis discovery"'
  Pop $calOutput
  nsExec::Exec 'netsh advfirewall firewall add rule name="Kerdiis discovery" dir=in action=allow protocol=UDP localport=47801 enable=yes profile=any'
  Pop $calOutput

  ; Автообновление. Программа стоит на весь компьютер, поэтому обновить её
  ; может только администратор: это делает системная задача, а не пользователь.
  ; Каталог лежит в Program Files, где обычные пользователи не могут менять файлы.
  CreateDirectory "$PROGRAMFILES64\KerdiisUpdate"
  SetOutPath "$PROGRAMFILES64\KerdiisUpdate"
  File "${BUILD_RESOURCES_DIR}\update.ps1"
  File "${BUILD_RESOURCES_DIR}\register-tasks.ps1"
  SetOutPath "$INSTDIR"
  ; Установщик 32-битный: sysnative запускает 64-битный PowerShell.
  nsExec::ExecToLog '"$WINDIR\sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PROGRAMFILES64\KerdiisUpdate\register-tasks.ps1"'
  Pop $calOutput

  ; Установка на все устройства: Setup.exe /S /SYNCKEY=ключ /PEERS=10.0.2.15,10.0.3.7
  ${GetParameters} $calArgs
  ClearErrors
  ${GetOptions} $calArgs "/SYNCKEY=" $calSyncKey
  ${IfNot} ${Errors}
    WriteINIStr "$calHome\config.ini" "calendar" "syncKey" "$calSyncKey"
  ${EndIf}
  ClearErrors
  ${GetOptions} $calArgs "/PEERS=" $calPeers
  ${IfNot} ${Errors}
    WriteINIStr "$calHome\config.ini" "calendar" "peers" "$calPeers"
  ${EndIf}

  ; Версия программы.
  ; Ручной запуск решает по имени установщика: Kerdiis-Admin-Setup ставит версию для
  ; преподавателей, Kerdiis-Setup — клиент для панелей, что бы ни стояло раньше.
  ; Тихий запуск (автообновление, массовая установка) сохраняет прежнюю версию:
  ; файл лежит в каталоге, который переживает обновление. /EDITION= важнее всего.
  StrCpy $calEdition "client"
  ${If} ${Silent}
  ${AndIf} ${FileExists} "$PROGRAMFILES64\KerdiisUpdate\edition.txt"
    FileOpen $calFile "$PROGRAMFILES64\KerdiisUpdate\edition.txt" r
    FileRead $calFile $calEdition
    FileClose $calFile
  ${EndIf}
  ClearErrors
  ${WordFind} "$EXEFILE" "Admin" "E+1{" $calOutput
  ${IfNot} ${Errors}
    StrCpy $calEdition "admin"
  ${EndIf}
  ClearErrors
  ${GetOptions} $calArgs "/EDITION=" $calOutput
  ${IfNot} ${Errors}
    StrCpy $calEdition "$calOutput"
  ${EndIf}
  ClearErrors
  ${If} $calEdition != "admin"
    StrCpy $calEdition "client"
  ${EndIf}
  FileOpen $calFile "$PROGRAMFILES64\KerdiisUpdate\edition.txt" w
  FileWrite $calFile "$calEdition"
  FileClose $calFile
  FileOpen $calFile "$INSTDIR\edition.txt" w
  FileWrite $calFile "$calEdition"
  FileClose $calFile
!macroend

!macro customUnInstall
  ; Папку с данными не трогаем: мероприятия переживают обновление и удаление.
  DeleteRegValue HKLM "${CAL_RUN_KEY}" "${CAL_RUN_NAME}"
  DeleteRegValue HKLM "${CAL_RUN_KEY}" "${CAL_OLD_NAME}"
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${CAL_RUN_NAME}"'
  Pop $R9
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Kerdiis sync"'
  Pop $R9
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Kerdiis discovery"'
  Pop $R9
  ; При обновлении задачи и каталог нужны, в них выполняется сам процесс обновления.
  ${ifNot} ${isUpdated}
    nsExec::Exec 'schtasks.exe /Delete /F /TN KerdiisUpdate'
    Pop $R9
    nsExec::Exec 'schtasks.exe /Delete /F /TN KerdiisLaunch'
    Pop $R9
    RMDir /r "$PROGRAMFILES64\KerdiisUpdate"
    nsExec::Exec 'schtasks.exe /Delete /F /TN ${CAL_OLD_NAME}Update'
    Pop $R9
    nsExec::Exec 'schtasks.exe /Delete /F /TN ${CAL_OLD_NAME}Launch'
    Pop $R9
    RMDir /r "$PROGRAMFILES64\${CAL_OLD_NAME}Update"
  ${endIf}
!macroend
