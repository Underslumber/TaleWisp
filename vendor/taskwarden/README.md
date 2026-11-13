# TaskWarden

Локальный контроллер заданий для Codex, Claude Code, Gemini CLI и будущих адаптеров. Сохраняет буквальные требования, контролирует актуальность доказательств и возвращает исполнителя к незакрытым критериям.

Python 3.12+, SQLite, CLI и перевод нативных hook-событий. Ядро не требует внешних Python-пакетов. Автоматическая смысловая проверка использует отдельный guarded native Gemini adapter и сохранённую авторизацию официального CLI. Доставка hooks конкретным Desktop/CLI подтверждается отдельно; см. [самотест](docs/self-use.md).

## Запуск

Из корня проекта:

```powershell
python -m taskwarden --help
```

```powershell
python -m unittest discover -s tests -v
```

При желании установить CLI в отдельное окружение:

```powershell
python -m pip install --no-deps .
```

Установочная сборка использует setuptools; запуск через `python -m taskwarden` установки не требует.

## Задание

Формат требований — [examples/requirements.json](examples/requirements.json). Исходная формулировка и каждый обязательный критерий должны отражать пользовательское задание, а не удобную трактовку исполнителя. В первой версии нормализация ТЗ выполняется доверенной стороной; автоматическое извлечение требований из переписки не реализовано.

Создание задания выполняет доверенный оператор. Команда возвращает три role capabilities: owner, executor, reviewer. Вывод содержит секреты: не отправляйте его агенту и не сохраняйте в общих логах.

```powershell
python -m taskwarden --db %TASKWARDEN_HOME%\state.db --workspace %WORKSPACE% create --task demo --requirements examples\requirements.json
```

Сохраните каждую capability отдельным текстовым файлом в защищённой области. Исполнителю доступна только executor capability. Пути ниже — примеры, каталоги и права на них настраивает оператор; TaskWarden не создаёт изоляцию ОС.

```powershell
python -m taskwarden --db %TASKWARDEN_HOME%\state.db --workspace %WORKSPACE% status --task demo --role executor --token-file %TASKWARDEN_HOME%\executor.token
```

Executor регистрирует артефакт. Затем reviewer независимо читает его и принимает либо отклоняет критерий. Наличие файла само по себе не доказывает выполнение ТЗ.

```powershell
python -m taskwarden --db %TASKWARDEN_HOME%\state.db --workspace %WORKSPACE% evidence --task demo --token-file %TASKWARDEN_HOME%\executor.token --version 1 --criterion C1 --file result.txt --note "Предъявлен фактический отчёт"
```

```powershell
python -m taskwarden --db %TASKWARDEN_HOME%\state.db --workspace %WORKSPACE% review --task demo --token-file %TASKWARDEN_HOME%\reviewer.token --version 1 --criterion C1 --fingerprint REVIEWED_SHA256 --verdict ACCEPT --note "Подтверждено соответствие буквальному критерию C1"
```

`REVIEWED_SHA256` заменяется на SHA-256 именно того артефакта, который reviewer независимо прочитал. Контроллер отклонит подпись, если executor успел заменить доказательство или файл.

Исполнитель запрашивает завершение; контроллер сверяет доказательства с текущим артефактом.

```powershell
python -m taskwarden --db %TASKWARDEN_HOME%\state.db --workspace %WORKSPACE% control --task demo --role executor --token-file %TASKWARDEN_HOME%\executor.token --version 1 --event completion_request
```

Owner управляет паузой, отменой, расследованием и возобновлением. Эти операции недоступны executor. Пример паузы:

```powershell
python -m taskwarden --db %TASKWARDEN_HOME%\state.db --workspace %WORKSPACE% control --task demo --role owner --token-file %TASKWARDEN_HOME%\owner.token --version 1 --event owner_pause
```

Поправка требует ожидаемую версию, чтобы не перезаписать более новое ТЗ:

```powershell
python -m taskwarden --db %TASKWARDEN_HOME%\state.db --workspace %WORKSPACE% amend --task demo --token-file %TASKWARDEN_HOME%\owner.token --version 1 --requirements revised-requirements.json
```

История буквальных требований сохраняется отдельно от текущей версии:

```powershell
python -m taskwarden --db %TASKWARDEN_HOME%\state.db --workspace %WORKSPACE% history --task demo --token-file %TASKWARDEN_HOME%\owner.token
```

Управление owner-состояниями выполняется через CLI. Hook пользовательского сообщения пока не извлекает автоматически поправки, паузы или запросы расследования из естественного языка: доверенная сторона должна отразить их через `amend`/`control` до следующего зависимого действия. Простое заявление executor о зависимости не разрешает преждевременно прекратить работу.

## Адаптеры

### Автоматическое ревью

`supervise` работает на доверенной стороне с reviewer capability. `--context` указывает JSON с явным списком `files`; добавляйте только относящиеся к заданию исходники и доказательства. Credentials и приватные runtime-каталоги передавать нельзя. Модель получает буквальное ТЗ и содержимое выбранных файлов, а не только отчёт исполнителя.

```powershell
python -m taskwarden --db %TASKWARDEN_HOME%\state.db --workspace %WORKSPACE% supervise --task demo --token-file %TASKWARDEN_HOME%\reviewer.token --version 1 --context review-context.json --run-dir %TASKWARDEN_HOME%\reviews
```

Встроенный провайдер — установленный guarded adapter `%USERPROFILE%\.codex\tools\gemini-agy\adapter.py`. Он использует официальный native `agy`, `gemini-3.8-flash-high`, сохранённую авторизацию и локальный `useG1Credits=false`. Это не доказательство тарифов аккаунта. Нет автоматических повторов, смены модели, API или платного резерва. Неизвестный формат ответа и ошибки оставляют задачу незавершённой.

### Автоматический callback

`supervised-hook` сначала проверяет owner-состояние и доступные доказательства, при необходимости запускает независимое ревью, затем возвращает решение completion gate в нативном формате. Без всех обязательных evidence модель не вызывается. Callback читает credentials локально; в запрос модели они не входят.

Незакрытый ACTIVE проходит обычный completion gate и остаётся заблокированным, пока не появится ACCEPT с текущими проверенными evidence либо ограничение попыток не переведёт задачу в BLOCKED. Для BLOCKED и INVESTIGATION callback разрешает одну ограниченную диагностическую попытку; следующий Stop завершает ход с явным сообщением, сохраняя незавершённое состояние. Yield не вызывает completion gate и не создаёт ACCEPT. INVESTIGATION не возобновляет исходную работу до явного `owner_resume`.

Генерируемая конфигурация требует конкретный `--session-id`; входящее событие проверяется до открытия контроллера. Несовпавшая сессия игнорируется без чтения/изменения задачи и без вызова reviewer. Старый hook без привязки явно работает в legacy non-enforcing режиме для всех событий и выводит предупреждение. Счётчик одной диагностической попытки хранится транзакционно в `.taskwarden-hook-cycles.sqlite3` внутри `--run-dir` и сбрасывается привязанным событием нового пользовательского prompt. Для ошибок callback этот маркер также ограничивает повтор; если сам маркер недоступен, callback явно завершает ход незавершённым сообщением. Это ограничивает число автопродолжений, но не ограничивает отдельные действия инструмента.

После исчерпания бюджета BLOCKED возвращается до проверки evidence. В этом терминальном состоянии завершение без ACCEPT разрешено после одной диагностической попытки, чтобы избежать бесконечного цикла Stop; задача сохраняется как BLOCKED и остаётся непринятой. Ready result по-прежнему требует актуальных evidence и reviews и отдельного completion request. Resume не сбрасывает счётчик попыток.

Чтобы остановить такой ход, владелец вручную выполняет `control --task TASK --role owner --event owner_pause --version N --token-file OWNER` либо ту же команду с `--event owner_cancel`; пользовательский Interrupt в хосте также останавливает ход вне Stop callback. `owner_resume` снова разрешает продолжение, но не возвращает потраченные попытки. TaskWarden настроен здесь на Stop/SubagentStop, не на перехват каждого инструмента; инструкции расследования сами по себе не запрещают модели отдельные действия. Если Python или hook process не запустился, callback-guard может вообще не выполниться. Capabilities ограничивают действия приложения и не доказывают изоляцию секретов на уровне ОС для процессов одного пользователя.

```powershell
python -m taskwarden --db %TASKWARDEN_HOME%\state.db --workspace %WORKSPACE% supervised-hook --task demo --platform codex --executor-token-file %TASKWARDEN_HOME%\executor.token --reviewer-token-file %TASKWARDEN_HOME%\reviewer.token --context review-context.json --run-dir %TASKWARDEN_HOME%\reviews
```

На stdin подаётся JSON настоящего события среды. Для генерации проектного конфига:

```powershell
python -m taskwarden --db %TASKWARDEN_HOME%\state.db --workspace %WORKSPACE% hook-config --task demo --session-id CODEX_SESSION_ID --platform codex --executor-token-file %TASKWARDEN_HOME%\executor.token --reviewer-token-file %TASKWARDEN_HOME%\reviewer.token --context review-context.json --run-dir %TASKWARDEN_HOME%\reviews
```

Передайте полученный платформой ID текущей сессии через обязательный флаг `--session-id`; генератор переносит его в command и добавляет prompt event для сброса маркера после следующего запроса владельца. Без привязки Stop от старого конфига не применяется к задаче.

Генератор выдаёт JSON и не перезаписывает конфигурации. Codex использует `.codex/hooks.json`, Claude Code и Gemini CLI — секцию `hooks` своих project settings. Существующие настройки необходимо сохранить. Сгенерированная команда привязана к абсолютному Python и расположению TaskWarden; перенос пакета требует регенерации. Codex hook должен пройти штатный review/trust; включение через обход доверия не предусмотрено.

### Базовый callback

Команда `hook` принимает нативный JSON через stdin. Её регистрируют в конфигурации соответствующей среды после проверки версии и поведения на тестовой задаче. Конфигурации пользователя автоматически не изменяются.

```powershell
python -m taskwarden --db %TASKWARDEN_HOME%\state.db --workspace %WORKSPACE% hook --task demo --session-id CODEX_SESSION_ID --role executor --token-file %TASKWARDEN_HOME%\executor.token --platform codex
```

Другие значения `--platform`: `claude`, `gemini`. Это не имена моделей. Hook runner должен запускаться с абсолютным путём к Python и доступным пакетом TaskWarden; для запуска из произвольного cwd используйте установленный пакет.

### Квота reviewer в Desktop supervisor

При распознанной квоте Claude supervisor сохраняет stdout-диагностику и состояние `reviewer_unavailable` в привязанном journal. Задание остаётся незавершённым, обязательное ревью — ожидающим; автоматического fallback на другого провайдера нет. Одинаковое продолжение по неизменившимся данным подавляется, а уже разрешённая независимая работа продолжается. Нечёткий reset вроде `resets 12:20pm(Europe/Moscow)` не превращается в выдуманный срок. Owner может включить одну повторную попытку после проверки восстановления:

Обычная stop-классификация теперь работает локально и не запускает внешний reviewer автоматически. Интеграции, которые передают свой `runner` в `assess_stop`, сами отвечают за наличие допустимого `CLAUDE_GATE`; это не является разрешением на дополнительный reviewer-вызов.

```powershell
python -m taskwarden.desktop --db %TASKWARDEN_HOME%\state.db --workspace %WORKSPACE% --task demo --thread CODEX_THREAD_ID --executor-token-file %TASKWARDEN_HOME%\executor.token --journal %TASKWARDEN_HOME%\desktop-watch.json --contract-file %TASKWARDEN_HOME%\desktop-contract.json --retry-reviewer --owner-token-file %TASKWARDEN_HOME%\owner.token
```

This authenticates and queues a one-shot, version-bound request for the running watcher; the watcher consumes it during polling, reassesses the already-sent final, and does not resend the old continuation. The owner token is not written to the inbox.

Полная инструкция supervisor: [docs/desktop.md](docs/desktop.md).

## Ограничения

### Проверка до запуска

Новый `dispatch` проверяет текущую ACTIVE-версию буквального ТЗ, его SHA-256, зарегистрированное назначение роли, provider/model/effort и точные байты входа **до создания процесса**. Неизвестная роль, другая модель, устаревшая версия, изменённый вход или неподходящий тип ролевого пакета дают отказ; launcher не вызывается. Политика `dispatch` хранится в версии требований и меняется только owner через обычный `amend`. Старое задание без политики не даёт неявного разрешения на запуск.

CLI сам строит команду штатного Codex CLI либо ограниченного packet-only Claude Opus. Executor не передаёт shell-команду или дополнительные аргументы. Повторный id не запускает процесс снова. Изменение ТЗ/состояния во время работы отменяет принятие результата. В SQLite остаются отдельные события preflight, фактического старта с PID и завершения/отказа.

Это контроль только пути `taskwarden dispatch`. Он не перехватывает произвольный `collaboration.spawn_agent`, ручной запуск CLI или все инструменты Desktop; такой глобальный hook не заявляется. Для подконтрольного задания все модельные запуски должны идти через этот путь. Результат проверки формата и модели не доказывает художественное качество или полную смысловую верность ТЗ: это отдельное независимое ревью.

Новая команда принимает `--task`, `--token-file` executor, `--version`, `--request` (JSON без исполняемых команд) и `--run-dir`. JSON задаёт id, зарегистрированную роль, provider/model/effort/purpose, относительный input_file, input_sha256 и requirements_sha256. Контракт требований добавляет optional `dispatch` с context_id и словарём roles (provider, model, effort, purpose, input_kind, instruction). Существующие задания без dispatch сохраняют API завершения, но не получают право модельного запуска. Старый hook без обязательной привязки session-id не применяет completion gate; совместимость таких legacy-конфигураций не заявляется.

- Это доверенный локальный контроллер, не sandbox. Процесс с правом записи в БД или код может обойти прикладную авторизацию.
- БД, owner/reviewer credentials и код контроллера следует защищать от executor средствами среды. CLI пока не предоставляет отдельный сетевой брокер с разными ОС-идентичностями.
- Hooks охватывают только поддерживаемые пути инструментов. Их отсутствие, ошибки загрузки и таймауты хоста могут пропускать действия; нельзя объявлять это полным fail-closed.
- Путь, хеш и успешная команда не заменяют проверку пользовательского результата. Автоматический модельный reviewer может ошибаться; его результат привязывается к буквальным критериям, версии и fingerprints. Надёжность смысловой оценки требует накопления испытаний на реальных задачах.
- Остановка уже запущенного внешнего действия и откат его побочных эффектов не гарантируются.
- Протокольные тесты не подтверждают работу в установленном Desktop/CLI. Живые интеграционные проверки отмечаются отдельно.

Подробности: [архитектура](docs/architecture.md), [критерии испытаний](docs/acceptance.md).

