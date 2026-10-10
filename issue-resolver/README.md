# Issue Resolver

Оркестратор `pi`-агентов, которые решают задачи разработки: на вход — тикет
(Jira) и git-репозитории, на выход — изменение кода, отчёт о шагах и MR/PR.
Агенты работают в отдельном контейнере задачи, шаги конвейера идут по порядку,
результаты каждого шага и живой лог стримятся в веб-UI.

Проект — npm-workspaces:

| Пакет | Что внутри |
| --- | --- |
| `shared/` | Доменные типы, статусная модель, чистые функции (workflow, разбор отчёта шага, статус задачи) — контракт для всех пакетов |
| `backend/` | Fastify 5 REST API, workflow-движок, SQLite/Drizzle, адаптеры (docker/git/pi/MR/Jira/RPC) |
| `frontend/` | React 19 + Vite 6 + Tailwind 4 SPA (тема Matrix/hackerman) |
| `e2e/` | Playwright-сценарии UI |

## Запуск

```bash
npm install

# backend: Fastify на 0.0.0.0:8080 (PORT переопределяет порт)
cd backend && npm run start

# frontend: Vite dev-сервер на 0.0.0.0:5173, проксирует /issue-resolver → http://localhost:8080
cd frontend && npm run dev -- --host 0.0.0.0 --port 5173

# e2e (использует уже поднятые backend:8080 + frontend:5173)
cd e2e && npx playwright test
```

**Лаунчер `bin/service.sh`.** `start|stop|restart|status` поднимает/гасит backend
+ frontend; режим задаётся `IR_MODE=local|docker` (дефолт `local`), PID-файлы и
логи — в `/tmp` (переопределяются `IR_PID_DIR`/`IR_LOG_DIR`).

**Доступ по локальной сети (LAN).** Backend слушает `0.0.0.0:8080`, Vite —
`0.0.0.0:5173` и проксирует `/issue-resolver` на `localhost:8080`, поэтому
наружу достаточно опубликовать один порт UI. `agent-fwd up 5173:5173`
(на хосте, где есть Docker CLI и `docker.sock`) поднимает sidecar, публикующий
`5173` контейнера на `0.0.0.0` хоста — UI открывается по `http://<host-IP>:5173`.
Сам бэкенд наружу не выводится. Внутри dev-контейнера docker CLI/`docker.sock`
нет, поэтому `agent-fwd` запускается с хоста.

Backend по умолчанию поднимается с in-memory фейками docker/git/pi/MR/Jira/RPC —
без реальных контейнеров и git-пуша. Продовый wiring — это
`buildDepsFromEnv(process.env)` в `server.ts`:

- **Локальный режим (dev без docker) — `ISSUE_RESOLVER_LOCAL=1`**: pi
  запускается НАПРЯМУЮ на хосте (`RpcPiRunner('local')`), контейнер задачи —
  обычная host-папка (`LocalContainerController` — mkdir/rm), git — `GitCliService`,
  workspace root по умолчанию `/home/agent/.issue-resolver/workspaces`
  (переопределяется `ISSUE_RESOLVER_WORKSPACE_ROOT`).
- **Прод docker-ветка — `ISSUE_RESOLVER_USE_REAL=1`**: изолированные
  контейнеры задач, боевые `DockerodeContainerController` (`DOCKER_SOCKET`,
  дефолт `/var/run/docker.sock`), `GitCliService`, `RpcPiRunner('docker')`,
  `HttpMrClient` (`MR_TOKEN`), `HttpJiraClient` (`JIRA_BASE_URL`,
  `JIRA_TOKEN`) и `InMemoryStepSessionRegistry` (steer/abort/respond живых шагов).

Иначе — пустой объект и безопасные Fake*-адаптеры `buildApp(db, deps)`. Имя
общего named volume для памяти модели — `ISSUE_RESOLVER_MEMORY_VOLUME` (дефолт
`agent-memory`). Данные лежат в SQLite (`backend/data/issue-resolver.db`, таблицы
создаются идемпотентно при старте).

## API

Все бизнес-роуты — под префиксом `/issue-resolver/api/v1`.

| Метод и путь | Запрос | Ответ |
| --- | --- | --- |
| `GET /ping` | — | `{ ok: true }` |
| `POST /issues` | `CreateIssueRequest` (JSON) **или** `multipart/form-data` (`payload` + `files`) | `201 Issue`; создаёт итерацию №1 и запускает её в фоне; загруженные файлы сохраняются в рабочую папку |
| `GET /issues` | — | `Issue[]` (по `created_at` убыв.) |
| `GET /issues/:id` | — | `Issue` / `404 { error }` |
| `GET /issues/:id/result` | — | результат задачи inline: `report.md` (`text/markdown`) или `report.html` (`text/html`); нет файла → `404 { error: 'result not found' }` |
| `GET /issues/:id/result/download` | — | тот же файл как `Content-Disposition: attachment; filename="report.md"` (или `report.html`) / `404` |
| `GET /issues/:id/iterations` | — | `Iteration[]` (по `number` возр.) / `404` |
| `POST /issues/:id/iterations` | `{ context, review_context?, is_review_need?, steps?, model? }` (JSON) **или** multipart (`payload` + `files`) | `201 Iteration`; запускает прогон в фоне; файлы итерации — в `attachments/iteration-<n>/` |
| `GET /issues/:id/files` | — | `IssueFile[]` (загруженные файлы задачи; `rel_path` от корня рабочей папки, `iteration_id` для группировки) / `404` |
| `DELETE /files/:fileId` | — | `204`; удаляет строку и файл с диска (best-effort, guard от path traversal) / `404` |
| `GET /files/:fileId/content` | — | `200` содержимое файла: `Content-Type: <mime_type>` (fallback `application/octet-stream`) + `Content-Disposition: attachment; filename="…"` (safe ASCII + `filename*=UTF-8''…`) / `404` (нет строки, файла или путь вне `attachments/`) |
| `GET /iterations/:id/step-runs` | — | `StepRunWithLog[]` (порядок шагов конвейера, внутри шага `attempt` возр.; сырой лог шага) / `404` |
| `GET /issues/:id/stream` | — | SSE: `data: <SSEEvent JSON>\n\n` |
| `POST /iterations/:id/message` | `{ message }` | `{ ok: true }` (steer активного шага) / `409 { error: 'no active step session' }` / `400` |
| `POST /iterations/:id/prompt` | `{ message, mode?: 'steer' \| 'followUp' }` | `PromptResult`: `{ ok, disposition: 'started' \| 'queued' \| 'handled', error? }` (`error` — при `ok:false`) / `400` / `409 { error: 'no active step session' }` |
| `GET /iterations/:id/control` | — | `SessionControlSnapshot`: `{ state, models, thinkingLevels, commands }` / `409 { error: 'no active step session' }` |
| `POST /iterations/:id/control` | `{ command: SessionCommand }` | `ControlResult`: `{ ok, data?, error? }` / `400` (неизвестный/невалидный `command`) / `409` (нет сессии) / `504` (таймаут pi) |
| `POST /iterations/:id/abort` | — | `{ ok: true }` всегда: отменяет активный шаг, а без живой сессии доводит итерацию до терминального `cancelled` (шаги → `aborted`) |
| `POST /iterations/:id/ui-response` | `{ id, value?, confirmed?, cancelled? }` | `{ ok: true }` (ответ на интерактивный вопрос шага; сохраняется и без живой сессии) / `400` (нет `id` или ответа) |
| `GET /models` | — | `ModelDescriptor[]` |

Встроенные интерактивные команды pi на `POST /iterations/:id/prompt`
перехватываются сервером и транслируются в явные RPC-команды (`/compact` →
`compact`, `/model` → `set_model`/`cycle_model`, `/thinking` →
`set_thinking_level`/`cycle_thinking_level`, `/name` → `set_session_name`,
`/new` → `new_session`), потому что pi не исполняет их через `prompt` — без
перехвата они ушли бы модели обычным текстом. Клиентские/недоступные в RPC
команды (`/cwd`, `/resume`, `/reload`, `/help`, `/copy`) перехватываются без
запроса и возвращают `{ ok: true, disposition: 'handled' }` — это не ошибка
(noop), клиент отрисует собственную справку/действие. Ошибочные встроенные
команды (`/thinking bogus`, `/name` без имени, `/model <ненайденная>`)
возвращают `PromptResult` с `ok: false` и человекочитаемым `error`. Команды
расширений/шаблонов/скиллов (`get_commands`) pi раскрывает сам и они идут в
`prompt` как прежде.

В `GET /iterations/:id/control` список `commands` начинается со встроенных
команд (`source: 'builtin'`, имена из `BUILTIN_SLASH_COMMANDS`) с
`argumentHint` (напр. `[provider/id]`) и продолжается командами `get_commands`
(`extension`/`prompt`/`skill`); hint из `get_commands` пробрасывается, если он
есть. При коллизии имени побеждает встроенная (она идёт первой и дубль из
`get_commands` пропускается). Благодаря этому палитра показывает `/compact`,
`/model`, `/thinking`, `/name` и т.п.

`CreateIssueRequest`: `{ title?, jira_issue_url?, repositories?: [{ repository_url, base_branch, create_mr? }], desired_result?, additional_context?, review_context?, is_review_need?, pipeline_steps?, model? }`.
`title` обязателен, если нет `jira_issue_url`. `repositories` необязателен
(`[]`/отсутствует — валидно, min 0): задача без репозиториев запускается, а
агент пишет файлы-результаты прямо в папку задачи.

**Загрузка файлов.** `POST /issues` и `POST /issues/:id/iterations` принимают
либо `application/json` (как раньше), либо `multipart/form-data`: JSON-тело
создания передаётся строкой в поле `payload`, а файлы — повторяющимся файловым
полем `files` (лимиты `@fastify/multipart`: до 10 файлов по 25 МБ). Файлы
сохраняются **до** `runIssueIteration` в `<workspace>/attachments/` (задача и
итерация №1) либо `<workspace>/attachments/iteration-<n>/` (итерации №2+);
имена санитайзятся (basename по обоим разделителям, без `..`/управляющих
символов, пустое → `file`), коллизии разрешаются суффиксом `-1`/`-2`.
Метаданные — в таблице `issue_files` (`rel_path` — относительно корня рабочей
папки, т.е. cwd агента). В промпт каждого шага добавляется секция
`Uploaded files (already in the working folder):` со списком `rel_path` и
инструкцией прочитать файлы до решения. `GET /issues/:id/files` отдаёт
`IssueFile[]`, `DELETE /files/:fileId` удаляет строку и файл с диска.

`desired_result` (`DesiredResult`) задаёт желаемый результат задачи: `'md'`
(дефолт) — `report.md`, `'html'` — self-contained `report.html`, `'pr'` —
добавляется шаг `pr` (валидация требует хотя бы один репозиторий: иначе
`400 «PR требует хотя бы один репозиторий»`). Для `'md'`/`'html'` шаг `pr` из
эффективных шагов задачи/итерации убирается. Артефакт отдаётся роутами
`/issues/:id/result` (inline-предпросмотр) и `/issues/:id/result/download`.

Эффективный конвейер собирается из `pipeline_steps` (дефолт
`['refine', 'resolve']`): `resolve` гарантированно присутствует; при
`is_review_need` шаги `review`+`test` вставляются сразу после `resolve`; при
`create_mr: true` хотя бы у одного репозитория в конец добавляется `pr`, но
итоговое наличие `pr` определяется `desired_result` (см. выше).
`is_review_need`/`review_context` хранятся на итерации, `Issue.description`
хранит исходный `additional_context`.

`SSEEvent`: `{ type: 'log' | 'step_status' | 'step_event' | 'iteration_status',
issueId, iterationId, stepRunId?, stream?, data, ts }`.

`StepRunWithLog` (контракт шага в `shared`) — это `StepRun` плюс лог его
output-строки: `stdout`/`stderr` (сырой вывод прогона; `''`, если output-строки
ещё нет), `events` (структурированные события сессии: `text`/`thinking`/`usage`/`stats`/
`question`/`tool_use`/`tool_result`/`tool_update`/`compaction_start`/
`compaction_end`/`retry_start`/`retry_end`/`queue`/`thinking_level`/
`session_info`/`notice`/`status`/`widget`/`title`/`extension_error`/`bash`/
`editor_text`), `stats` (`SessionStats` из `get_session_stats` либо `null`), а
также `report` и `screenshots_dir` (`null`, если отчёта ещё нет).

`GET /models` читает `MODELS_JSON` (массив `ModelDescriptor`), при пустом/битом
значении отдаёт `[{ id: 'user-default', name: 'Default' }]`.

## Функционал

- **Конвейер** `refine → resolve → review → test → pr` (дефолт — `refine`,
  `resolve`). Промпты шагов детерминированы (`workflow/prompts.ts`); каждый шаг
  пишет в рабочую папку задачи `.issue-step-result.json` (`{ status:
  pass|fail|blocked, summary, scenarios, findings }`), а движок читает его
  после шага (`parseStepReport`) и мапит в статус: `pass → success`,
  `fail → failed`, `blocked → needs_input`. Если файла нет (или он битый/не
  читается), статус определяется по exit-коду: exit 0 → `success` (отчёт при
  этом хранится пустой строкой, не `"null"`), иначе `failed` — прогон не падает.
- **Желаемый результат**: `desired_result` задачи (`'md'` дефолт / `'html'` /
  `'pr'`) попадает в промпт `resolve` и определяет итоговый артефакт —
  `report.md` (Markdown, plain, без HTML-обёртки) при `'md'`, self-contained
  `report.html` при `'html'`; оба дополнительно к `.issue-step-result.json`.
  `'pr'` вместо этого гарантирует шаг `pr`. Артефакт отдаётся через
  `GET /issues/:id/result` (inline) и `/result/download` (attachment).
- **Refine-агрегация**: первый шаг получает весь вход одним контекстом —
  `title` + `description` (`additional_context`) + текст Jira + пути
  репозиториев + `context` итерации — задаёт уточняющие вопросы (вывод в живой
  лог), затем по ответам строит план. Текст Jira докачивается на прогоне через
  `jira.fetchIssue`; ошибка Jira деградирует до `null` и шаг не падает.
- **Цикл фидбека**: провал `review`/`test` откатывает конвейер на `resolve` с
  `attempt + 1` и передаёт фидбек; максимум 3 попытки, дальше — итерация
  завершается `failed` с `needs_input`. Провал `refine`/`resolve`/`pr` завершает
  итерацию сразу.
- **Преемственность итераций**: итерация `number > 1` получает в промпт каждого
  шага блок `Previous iteration outcome` — `status`+`summary` из `report`
  resolve-шага предыдущей итерации плюс документ результата из рабочей папки
  (`report.md`/`report.html`, обрезан до ~4000 символов; для `'pr'` документа
  нет). Агент продолжает с этого итога, а не решает задачу заново. Битый JSON
  отчёта/отсутствующий документ деградируют до пометки, не роняя прогон.
- **Git/MR**: под каждый репозиторий готовится рабочая копия на базовой ветке
  (bare-кэш originals). `create_mr` задаётся **на репозиторий**; успешный
  `pr`-шаг коммитит (`feat: <title>`), пушит ветку и создаёт MR/PR только для
  репозиториев с `create_mr: true`; хост (GitLab/GitHub) определяется по URL.
  Шаг `pr` присутствует в конвейере только при `desired_result: 'pr'` (для
  остальных значений он удаляется). Для репозиториев с `create_mr: false`
  результат остаётся файлами в рабочей папке. При 0 репозиториев `pr`-шаг не
  коммитит и не создаёт MR.
- **Jira-enrichment**: если задан `jira_issue_url` без `title`, backend
  подтягивает `summary`/`description` из Jira REST; ошибка Jira деградирует до
  `title = ключ` тикета.
- **Общая память модели**: контейнер задачи монтирует named volume
  `agent-memory` (переопределяется `ISSUE_RESOLVER_MEMORY_VOLUME`) на
  `/home/agent/.pi/agent/memory`, поэтому pi-memory шарится между всеми
  контейнерами задач.
- **Выбор модели**: `GET /models` + селектор в форме новой задачи; `model`
  сохраняется на итерации и передаётся pi-раннеру.
- **Live-view (Фаза 2)**: каждый шаг конвейера — живая steerable
  `pi --mode rpc`-сессия (`RpcPiRunner`, транспорт `docker`|`local`), учёт
  активных сессий — `InMemoryStepSessionRegistry`. SSE-стрим лога и статусов
  шагов/итерации; на `completed`/`failed` UI перезапрашивает задачу, итерации и
  step-runs. Инпут шлёт сообщение в активный шаг (`POST /iterations/:id/message`
  = steer), кнопка «Прервать» дёргает `POST /iterations/:id/abort` (всегда
  `200`; без живой сессии доводит итерацию до `cancelled`). Интерактивные вопросы расширений pi (`ctx.ui.select/`
  `confirm`/`input`/`editor`) приходят как `extension_ui_request` и уходят в
  SSE событием `question` (`SessionQuestion`); ответ пользователя возвращается
  в живую сессию через `POST /iterations/:id/ui-response` → протокольный
  `extension_ui_response` (реестр адресует по итерации). UI показывает
  незавершённый вопрос активной итерации модалкой (`question-modal`): `select`
  → radio по `options`, `input` → строка, `editor` → textarea, `confirm` →
  Да/Нет; «Отмена» шлёт `cancelled: true`, отвеченный `id` гасится и больше не
  перерисовывается (очередь следующих вопросов продолжается). Структурированные
  события сессии (текст, `thinking`-
  блоки, `tool_use`/`tool_result`) идут в SSE как `step_event`; после
  `agent_settled` раннер запрашивает `get_session_stats` (таймаут 2с, иначе
  `stats: null`) и кладёт `SessionStats` в результат шага. Пока сессия жива,
  раннер опрашивает `get_session_stats` каждые ~3с, и каждый ответ уходит в
  SSE событием `stats` — UI держит из них живой футер (контекст%/токены/cost),
  не дожидаясь финала (у части провайдеров `message_update.usage` нулевое до
  конца стрима).
- **Прозрачность pi и управление (Фаза 3)**: раннер транслирует в SSE **все**
  служебные события pi (`tool_update`, `compaction_start`/`compaction_end`,
  `retry_start`/`retry_end`, `queue`, `thinking_level`, `session_info`, `notice`,
  `status`, `widget`, `title`, `extension_error`, `bash`, `editor_text`) —
  полная прозрачность сессии без потерь. Управление живой сессией:
  `GET /iterations/:id/control` — снимок `state`/`models`/`thinkingLevels`/
  `commands` (из `get_state` + `get_available_models` + `get_available_thinking_levels`
  + `get_commands`); `POST /iterations/:id/control` — 13 команд `SessionCommand`
  (смена/цикл модели, thinking-level, компакция, режимы очереди, auto-compaction/
  retry, abort_retry, bash/abort_bash); `POST /iterations/:id/prompt` — промпт с
  `streamingBehavior` = `mode`. Встроенные slash-команды pi (`/model`, `/compact`,
  `/thinking`, `/name`, `/new`, ...) перехватываются сервером и идут явными
  RPC-командами, а не `prompt`, а в `GET /control.commands` они видны первыми
  с `source: 'builtin'`. Команды идут через id-коррелированные
  RPC-запросы (`sendCommand`, таймаут 10с), ответы перехватываются до парсера
  событий. Очередь и компакция для UI приходят живыми SSE-событиями (`queue`,
  `compaction_start`/`compaction_end`), а `thinkingLevel` — в `state` снимка.
  Лог
  рендерится как Markdown (`AgentMarkdown` на react-markdown@10 + remark-gfm@4), шаг
  открывается в полноэкранном modal («Развернуть»): вывод (session +
  stdout/stderr/report) авто-скроллится вниз, steer-бар и строка статистики
  (`SessionStatsBar`, вынесена из `SessionView`) закреплены внизу вне
  скролл-области; `SessionView` внутри modal идёт с `showFooter={false}`.
  Карточка шага условна: пока шаг `running` — **живой вывод агента**
  (структурированные session-события `sessionEventsOf(run)` + буфер SSE
  `liveEventsByRun`, тот же `SessionView`) в фиксированном окне ~300px с
  авто-прокруткой вниз (`AutoScrollBox`, `scrollKey = events.length`);
  завершённый шаг вместо него показывает статус-чип и краткое саммари отчёта
  (`parseStepReport(run.report)`, `data-testid="step-summary"`, summary обрезан
  `line-clamp-4`), а при отсутствии/битом отчёте (в т.ч. устаревшая строка
  `"null"`) — заглушку «Результат отсутствует.» (статус в блоке саммари —
  `PASS`/`FAIL`/`BLOCKED` из отчёта, uppercase). Под карточкой шага
  (`data-testid="step-run-log"`) — строка статистики: длительность (⏱; у
  активного шага тикает `now - created_at`), токены из `run.stats` в формате
  `<модель> · ^<input> · v<output> · кеш<cacheRead+cacheWrite> · N вызовов`
  (компактно 950 / 105k / 1.2M), изменённые файлы (уникальные `tool_use` с
  `write`/`edit`; `read` и `.issue-step-result.json` исключены, workspace-uuid
  срезан `shortPath`, первые 5 + `+N`) и артефакты отчёта (счётчики
  `report.scenarios`/`report.findings`, `report.screenshots_dir`). Полный отчёт
  и сырой stdout/stderr остаются в modal «Развернуть». Прежний мёртвый
  `RpcBridge` удалён.
- **Английские промпты**: тексты шагов конвейера (`workflow/prompts.ts`) и
  `pr`-скилл переведены на английский.
- **Персистентный лог шагов**: сырой `stdout`/`stderr`, структурированные
  `events` и `stats` (`SessionStats`) каждого прогона шага пишутся в
  `step_outputs` (идемпотентная миграция `ensureStepOutputColumns` доводит уже
  существующие БД) и отдаются вместе с шагами через
  `GET /iterations/:id/step-runs` — отдельный запрос за логом не нужен.
- **UI**: три экрана (новая задача / список / детали), Matrix-тема, адаптивная
  навигация (сайдбар на десктопе, нижняя панель на мобильном). Описание задачи
  и контекст итерации редактируются WYSIWYG markdown-редактором
  (`MarkdownEditor` на Tiptap v3 + официальный `@tiptap/markdown`; тулбар —
  заголовки 1-3, bold/italic/strike, inline code, code block, списки, цитата,
  ссылка, hr), а в API уходит обычный markdown-текст (контракт не менялся).
  К формам создания задачи и итерации добавлен выбор файлов (`FilePicker`:
  чипы с именем/размером и ✕ до отправки); при непустом списке запрос уходит
  `multipart/form-data` (`createIssueWithFiles`/`createIterationWithFiles`), без
  файлов — прежний JSON. Вложения задачи показываются блоком «Файлы задачи»
  (`IssueFilesList`: имя, размер, бейдж итерации, ссылка на
  `/files/:id/content`, удаление ✕; пустой список не рендерится). В
  детальном виде
  итерации кликабельны (по умолчанию активна последняя), а выбранная показывает
  живой вывод работающих шагов (session-события в окне ~300px), тогда как
  завершённые шаги — статус+саммари отчёта; полный лог
  (session + stdout/stderr/report) — в modal «Развернуть». Для задач с
  `desired_result` `md`/`html` в шапке — «Показать
  результат» (модалка: markdown через `AgentMarkdown` или `html` в iframe) и
  «Скачать» (`/issues/:id/result/download`).

Статусы — из `shared`:

- `TaskStatus` (Issue и Iteration): `pending`, `running`, `completed`, `failed`, `cancelled`.
- `StepRunStatus` (шаг): `pending`, `running`, `success`, `failed`, `needs_input`, `skipped`.
- `StepReportStatus` (отчёт): `pass`, `fail`, `blocked`.

## Тесты

```bash
npm run typecheck                 # tsc во всех пакетах
(cd shared   && npx vitest run)   # 61 тест
(cd backend  && npx vitest run)   # 321 тест
(cd frontend && npx vitest run)   # 187 тестов
(cd e2e      && npx playwright test)  # 2 e2e-сценария: «создать → список», «деталь + новая итерация»
```

Юниты backend работают на in-memory фейках (docker/git/pi/MR/Jira/RPC) — реальные
контейнеры, git-пуш и сетевые вызовы не выполняются; интеграционные обёртки
компилируются, но проверяются отдельно (e2e/руками).