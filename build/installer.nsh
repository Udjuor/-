; Дополнительные шаги установщика. Подключается из electron-builder (nsis.include).
!include "FileFunc.nsh"

Var calHome
Var calOutput
Var calArgs
Var calDataDir

!define CAL_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define CAL_RUN_NAME "StudentCalendar"

!macro customInstall
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

  ; Тихая установка на все панели: Setup.exe /S /DATADIR=\\server\calendar
  ${GetParameters} $calArgs
  ClearErrors
  ${GetOptions} $calArgs "/DATADIR=" $calDataDir
  ${IfNot} ${Errors}
    WriteINIStr "$calHome\config.ini" "calendar" "dataDir" "$calDataDir"
  ${EndIf}
!macroend

!macro customUnInstall
  ; Папку с данными не трогаем: мероприятия переживают обновление и удаление.
  DeleteRegValue HKLM "${CAL_RUN_KEY}" "${CAL_RUN_NAME}"
!macroend
