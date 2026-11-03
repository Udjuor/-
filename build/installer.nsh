; Дополнительные шаги установщика. Подключается из electron-builder (nsis.include).
!include "FileFunc.nsh"

!define CAL_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define CAL_RUN_NAME "StudentCalendar"

!macro customInstall
  ; Переменные объявлены здесь: сборка программы удаления этот макрос не использует.
  Var /GLOBAL calHome
  Var /GLOBAL calOutput
  Var /GLOBAL calArgs
  Var /GLOBAL calSyncKey
  Var /GLOBAL calPeers

  ; Автозапуск для всех учётных записей компьютера. Запись видна
  ; в «Параметры → Приложения → Автозагрузка» и в диспетчере задач.
  WriteRegStr HKLM "${CAL_RUN_KEY}" "${CAL_RUN_NAME}" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'

  ; Общая папка настроек и данных. Без этого права на запись были бы только
  ; у той учётной записи, которая запустила программу первой.
  ; S-1-5-32-545 — группа «Пользователи», имя зависит от языка Windows, SID нет.
  ReadEnvStr $calHome "ProgramData"
  StrCpy $calHome "$calHome\StudentCalendar"
  CreateDirectory "$calHome"
  nsExec::Exec 'icacls "$calHome" /grant *S-1-5-32-545:(OI)(CI)M /T /Q'
  Pop $calOutput

  ; Обмен между устройствами идёт по локальной сети: без правила брандмауэр
  ; не пропустит входящие подключения.
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${CAL_RUN_NAME}"'
  Pop $calOutput
  nsExec::Exec 'netsh advfirewall firewall add rule name="${CAL_RUN_NAME}" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" enable=yes profile=any'
  Pop $calOutput

  ; Автообновление. Программа стоит на весь компьютер, поэтому обновить её
  ; может только администратор: это делает системная задача, а не пользователь.
  ; Каталог лежит в Program Files, где обычные пользователи не могут менять файлы.
  CreateDirectory "$PROGRAMFILES64\StudentCalendarUpdate"
  SetOutPath "$PROGRAMFILES64\StudentCalendarUpdate"
  File "${BUILD_RESOURCES_DIR}\update.ps1"
  File "${BUILD_RESOURCES_DIR}\register-tasks.ps1"
  SetOutPath "$INSTDIR"
  ; Установщик 32-битный: sysnative запускает 64-битный PowerShell.
  nsExec::ExecToLog '"$WINDIR\sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PROGRAMFILES64\StudentCalendarUpdate\register-tasks.ps1"'
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
!macroend

!macro customUnInstall
  ; Папку с данными не трогаем: мероприятия переживают обновление и удаление.
  DeleteRegValue HKLM "${CAL_RUN_KEY}" "${CAL_RUN_NAME}"
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${CAL_RUN_NAME}"'
  Pop $R9
  ; При обновлении задачи и каталог нужны, в них выполняется сам процесс обновления.
  ${ifNot} ${isUpdated}
    nsExec::Exec 'schtasks.exe /Delete /F /TN StudentCalendarUpdate'
    Pop $R9
    nsExec::Exec 'schtasks.exe /Delete /F /TN StudentCalendarLaunch'
    Pop $R9
    RMDir /r "$PROGRAMFILES64\StudentCalendarUpdate"
  ${endIf}
!macroend
