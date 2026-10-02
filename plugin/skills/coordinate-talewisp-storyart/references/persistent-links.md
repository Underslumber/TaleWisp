# Постоянная связь TaleWisp–StoryArt

Канон и связи с сюжетом принадлежат TaleWisp. Утверждённая внешность, изображения,
костюмы, визуальная QA и регистрация принадлежат StoryArt. Данные связи не меняют
канон и не задают модель генератора.

## Привязка персонажа

Храни четыре плоских YAML-поля в существующей карточке персонажа:

```yaml
storyart_project_path: "/absolute/path/to/StoryArt"
storyart_style_pack: "EXAMPLE_STYLE"
storyart_character_id: "CHAR_EXAMPLE"
storyart_character_name: "Мира"
```

Это составная идентичность `project + style_pack + character_id`. Один CHAR_EXAMPLE
может встречаться в разных стилевых пакетах. Название помогает человеку, но не
заменяет ID. Не сохраняй в эти поля пути к конкретным референсам, процент стиля
или выбор BODY_REFERENCE_LIBRARY: StoryArt разрешает актуальные источники,
а текущий выбор автора передаётся отдельно в задании.

При изменении привязки сохраняй остальные метаданные, тело карточки, её
canon_status и формат перевода строк. Перед записью проверяй хеш карточки.
Настройка привязки требует поручения автора; она не является утверждением арта.

## Запрос и сюжетные координаты

Новый арт создаёт отдельный новый чат StoryArt. Коррекции того же PAIR_ID идут
в этот чат. Передай CHARACTER_BINDINGS и STORY_TARGETS в первоначальном brief.
Не ищи утверждённые источники в чужих pending-папках.

Каждая сюжетная координата — путь относительно активного vault к существующему
Markdown-файлу; для события используй точный якорь, например
`Автор/Пример/Серия/Анализ/Хронология.md#EXAMPLE-EVENT`.
Путь относительно проекта с префиксом `vault/` сначала переводи в vault-relative
форму. Не выбрасывай фрагмент ссылки. Сцены, события, сюжетные линии, персонажи,
места и артефакты могут быть отдельными целями одной иллюстрации.

## Кандидат и подтверждённый арт

```text
ТЗ + карточка -> новый чат StoryArt -> генерация -> VISUAL_QA
                                            -> CANON_QA TaleWisp
                                            -> кандидат TEST
                                            -> явное «сохраняй» автора
                                            -> регистрация APPROVED в StoryArt
                                            -> receipt с точным файлом и SHA-256
                                            -> связанная art-note в TaleWisp
```

Кандидат сохраняется в служебном каталоге активного vault
`.talewisp/storyart/requests/`. Он не попадает в подтверждённый каталог артов.
Успешные QA, «продолжай», утверждение системы или карточки не заменяют
подтверждение сохранения конкретного изображения.

После прямого подтверждения автора попроси владельца выделенного StoryArt-чата
утвердить точный файл штатным менеджером и экспортировать TALEWISP_LINK.json.
Если утверждение создаёт новый generation_id/путь, сохрани parent_generation_id
и проверь новое зарегистрированное изображение; не считай старый TEST уже
утверждённым. Нельзя менять реестры StoryArt из TaleWisp.

Подтверждённая art-note содержит привязку к зарегистрированному изображению,
SHA-256, PAIR_ID, generation_id, цитату подтверждения и `[[ссылки]]` на сюжетные
цели. Obsidian показывает её в обратных ссылках этих карточек. Не копируй пиксели
в TaleWisp и не переписывай описания сцен по изображению. Несколько иллюстраций
одной сцены остаются отдельными записями.

## Обратный receipt StoryArt

```json
{
  "schema_version": 1,
  "pair_id": "TW_SA_EXAMPLE",
  "talewisp_project_path": "/absolute/path/to/TaleWisp",
  "storyart": {
    "project_path": "/absolute/path/to/StoryArt",
    "style_pack": "EXAMPLE_STYLE",
    "character_id": "CHAR_EXAMPLE",
    "character_name": "Мира"
  },
  "targets": [
    {
      "kind": "character",
      "reference": "Автор/Пример/Серия/Сущности/Мира.md"
    },
    {
      "kind": "scene",
      "reference": "Автор/Пример/Серия/Книги/Книга/Сцены/Сцена.md"
    },
    {
      "kind": "event",
      "reference": "Автор/Пример/Серия/Анализ/Хронология.md#EXAMPLE-EVENT"
    }
  ],
  "generation_id": "GEN_EXAMPLE",
  "registered_image_path": "/absolute/path/to/StoryArt/GENERATION_RESULTS/example.png",
  "sha256": "<exact SHA-256 of registered file>",
  "visual_qa": "PASS",
  "canon_qa": "PASS",
  "author_approval": "NOT_GIVEN",
  "status": "TEST"
}
```

При подтверждённом сохранении статус — APPROVED или APPROVED_SCENE;
`author_approval: "GIVEN"` сопровождается `author_approval_quote` с точной цитатой
автора. Для прежних receipt допустима сама цитата в author_approval; одного
статуса GIVEN без цитаты недостаточно. Receipt проверяется
по PAIR_ID, зарегистрированному generation_id, файлу, хешу, привязке и целям.
Передача receipt не разрешает произвольную запись в сторонний проект.

## Детерминированный инструмент

Общий CLI и MCP реализованы в `plugin/scripts/storyart_links.py`.
Используй JSON request-файлы, чтобы не экранировать кириллицу и пути в shell.
Запускай CLI из корня TaleWisp с явно выбранным vault; request-файлы относятся
к служебной подготовке, а не к канону.

```powershell
python plugin/scripts/storyart_links.py --vault vault --request-file .agent/storyart-bind-character.json bind-character
```

Request для `bind-character` содержит `card_path` (vault-relative), четыре
`storyart_*` поля из карточки, `expected_source_sha256` (SHA-256 исходных байтов
карточки) и `confirmed: true`, только когда автор поручил эту запись.
`resolve-character` получает `card_path` и возвращает актуальную привязку.

Request для `stage-art` имеет оболочку `{"request": {...}}`. Внутри нужны
`pair_id`, `generation_id`, `image_path`, `image_sha256`, абсолютный
`storyart_project_path`, `storyart_thread_id`, `storyart_style_pack`,
`targets: [{"kind": "scene", "reference": "Сцены/Сцена.md"}]`,
`visual_qa`, `canon_qa`, `title` и `talewisp_project_path`.
Для иллюстрации конкретного персонажа передай также `storyart_character_id`,
`storyart_character_name` и цель `character` с его карточкой. Для мест,
сюжетных сцен без именованного героя и артефактов привязка персонажа не нужна.
Для нескольких персонажей передай `character_bindings` с записью для каждой
целевой карточки: `path`, `style_pack`, `character_id`; не приписывай им один ID.
Проверяемое изображение должно находиться внутри названного StoryArt-проекта.
Никакое значение status во входном request не утверждает арт при staging.

Исправление ещё не утверждённого кандидата сохраняет PAIR_ID. Перед заменой
прочитай текущую запись и передай `expected_candidate_sha256` рядом с оболочкой
`request`. Инструмент сохраняет предыдущую запись в служебной истории и
отказывает при изменившемся хеше. Замена без этого поля запрещена. Утверждённую
связь такая операция не перезаписывает.

```powershell
python plugin/scripts/storyart_links.py --vault vault --request-file .agent/storyart-stage.json stage-art
```

Request для `confirm-art`: `pair_id`, `destination_path` (новая art-note
относительно vault), `receipt_path` (точный receipt StoryArt), `confirmed: true`.
Выполняй только после подтверждения сохранения автором и receipt APPROVED.
Существующая карточка с другим содержимым не перезаписывается. Если approval
создал новый ID или скопировал изображение в утверждённый каталог, receipt
должен явно указать `parent_generation_id` исходного кандидата. Инструмент
проверяет одинаковый SHA-256 обоих файлов и принадлежность проекту StoryArt;
art-note использует новый утверждённый ID и путь, а запись кандидата хранит
исходную привязку. Изменённые пиксели требуют нового проверенного кандидата,
а не подмены файла при подтверждении.

```powershell
python plugin/scripts/storyart_links.py --vault vault --request-file .agent/storyart-confirm.json confirm-art
```

`list-art` принимает необязательные `pair_id` и `approved_only`.
`context` принимает vault-relative `path` карточки/сцены/события и возвращает
связанные подтверждённые артефакты. Запрос с якорем ищет именно это событие;
без якоря — все связанные цели файла. Повреждённые или отсутствующие
утверждённые файлы и записи исключаются из подтверждённого контекста с
диагностикой. Перед подготовкой brief используй эту
выборку вместе с `resolve-character`, чтобы получить актуальные связи.
`validate` проверяет актуальный зарегистрированный файл, хеш art-note и
существование целей, включая их якоря.

MCP-аналоги: `talewisp_storyart_bind_character`,
`talewisp_storyart_resolve_character`, `talewisp_storyart_stage_art`,
`talewisp_storyart_confirm_art`, `talewisp_storyart_list_art`,
`talewisp_storyart_context`, `talewisp_storyart_validate`. CLI и MCP вызывают
один модуль, а не разные реализации жизненного цикла.

Исходники плагина в проекте и установленная копия Codex различаются. Если новые
MCP tools ещё не доступны в текущем чате, используй этот же CLI. Не объявляй
обновление локальных исходников загрузкой tools в уже запущенную сессию.
