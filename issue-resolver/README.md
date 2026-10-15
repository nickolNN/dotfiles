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
| `e2e/` | Playwright UI-сценарии на мок-бэкенде: `flow` + `edge-cases` |
| `e2e/scenarios/` | Пресеты мок-ответов агента (`all-success`, `step-failure`, `agent-question`, `concurrent-questions`, `bootstrap-failure`) |
| `frontend/e2e/` | Frontend Playwright: `flows/` (жизненный цикл, bootstrap-тоггл/лог, вопрос, статусы), `scenarios/` (мок-ответы агента), `backend/` (HTTP-сценарии) |

## Запуск

```bash
npm install

# backend: Fastify на 127.0.0.1:8080 (PORT переопределяет порт; наружу не выводится)
# ISSUE_RESOLVER_LOCAL=1 обязателен для dev без docker: без него workspace root
# остаётся docker-дефолтом /workspaces, которого в dev-контейнере нет → EACCES
# на первой же задаче. В docker-ветке (ISSUE_RESOLVER_USE_REAL=1) /workspaces есть.
cd backend && ISSUE_RESOLVER_LOCAL=1 npm run start

# frontend: Vite dev-сервер на 0.0.0.0:5173, проксирует /issue-resolver → http://localhost:8080
cd frontend && npm run dev -- --host 0.0.0.0 --port 5173

# e2e: сам поднимает мок-стек (e2e-server :8096 + vite :5196)
cd e2e && npx playwright test

# frontend e2e: мок-стек :8095/:5195 (backend HTTP + flows + scenarios)
cd frontend && npx playwright test
```

**Лаунчер одной командой — `bin/up.sh`.** Поднимает backend + frontend через
`bin/service.sh`, ждёт готовности (порт + `GET /ping` → `{"ok":true}`, Vite отдаёт
`/`) до ~15 с (переопределяется `IR_UP_WAIT_SECS`), при неудаче печатает
`tail -n 20` соответствующего лога и выходит с non-zero. Идемпотентен: если сервисы
уже слушают — сообщает об этом и всё равно печатает host-команду публикации.
Публикацию порта сам сделать не может (в dev-контейнере нет docker CLI/`docker.sock`).

**Ручное управление — `bin/service.sh`.** `start|stop|restart|status` поднимает/
гасит backend + frontend; режим задаётся `IR_MODE=local|docker` (дефолт `local`),
PID-файлы и логи — в `/tmp` (переопределяются `IR_PID_DIR`/`IR_LOG_DIR`).

**Доступ по локальной сети (LAN).** Vite слушает `0.0.0.0:5173` и
проксирует `/issue-resolver` на `127.0.0.1:8080`, поэтому наружу достаточно
опубликовать один порт UI — сам backend слушает только loopback
(`HOST = '127.0.0.1'` в `backend/src/server.ts`) и наружу не выводится.
`bin/up.sh` в конце работы печатает готовую host-команду.
`agent-fwd up 5173:5173`
(на хосте, где есть Docker CLI и `docker.sock`) поднимает sidecar, публикующий
`5173` контейнера на `0.0.0.0` хоста — UI открывается по `http://<host-IP>:5173`.
Сам бэкенд наружу не выводится. Внутри dev-контейнера docker CLI/`docker.sock`
нет, поэтому `agent-fwd` запускается с хоста.

Backend по умолчанию поднимается с in-memory фейками docker/git/pi/MR/Jira/RPC —
без реальных контейнеров и git-пуша. Продовый wiring — это
`buildDepsFromEnv(process.env)` в `server.ts`:

Токены доступа к репозиториям (`BITBUCKET_TOKEN`,
`BITBUCKET_USERNAME`/`BITBUCKET_PASSWORD`, `GITHUB_TOKEN`, `GITLAB_TOKEN`) можно
задавать и в `backend/config.json` (gitignored; в репозитории лежит шаблон с
пустыми строками). `loadConfig()` (`backend/src/config.ts`) читает файл
относительно cwd и мержит с окружением: приоритет
`process.env` > `config.json` > пустая строка; отсутствие или битый JSON не
фатальны (работает только `process.env`). `server.ts` раскладывает результат
обратно в `process.env`, поэтому резолверы репозиториев о файле не знают.

- **Локальный режим (dev без docker) — `ISSUE_RESOLVER_LOCAL=1`**: pi
  запускается НАПРЯМУЮ на хосте (`RpcPiRunner('local')`), контейнер задачи —
  обычная host-папка (`LocalContainerController` — mkdir/rm), git — `GitCliService`,
  workspace root по умолчанию `/home/agent/workspace/.issue-resolver/workspaces`
  (переопределяется `ISSUE_RESOLVER_WORKSPACE_ROOT`).
- **Прод docker-ветка — `ISSUE_RESOLVER_USE_REAL=1`**: изолированные
  контейнеры задач, боевые `DockerodeContainerController` (`DOCKER_SOCKET`,
  дефолт `/var/run/docker.sock`), `GitCliService`, `RpcPiRunner('docker')`,
  `HttpMrClient` (`MR_TOKEN` как общий фолбек + per-host
  `BITBUCKET_TOKEN`/`GITHUB_TOKEN`/`GITLAB_TOKEN`), `HttpJiraClient` (`JIRA_BASE_URL`,
  `JIRA_TOKEN`) и `InMemoryStepSessionRegistry` (steer/abort/respond живых шагов).

**Общий каталог данных — `ISSUE_RESOLVER_DATA_DIR`.** Если он задан, БД лежит в
`<DATA_DIR>/issue-resolver.db`, рабочие папки задач — в `<DATA_DIR>/workspaces`,
git-кэш originals — в `<DATA_DIR>/originals`. Без него работают прежние
дефолты: БД `backend/data/issue-resolver.db`, originals
`/tmp/issue-resolver/originals`, а
папки задач — `ISSUE_RESOLVER_WORKSPACE_ROOT` (local-дефолт
`/home/agent/workspace/.issue-resolver/workspaces`, docker-дефолт `/workspaces`).
`ISSUE_RESOLVER_WORKSPACE_ROOT` имеет приоритет над `DATA_DIR` для папок задач:
он переопределяет `<DATA_DIR>/workspaces`.

Иначе — пустой объект и безопасные Fake*-адаптеры `buildApp(db, deps)`. Имя
общего named volume для памяти модели — `ISSUE_RESOLVER_MEMORY_VOLUME` (дефолт
`agent-memory`). Таймаут одного pi-агента шага —
`ISSUE_RESOLVER_RESOLVE_AGENT_TIMEOUT_MS` (мс, дефолт 90 мин; значения меньше
60с поднимаются до 60с): прокидывается в `RpcPiRunner` (reject + SIGKILL) и
дополнительно страхуется внешним таймером движка. Таймаут pi-агента разовой
подготовки — `ISSUE_RESOLVER_BOOTSTRAPPER_TIMEOUT_MS` (мс, дефолт 90 мин; тот
же минимум 60с): прокидывается в `PiBootstrapperAgent` через
`bootstrapperFactoryFor`, чтобы зависший анализатор не держал задачу в
`preparing` вечно. Таймаут git-операций — `GIT_TIMEOUT_MS` (мс, дефолт 5 мин):
под него попадает и первичный прогрев originals-кэша (`clone --bare`), который
на медленной сети идёт десятки секунд. Без `ISSUE_RESOLVER_DATA_DIR` кэш живёт
в `/tmp/issue-resolver/originals` и теряется при пересоздании контейнера — тогда
следующий прогон снова платит за полный клон (при заданном `DATA_DIR` он лежит
в `<DATA_DIR>/originals`). Ожидание порта dev-сервера —
`DEV_SERVER_PORT_TIMEOUT_MS` (мс, дефолт 30 с). Данные лежат в SQLite
(`backend/data/issue-resolver.db`, таблицы
создаются идемпотентно при старте).

## API

Все бизнес-роуты — под префиксом `/issue-resolver/api/v1`.

| Метод и путь | Запрос | Ответ |
| --- | --- | --- |
| `GET /ping` | — | `{ ok: true }` |
| `POST /issues` | `CreateIssueRequest` (JSON) **или** `multipart/form-data` (`payload` + `files`) | `201 Issue`; создаёт итерацию №1 и запускает её в фоне; загруженные файлы сохраняются в рабочую папку |
| `GET /issues` | — | `Issue[]` (по `created_at` убыв.) |
| `GET /issues/:id` | — | `Issue` / `404 { error }` |
| `GET /issues/:id/container-stats` | — | `ContainerStats` (`{ containerName, cpuPercent, memoryUsageBytes, memoryLimitBytes, pids }`; `cpuPercent: null`, если дельт ещё нет) / `200 { containerName, error: 'container_not_found' }`, если контейнера нет / `404 { error }` |
| `GET /issues/:id/container-stats-stream` | — | SSE: живой поток статистики контейнера (docker stats `stream`). Отдаёт `text/event-stream` и шлёт только keepalive `: keepalive`, а сами события `container_stats` публикует в общую шину — их доставляет `GET /issues/:id/stream`. `404 { error }` (нет задачи) / `404 { containerName, error: 'container_not_found' }` / `503 { containerName, error: 'container_stats_unavailable' }` |
| `GET /issues/:id/result` | — | результат задачи inline: `report.md` (`text/markdown`) или `report.html` (`text/html`); нет файла → `404 { error: 'result not found' }` |
| `GET /issues/:id/result/download` | — | тот же файл как `Content-Disposition: attachment; filename="report.md"` (или `report.html`) / `404` |
| `GET /issues/:id/result/files` | — | `WorkspaceFile[]` (порождённые файлы последней completed-итерации из рабочей папки; исключены `attachments/`, скрытые `.`-пути, `node_modules/`, рабочие копии клонированных репозиториев (каталог с `.git`) и сам артефакт результата) / `404` |
| `GET /issues/:id/result/files/content?path=<rel_path>` | — | содержимое файла как `Content-Disposition: attachment` / `404` |
| `GET /issues/:id/result/files/archive` | — | `application/gzip` (`Content-Disposition: attachment; filename="issue-<id>.tar.gz"`) — tar.gz из того же отфильтрованного списка плюс сам артефакт результата из снапшота итерации; нет completed-итерации или нечего паковать → `404 { error: 'result not found' }` |
| `GET /issues/:id/iterations` | — | `Iteration[]` (по `number` возр.) / `404` |
| `POST /issues/:id/iterations` | `{ context, review_context?, is_review_need?, steps?, model? }` (JSON) **или** multipart (`payload` + `files`) | `201 Iteration`; запускает прогон в фоне; файлы итерации — в `attachments/iteration-<n>/` |
| `GET /issues/:id/files` | — | `IssueFile[]` (загруженные файлы задачи; `rel_path` от корня рабочей папки, `iteration_id` для группировки) / `404` |
| `DELETE /issues/:id` | — | `202 { ok: true }` — удаление фоновое (процессы → контейнер → рабочая папка → БД); прогресс — SSE `issue_deleting` (фазы), финал — `issue_deleted` / `404 { error }` |
| `DELETE /files/:fileId` | — | `204`; удаляет строку и файл с диска (best-effort, guard от path traversal) / `404` |
| `GET /files/:fileId/content` | — | `200` содержимое файла: `Content-Type: <mime_type>` (fallback `application/octet-stream`) + `Content-Disposition: attachment; filename="…"` (safe ASCII + `filename*=UTF-8''…`) / `404` (нет строки, файла или путь вне `attachments/`) |
| `GET /iterations/:id/step-runs` | — | `StepRunWithLog[]` (порядок шагов конвейера, внутри шага `attempt` возр.; сырой лог шага) / `404` |
| `POST /iterations/:id/repeat` | — | `201 Iteration` — копия: те же `context`/`steps`/модели/вложения, `number = max+1`, запускает прогон в фоне. Только для завершённой/проваленной/отменённой итерации; активную (`running`/`pending`) → `409 { error: 'cannot repeat an active iteration' }` / `404` |
| `GET /iterations/:id/agents` | — | `RoomAgent[]` (агенты комнаты resolve: воркеры по `index` 1..N + координатор последним; `id`, `role: 'worker' \| 'coordinator'`, `index`, `label`, `status`, `startedAt`, `stats`) / `404` |
| `GET /iterations/:id/agents/stream?agentId=` | — | SSE: события сессии одного агента комнаты (`?agentId=<RoomAgent.id>`) / `400` (нет `agentId`) |
| `GET /issues/:id/stream` | — | SSE: `data: <SSEEvent JSON>\n\n` |
| `GET /stream` | — | SSE: все события шины без фильтра по задаче/итерации (для списка задач) |
| `POST /iterations/:id/message` | `{ message }` | `{ ok: true }` (steer активного шага) / `409 { error: 'no active step session' }` / `400` |
| `POST /iterations/:id/prompt` | `{ message, mode?: 'steer' \| 'followUp' }` | `PromptResult`: `{ ok, disposition: 'started' \| 'queued' \| 'handled', error? }` (`error` — при `ok:false`) / `400` / `409 { error: 'no active step session' }` |
| `GET /iterations/:id/control` | — | `SessionControlSnapshot`: `{ state, models, thinkingLevels, commands }` / `409 { error: 'no active step session' }` |
| `POST /iterations/:id/control` | `{ command: SessionCommand }` | `ControlResult`: `{ ok, data?, error? }` / `400` (неизвестный/невалидный `command`) / `409` (нет сессии) / `504` (таймаут pi) |
| `POST /iterations/:id/abort` | — | `{ ok: true }` всегда: отменяет активный шаг, а без живой сессии доводит итерацию до терминального `cancelled` (шаги → `aborted`) |
| `POST /iterations/:id/ui-response` | `{ id, value?, confirmed?, cancelled? }` | `{ ok: true }` (ответ на интерактивный вопрос шага; сохраняется и без живой сессии) / `400` (нет `id` или ответа) |
| `GET /models` | — | `ModelDescriptor[]` |
| `POST /repos/validate` | `{ urls: string[] }` (1..20) | `200 { results: RepoValidationResult[] }` / `400 { error }` |
| `GET /repositories` | — | `SavedRepo[]` (по `created_at` возр.) |
| `POST /repositories` | `CreateRepoRequest` `{ url }` | `201 SavedRepo` (валиден, `connectionStatus: 'ok'`) / `422 { error, repository }` (валидация не прошла — репо сохранён со `connectionStatus: 'error'`) / `400 { error }` |
| `PUT /repositories/:id` | `UpdateRepoRequest` `{ url }` | `200 SavedRepo` / `422 { error, repository }` / `404` |
| `DELETE /repositories/:id` | — | `204` / `404` |
| `POST /repositories/:id/validate` | — | `200 SavedRepo` (перевалидирован; `connectionStatus` — итог) / `404` |
| `GET /repositories/:id/branches` | — | `200 { branches: string[] }` (live из резолвера, не из БД) / `502 { error }` / `404` |

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

`CreateIssueRequest`: `{ title?, jira_issue_url?, repositories?: [{ repository_url, base_branch, create_mr? } | { repo_id, repository_url?, base_branch?, create_mr? }], desired_result?, additional_context?, review_context?, is_review_need?, pipeline_steps?, model? }`.
`title` обязателен, если нет `jira_issue_url`. `repositories` необязателен
(`[]`/отсутствует — валидно, min 0): задача без репозиториев запускается, а
агент пишет файлы-результаты прямо в папку задачи. Пункт репозитория — либо
явный URL+ветка (`repository_url`+`base_branch`, старый формат), либо ссылка
на сохранённый репозиторий (`repo_id`, приоритет над `repository_url`;
`base_branch` при отсутствии берётся из `defaultBranch` репозитория).
Несуществующий `repo_id` → `422 { error: 'Repository not found' }`; `repo_id`
без `defaultBranch` и без `base_branch` → `422`.

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

Эффективный конвейер берётся напрямую из `pipeline_steps` (при создании задачи)
/ `steps` (при новой итерации); дефолт — `['refine', 'resolve']`. `resolve`
гарантированно присутствует. Шаги `review` и `test` выбираются НЕЗАВИСИМО друг
от друга (можно включить только `review`, только `test`, оба или ни одного) —
они просто перечисляются в `pipeline_steps`/`steps`. Флаг `is_review_need`
БОЛЬШЕ НЕ вставляет шаги: это только метаданные на итерации (при этом
`review_context` всё так же попадает в промпт шага `review`, секция «Reviewer
context», когда не пуст). Шаг `pr` добавляется в конец при `create_mr: true`
хотя бы у одного репозитория, но итоговое наличие `pr` определяется
`desired_result` (см. выше). `Issue.description` хранит исходный
`additional_context`.

**SSE-потоки.** Каждый SSE-ответ открывается комментарием `: connected`
(см. `openSse` в `backend/src/routes/stream.ts`). Это не данные, а требование к
прокси: и Vite dev-proxy, и nginx держат блок заголовков в буфере до первого
байта тела, поэтому поток, который сразу ничего не пишет, у клиента не
открывается (`EventSource` остаётся в CONNECTING). До этого фикса через
dev-прокси `container-stats-stream` открывался лишь на первом `: keepalive`
спустя 15 с, а поток без событий — никогда.

`SSEEvent`: `{ type: 'log' | 'step_status' | 'step_event' | 'iteration_status' |
'workspace_progress' | 'bootstrap_log' | 'issue_deleting' | 'issue_deleted' |
'container_stats', issueId, iterationId, stepRunId?, stream?, data, ts }`.
У `step_status` со `status: 'running'` `data` — `JSON.stringify({ status:
'running', step, model })` (`step` — шаг конвейера, `model` — id выбранной
модели или `null`); остальные статусы (`success`/`failed`/`aborted`/…) приходят
голой строкой.
У `workspace_progress` `data` — `JSON.stringify({ step, repo?, status:
'running'|'done'|'warning'|'error', message?, devPort? })`: по одному событию на
шаг подготовки (`creating_dirs`, `cloning` на каждый репозиторий,
`checking_instructions` (проверка статуса `run_instructions`), `bootstrapping` на
каждый репозиторий без актуальной инструкции, `installing`, `dev_server` на
каждый репозиторий (запуск dev-сервера, `devPort` — найденный порт), `ready`).
Сбой запуска dev-сервера — `status: 'warning'` (не роняет подготовку). У
`iteration_status` со `status: 'failed'`
есть `error` — причина инфраструктурного сбоя (catch подготовки/прогона).
У `issue_deleting` `data` — `JSON.stringify({ phase, message? })`, `phase` —
`stopping_processes` | `removing_container` | `removing_workspace` | `error`
(фазы идут в порядке выполнения, `message` — только при `error`); у
`issue_deleted` — `JSON.stringify({ issueId })`. Оба события issue-уровневые
(`iterationId` отсутствует) и покрывают фоновое удаление `DELETE /issues/:id`.
У `container_stats` `data` — `JSON.stringify(ContainerStatsPayload)`
(`{ cpuPercent, memoryUsageBytes, memoryLimitBytes, pids }`): живая статистика
контейнера задачи, которую открывает `GET /issues/:id/container-stats-stream`, а
доставляется она через `GET /issues/:id/stream`.

`StepRunWithLog` (контракт шага в `shared`) — это `StepRun` плюс лог его
output-строки: `stdout`/`stderr` (сырой вывод прогона; `''`, если output-строки
ещё нет), `events` (структурированные события сессии: `text`/`thinking`/`usage`/`stats`/
`question`/`tool_use`/`tool_result`/`tool_update`/`compaction_start`/
`compaction_end`/`retry_start`/`retry_end`/`queue`/`thinking_level`/
`session_info`/`notice`/`status`/`widget`/`title`/`extension_error`/`bash`/
`editor_text`), `stats` (`SessionStats` из `get_session_stats` либо `null`), а
также `report` и `screenshots_dir` (`null`, если отчёта ещё нет;
`'screenshots'`, когда шаг создал такой каталог в рабочей папке — его пишет
шаг `test`).

`GET /models` читает `MODELS_JSON` (массив `ModelDescriptor`), при пустом/битом
значении отдаёт `[{ id: 'user-default', name: 'Default' }]`.

**Валидация репозиториев.** `POST /repos/validate` принимает
`{ urls: string[] }` (1..20 URL) и для каждого возвращает
`RepoValidationResult` (`{ url, valid, platform, info?, error? }`). Платформа
определяется по хосту: публичные SaaS и известные имена
(`github`/`gitlab`/`bitbucket`/`stash`); любой неизвестный self-hosted хост по
умолчанию трактуется как Bitbucket Server (`bitbucket`), а `unknown` →
`«Unsupported platform»` остаётся только для URL без хоста/неразбираемых.
Затем резолвер ходит в API платформы:
`GitHubResolver` (`GET api.github.com/repos/:owner/:repo`, токен `GITHUB_TOKEN`),
`GitLabResolver` (`GET <host>/api/v4/projects/:encoded_path`, токен
`GitLAB_TOKEN`), `BitbucketResolver` Server/Data Center
(`GET <host>/rest/api/1.0/projects/:project/repos/:repo` + `/branches/default`,
Bearer `BITBUCKET_TOKEN` или Basic `BITBUCKET_USERNAME`/`BITBUCKET_PASSWORD`),
`BitbucketCloudResolver` для `bitbucket.org` — Cloud API 2.0
(`GET api.bitbucket.org/2.0/repositories/:owner/:repo` +
`/refs/branches?pagelen=100`, та же авторизация; `BitbucketResolver` по хосту
`bitbucket.org` делегирует в него).
`info` — `RepoInfo` (`platform`, `fullName`, `defaultBranch`, `branches`,
`language`, `description`, `stars`, `isPrivate`, `cloneUrl`, `writeAccess`);
резолвер
дополнительно тянет список веток платформы (GitHub/GitLab `branches`,
Bitbucket Server `branches`, Bitbucket Cloud `/refs/branches`), а при
недоступности — массив из одного
`defaultBranch`. `writeAccess` — есть ли у токена право на запись (от него
зависит доступность галки «Создать MR»): GitHub — `permissions.push`,
GitLab — `permissions.project_access.access_level >= 30` (Developer+),
Bitbucket Server — пробная ветка (`POST /branches` от default-ветки +
best-effort `DELETE`), токен аутентифицирует сам (без `BITBUCKET_USERNAME`),
Bitbucket Cloud и неопределимые случаи — `false`.
Сбой проверки прав не роняет валидацию (просто `false`). Форма создания
задачи ветки из `RepoInfo` больше не берёт:
она выбирает сохранённый репозиторий и тянет ветки live через
`GET /repositories/:id/branches`, подставляя его `defaultBranch` (при ошибке
загрузки веток остаётся только `defaultBranch`, форма не падает). Поле ввода
URL (`RepoUrlInput`) живёт на экране «Репозитории» и нормализуется до запроса:
без схемы → префикс `https://`, ssh-стиль `git@host:owner/repo` → `https://host/owner/repo`;
схема-лесс URL и неизвестные хосты с путём `owner/repo` тоже валидируются
(платформу определяет бэкенд). Если строку нельзя разобрать как URL — ✕
«Invalid URL» без запроса; если это URL, но без пути `owner/repo` — серая
подсказка «Непохоже на URL репозитория» (`data-state="invalid-url"`), запрос
не шлётся. Токены опциональны; 404 →
`«Repository not found»`, 401/403 → `«Access denied»`, сетевые ошибки не роняют
запрос — URL получает `valid: false` с текстом ошибки. Реализация — global
`fetch` без новых зависимостей; роут/фабрика резолверов инъектируемы в тестах.

**Сохранённые репозитории (CRUD).** Репозиторий — самостоятельная сущность в
таблице `repositories` (`shared.SavedRepo`): `id` (uuid), `url`, метаданные
последней валидации (`platform`, `fullName`, `defaultBranch`, `cloneUrl`,
`language`, `description`, `isPrivate`), `connectionStatus`
(`ok`/`error`/`unknown`), `writeAccess` (право токена на запись из последней
валидации; на его основе форма задачи и карточка репозитория показывают
статус «только чтение»), `lastValidatedAt`, `runInstructions` (Markdown-инструкция
по запуску) и `runInstructionsStatus` (`unknown`/`generated`/`failed`),
`createdAt`/`updatedAt`. CRUD смонтирован под `/repositories`: `POST /`
(`{ url }`) валидирует URL существующим резолвером и сохраняет результат
(ва¬лидный → `201 SavedRepo`; ошибка резолвера или неподдерживаемая платформа
→ репо всё равно сохраняется с `connectionStatus: 'error'` и пустыми
метаданными, ответ `422 { error, repository }`); `PUT /:id` меняет URL и
перевалидирует; `DELETE /:id` → `204`; `POST /:id/validate` перепроверяет
соединение (`200 SavedRepo`, `connectionStatus` — итог) и `GET /:id/branches`
тянет ветки **live** через резолвер (`{ branches: string[] }`), не из БД.
Поля `runInstructions*` валидация не трогает: их заполняет агент-анализатор
(`backend/src/workflow/bootstrapper.ts`) на этапе разовой подготовки рабочей
папки. После clone и ДО `install`, для каждого репозитория со статусом НЕ
`generated`, `PiBootstrapperAgent` запускает pi-агента с промптом
`prompts/bootstrapper.md` (плейсхолдеры `{{REPO_DIR}}`/`{{REPO_NAME}}`/
`{{DEV_SERVER_PORT}}`): агент смотрит проект, пробует поставить зависимости/
собрать, пишет `RUN_INSTRUCTIONS.md` и `DEV_SERVER.sh` в корень репо и
проверяет, что скрипт действительно отдаёт выделенный порт. Успех
→ `runInstructions = <Markdown>`, `runInstructionsStatus = 'generated'`; сбой
(нет файла/ошибка/таймаут) → `'failed'`, инструкция очищается. Репозитории со
`generated` повторно не анализируются. Если последующий `installDependencies`
всё равно падает, инструкции считаются устаревшими и сбрасываются в `'failed'`.
Оба файла — инфраструктура задачи: `prepareIssueWorkspace` дописывает их в
локальный `.git/info/exclude` каждой рабочей копии, иначе публикация (`git add -A`
на шаге `pr`) увезла бы их в MR. Идемпотентно и best-effort.
Детерминированный install остаётся по манифесту, а из `RUN_INSTRUCTIONS.md`
берётся только секция `## Run` — команда запуска dev-сервера (см. ниже).
Остальные секции (build и т.п.) пока не исполняются (только логируются).

## Функционал

- **Конвейер** `refine → resolve → review → test → pr` (дефолт — `refine`,
  `resolve`; `review` и `test` опциональны и независимы, см. следующий пункт).
  Каждый шаг пишет в рабочую папку задачи `.issue-step-result.json` (`{ status:
  pass|fail|blocked, summary, scenarios, findings }`), а движок читает его
  после шага (`parseStepReport`) и мапит в статус: `pass → success`,
  `fail → failed`, `blocked → needs_input`. Если файла нет (или он битый/не
  читается), статус определяется по exit-коду: exit 0 → `success` (отчёт при
  этом хранится пустой строкой, не `"null"`), иначе `failed` — прогон не падает.
- **Шаги `review` и `test`** (оба необязательны и независимы): `review` —
  только код-ревью: проверяет исходный код против задачи и `review_context`,
  без запуска приложения/тестов/браузера (быстрый). `test` — финальная
  проверка: гоняет приложение в браузере (Playwright), фиксирует найденные
  дефекты и НЕ чинит код; при падении конвейер возвращается к разработке
  (`resolve`).
- **Подготовка задачи (при запуске)**: clone репозиториев + разовый
  детерминированный install зависимостей по манифесту (`package-lock.json` →
  `npm ci`, `pnpm-lock.yaml` → `pnpm install`, `yarn.lock` → `yarn install`,
  `bun.lock`/`bun.lockb` → `bun install`, `package.json` → `npm install`,
  `go.mod` → `go mod download`) выполняются ОДИН раз при инициализации задачи.
  После успешного install каждого репозитория бэкенд поднимает его dev-сервер:
  разбирает секцию `## Run` из `RUN_INSTRUCTIONS.md`, запускает команду в фоне
  и берёт порт из её вывода (`workspace_progress` шаг `dev_server` со `devPort`);
  сбой запуска — `status: 'warning'`, подготовка не падает.
  Повтор (папка уже склонирована) НЕ переклонирует и не переинсталлирует — все
  итерации работают с одним кодом. Пока идёт подготовка, задача — в статусе
  `preparing`, а итерация — `pending` (в `running` её переводит
  `runIssueIteration` сразу после подготовки); неудача clone/install переводит
  их терминально в `failed`. Каждый шаг подготовки публикует SSE
  `workspace_progress`
  (`creating_dirs` → `cloning` на каждый репозиторий → `checking_instructions`
  → `bootstrapping` на каждый репозиторий без актуальной инструкции →
  `installing` → `dev_server` на каждый репозиторий → `ready`), при ошибке —
  событие со `status: 'error'` и
  `message` и `iteration_status` со `status: 'failed'` + `error`. Живой
  stdout/stderr агента-бутстрапера идёт отдельным событием `bootstrap_log`
  (`data` = `JSON.stringify({ repo, text, kind })`, `kind` — `stdout`/`stderr`);
  UI накапливает вывод по репозиториям и показывает его моноширинным
  скроллируемым блоком под шагом `bootstrapping` панели подготовки. Пару
  «задача `preparing` / итерация `pending`», пережившую рестарт backend,
  `reconcileInterruptedRuns` доводит до `failed`.
- **Отчёт итерации в файл**: по завершении прогона (`completed`/`failed`)
  в корне рабочей папки задачи пишется `report-<number>.md`: заголовок задачи
  и итерации, статус/даты и секция на каждый `step_run` с выводом (`ok`/`fail`/
  `timeout` + текст `report` из `step_outputs`). Запись best-effort — её сбой
  логируется и не роняет итерацию.
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
  Планировщик также получает `pipeline_steps` — канонический список включённых
  шагов прогона — и согласует план с даунстрим-верификацией: при включённых
  `review`/`test` не дублирует их работу и оставляет только лёгкие локальные
  self-checks (build/typecheck/unit smoke), а без них `resolve` сам становится
  финальным гейтом, и план несёт полную самопроверку. Промпт `resolve`
  аналогично знает о включённых даунстрим-шагах `review`/`test` и ограничивает
  свою проверку локальными self-checks (то же — у координатора комнаты и
  финального lead staged-режима).
- **Промпты шагов** (`prompts/*.md` + сборка в `backend/src/workflow/prompts.ts`):
  у каждого шага одна и та же шапка контекста — `Pipeline step: <step>`,
  `Enabled pipeline for this run: …` (где я в конвейере), задача/описание/Jira/
  контекст итерации, пути рабочих копий репозиториев, живой dev-сервер
  (`http://localhost:<dev_server_port>`, если он поднят), загруженные файлы,
  план refine, итог предыдущей итерации, фидбек упавшего шага и общий
  `output-contract.md` (форма `.issue-step-result.json` c `scenarios`/`findings`).
  Дальше — роль-специфичное тело: `refine` (интервью через tool `question`,
  `plan.md`, рекомендация `execution`, потолок исполнителей подставляется из
  `DEFAULT_MAX_ROOM_EXECUTORS`), `resolve` (implementer + HARD-RULES: изменения
  остаются незакоммиченными), `review` (read-only ревью change set рабочего
  дерева), `test` (Playwright против живого dev-сервера, скриншоты в
  `screenshots/`), `pr` (только текст MR: `title`/`description`, диф рабочего
  дерева + цели публикации с base-веткой и `create_mr`). Room/staged-промпты
  (`resolve-room-*`, `resolve-stages-*`) несут тот же контекст своими
  плейсхолдерами (`{{TASK_CONTEXT}}`/`{{REPOS}}`/`{{ATTACHMENTS}}`/
  `{{PREVIOUS_OUTCOME}}`/`{{DOWNSTREAM_AWARENESS}}`), потому что собираются без
  шапки шага.
- **Room-режим (последовательные/параллельные агенты)**: `refine` — шаг
  планирования: его отчёт может нести `execution` (`{ mode: 'single' | 'room' |
  'stages', executors?, decomposition?, stages?, rationale? }`), а также пишет
  человекочитаемый план в `plan.md` в корне рабочей папки. Топологию
  детерминированно решает движок (`planExecutionMode`, потолок
  `DEFAULT_MAX_ROOM_EXECUTORS = 4`), а не сами агенты:
  - `room` валиден только при `executors >= 2`; N воркеров параллельно решают
    подзадачи и пишут каждый свой `.issue-worker-result-<n>.json` (`n` — 1-based
    номер подзадачи, как в подписи воркера), затем
    координатор (lead, запускается последним и держит финальный `pass`/`fail`)
    интегрирует их и пишет итоговый `.issue-step-result.json`. Саммари воркеров
    в промпте координатора движок дочитывает из этих файлов (host-путь рабочей
    папки, `RoomResolveOptions.hostWorkspaceDir`): in-memory `report` раннер
    заполняет только при abort.
  - `stages` валиден при 2+ валидных этапах в `execution.stages`
    (элемент — `{ index, name?, task?, executors?, decomposition? }`). Этапы
    исполняются строго последовательно: на этапе с `executors >= 2` воркеры
    работают параллельно, затем координатор этапа пишет
    `.issue-stage-<i>.json` (воркеры — `.issue-stage-<i>-worker-<w>.json`);
    этап с одним исполнителем выполняет один агент; после всех этапов
    финальный lead интегрирует исходы и ОДИН пишет deliverable
    (`report.md`/`report.html` по `desired_result`) и итоговый
    `.issue-step-result.json`. `planExecutionStages` перенумеровывает этапы
    1..N, зажимает `executors` в `[1..max]` и добивает `decomposition` до
    ровно `executors` пунктов; abort на любом этапе немедленно завершает шаг.
    Координатор этапа и финальный lead дополнительно читают итоги предыдущих
    этапов через общую память комнаты (`memory_read`/`memory_search`) и пишут
    свой итог (`memory_write`, теги `#issue-resolver`/`[[stage-N]]`).
  - иначе (нет плана, битый, `single`, < 2 валидных этапов) — один агент.
  В `room`/`stages` у каждого агента свой `RoomAgent.id` (`<stepRunId>` у
  финального координатора, `<stepRunId>/worker/<i>` у воркеров комнаты,
  `<stepRunId>/stage/<s>/worker/<w>` и `<stepRunId>/stage/<s>/coordinator` у
  staged-агентов) и отдельный per-agent SSE (`/agents/stream?agentId=`), а
  `RoomAgent` несёт `stage`/`stageName` (staged-режим), `startedAt` (ISO) и
  агрегированные `stats` (токены/cost/context из usage/stats-событий его
  сессии).
- **Цикл фидбека**: провал `review`/`test` откатывает конвейер на `resolve`
  (разработку) с `attempt + 1` и передаёт фидбек; сам `test` код не чинит.
  Максимум 3 попытки, дальше — итерация завершается `failed` с `needs_input`.
  Провал `refine`/`resolve`/`pr` завершает итерацию сразу.
- **Терминальность сбоя агента**: reject/таймаут `pi.run` (spawn ENOENT,
  timeout, child error, зависание) ловится движком вокруг single/room/stages
  вызова шага: `step_run` → `failed`, `step_output` с отчётом
  `{ status: 'fail', summary: '<step> agent failed/hung' }` и текстом ошибки в
  `stderr`, итерация → `failed`. Шаг не остаётся в `running` навсегда. Успешный
  `agent_settled`/abort при этом не путаются со сбоем (см. `resolve-not-aborted`).
- **Преемственность итераций**: итерация `number > 1` получает в промпт каждого
  шага блок `Previous iteration outcome` — `status`+`summary` из `report`
  resolve-шага предыдущей итерации плюс документ результата из рабочей папки
  (`report.md`/`report.html`, обрезан до ~4000 символов; для `'pr'` документа
  нет). Агент продолжает с этого итога, а не решает задачу заново. Битый JSON
  отчёта/отсутствующий документ деградируют до пометки, не роняя прогон.
- **Git/MR**: под каждый репозиторий готовится рабочая копия на базовой ветке
  (bare-кэш originals). `create_mr` задаётся **на репозиторий**; успешный
  `pr`-шаг коммитит (`feat: <title>`), пушит **feature-ветку**
  `issue/<issueId>-<iterationId>` (base-ветка защищена от прямого push) и
  создаёт MR/PR `head=feature → base=base_branch` только для репозиториев с
  `create_mr: true`; хост (GitLab/GitHub) определяется по URL.
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
  `extension_ui_response` (реестр адресует по итерации). Пока вопрос не
  отвечен, задача в статусе `question` (виден в списке задач и шапке, янтарный);
  ответ возвращает её в `running`. UI показывает
  незавершённый вопрос активной итерации модалкой (`question-modal`): `select`
  → radio по `options`, `input` → строка, `editor` → textarea, `confirm` →
  Да/Нет; «Отмена» шлёт `cancelled: true`, отвеченный `id` гасится и больше не
  перерисовывается (очередь следующих вопросов продолжается). Escape закрывает
  модалку, НЕ отвечая: вопрос остаётся кликабельным баннером
  (`step-pending-question`) в карточке активного шага, и автооткрытие его больше
  не навязывает до клика по баннеру. Структурированные
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
  `PASS`/`FAIL`/`BLOCKED` из отчёта, uppercase). В `room`-режиме карточка
  активного `resolve` вместо одной сессии показывает вкладки «Воркер 1..N /
  Координатор (lead)» (`RoomAgentTabs`): у выбранного агента — живой
  `SessionView` и его статистика (токены/cost/контекст + ⏱ длительность), а над
  вкладками — итог по всему шагу (суммарные токены/cost и wall-time от первого
  старта). Режим определяется по последнему `refine`-отчёту
  (`parseStepReport(report).execution.mode === 'room'` либо `'stages'`); в
  `stages` вкладки группируются по этапам (`stage`/`stageName`, сначала этап 1
  с его воркерами и координатором, затем этап 2, …; финальный координатор —
  последним), иначе — обычная одиночная сессия. Под карточкой шага
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
  Вопросы агента (`question`) и ответы (`question_answered`) дополнительно
  дозаливаются по мере появления в `step_runs.events` (`appendStepRunEvent`,
  миграция `ensureStepRunColumns`): пока шаг в работе, строки `step_outputs`
  ещё нет, и без этого вопрос терялся бы при перезагрузке страницы (SSE не
  переигрывает старые события). `GET /iterations/:id/step-runs` до появления
  output-строки отдаёт именно `step_runs.events`, а после — полный набор из
  `step_outputs.events`.
- **UI**: четыре экрана (новая задача / список / детали / репозитории),
  Matrix-тема. Единая ширина контента — `max-w-4xl` на всех четырёх экранах
  (переключение между ними не «прыгает» по ширине). Верхняя навигация-табы («Задачи» / «Репозитории») в хедере;
  справа от табов — кнопка «+» с контекстным действием (создать задачу /
  добавить репозиторий по активному табу). Нижней мобильной панели нет.
  Хеш-роуты: `#/new`, `#/tasks`, `#/tasks/:id`, `#/repositories`. На детали
  задачи над карточкой — текстовая крошка «← Задачи». В карточках списка задач
  — таймер: у `running` живой «⏱ Xм Yс» от `created_at`, у `completed`
  фиксированный (`created_at` → `updated_at`), у остальных статусов — прежнее
  относительное время. У `pending`/`preparing`-карточек под репозиториями —
  сводка готовности (`📦 репо: ✅N 🔵N 🟡N [❌N]`) по `GET /repositories`
  (сопоставление сохранённого репозитория с задачей по URL): `✅` — соединение
  `ok` и инструкция сгенерирована, `🔵` — соединение `ok` без инструкции, `🟡`
  — ещё ждёт, `❌` — ошибка; запрос кешируется на один список. Экран «Репозитории»
  (`#/repositories`) — CRUD сохранённых репозиториев: карточка той же
  ширины, что и остальные экраны (`max-w-4xl`), первая строка — индикатор статуса соединения (🟢 `ok` /
  🔴 `error` / ⚪ `unknown`, с tooltip), чип платформы, `fullName` и иконки
  действий справа (🔄 «Проверить» → `POST /repositories/:id/validate`, ✏️
  «Редактировать» → PUT с перевалидацией, 🗑 «Удалить» → `confirm`); ниже —
  `defaultBranch` и дата последней проверки. Добавление — модалка с валидацией
  `RepoUrlInput` («Сохранить» активна только после успешной проверки),
  открывается кнопкой «+» в хедере («Добавить репозиторий») или внешним
  `createSignal`. Форма создания задачи больше не вводит URL: для
  каждого репозитория — селектор сохранённых (`GET /repositories`), при выборе
  которого live подтягиваются ветки (`GET /repositories/:id/branches`) с
  выбранным `defaultBranch`; в `POST /issues` уходит
  `{ repo_id, base_branch, create_mr }`. Описание задачи
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
  (session + stdout/stderr/report) — в modal «Развернуть». Пока идёт
  разовая подготовка рабочей папки (`preparing`/`running`), ОТДЕЛЬНОЙ панелью
  прогресса (`data-testid="workspace-progress"`) ПЕРЕД островом итераций — с
  шагами `creating_dirs` → `cloning <repo>` → `checking_instructions` →
  `bootstrapping <repo>` → `installing` → `dev_server <repo>` → `ready`
  (⏳/✓/✕ и `!` у `warning`, текст `message` при ошибке); после
  `ready`/`error` она затухает через 3с. В шапке задачи (сразу под
  заголовком и бейджем статуса) — компактная сводка по репозиториям
  (`data-testid="repo-status"`, строки `repo-status-row`): `owner/repo`, базовая
  ветка и живой индикатор подготовки (🟡 `pending` / 🔵 `cloning`·`cloned` /
  🟣 `bootstrapping` / 🟢 `installed` / 🔷 `dev_server` / ✅ `ready` /
  ⏭️ `skipped` при `bootstrap_enabled: false` с пометкой «запуск отключён» /
  ❌ `failed`), обновляется по `workspace_progress`; для поднятого dev-сервера
  рядом показывается `Dev: localhost:<порт>`; логика — `views/repoPrep.ts`. Ошибка
  `iteration_status` со `status: 'failed'` и полем `error` показывается красным
  баннером «❌ Ошибка
  подготовки: …» над списком шагов. Для задач с
  `desired_result` `md`/`html` в шапке — «Показать
  результат» (модалка: markdown через `AgentMarkdown` или `html` в iframe) и
  «Скачать» (`/issues/:id/result/download`). Обе кнопки активны только когда
  `resolve`-шаг уже оставил непустой `.issue-step-result.json` (до этого —
  `disabled`/`aria-disabled`, чтобы не бить в 404 «результат ещё не создан»);
  отсутствие `desired_result`/`pr` скрывает их совсем. Рядом с «Скачать»
  появляются отдельные ссылки скачивания файлов, порождённых агентом в рабочей
  папке последней completed-итерации (`GET /issues/:id/result/files/content`,
  список — `GET /issues/:id/result/files`, тот же фильтр: без клонов репозиториев):
  каждый файл — своя ссылка
  `Скачать <имя>` с размером; служебные `.`-пути, `attachments/` и сам артефакт
  результата исключены, пустой список ничего не рендерит. Если рабочая папка
  задачи удалена, а issue в БД осталась (`Issue.workspace_missing === true`), в
  шапке задачи показывается бейдж «Файлы задачи отсутствуют»; issue при этом
  НЕ удаляется автоматически. В шапке формы и в чипах шагов лейблы шагов —
  `Review` → «Код-ревью», `Test` → «Тест».

Статусы — из `shared`:

- `TaskStatus` (Issue и Iteration): `pending`, `preparing`, `running`,
  `completed`, `failed`, `cancelled`, `question`. `preparing` — идёт разовая
  подготовка рабочей папки (clone/install); `question` — агент задал
  интерактивный вопрос и ждёт ответа пользователя (янтарный в UI).
- `StepRunStatus` (шаг): `pending`, `running`, `success`, `failed`,
  `needs_input`, `skipped`.
- `StepReportStatus` (отчёт): `pass`, `fail`, `blocked`.

## Тесты

```bash
npm run typecheck                 # tsc во всех пакетах
(cd shared   && npx vitest run)   # 97 тестов
(cd backend  && npx vitest run)   # 563 теста
(cd frontend && npx vitest run)   # 433 теста
(cd e2e      && npx playwright test)  # flow (2) + edge-cases (10) на мок-стеке
(cd frontend && npx playwright test)  # 8 backend HTTP + 5 flows + 3 scenarios на мок-стеке
```

**E2E-сценарии агента (без Docker/git/pi/сети/токенов).**
`backend/test/e2e-server.ts` поднимает реальные роуты и движок поверх
мок-агента: ответы шагов (`success`/`failure`/`question`/`timeout`)
задаются `POST /e2e/scenarios` (встроенное имя или inline `steps` + опц.
`bootstrap`/`delayMs`), сброс — `POST /e2e/reset`, чтение —
`GET /e2e/scenarios`. Пресеты — `e2e/scenarios/*.ts` (`all-success`,
`step-failure`, `agent-question`, `concurrent-questions`,
`bootstrap-failure`). HTTP-спеки — `frontend/e2e/backend/api.spec.ts`
(вопрос, параллельные вопросы, SSE), UI-спеки —
`frontend/e2e/scenarios/*.spec.ts` (модалка → ответ → завершение, падение
шага, падение подготовки). Вопрос получает ответ через реальный
`POST /iterations/:id/ui-response` → реестр живых сессий; курсор шагов — на
итерацию, поэтому параллельные задачи независимы. Прогон детерминирован
(каждый тест < 5с); токены не тратятся.

**Свой мок-стек.** `frontend/playwright.config.ts` и
`e2e/playwright.config.ts` поднимают собственные e2e-server + vite на
свободных портах (`:8095`/`:5195` и `:8096`/`:5196`), не конфликтуя с живым
dev-стеком соседей (`:8080`/`:5173`); цель vite-прокси задаётся
`VITE_PROXY_TARGET`. Живой дефолт ‑ `:8080`.

**e2e `edge-cases/*`.** Краевые UI-сценарии (пустой список, две задачи,
подготовка двух репозиториев, повтор итерации, `desired_result`, обрыв SSE,
валидация формы) перехватывают API/SSE через детерминированный `FakeApi`
(`e2e/helpers.ts`), а `flow.spec.ts` ходит через vite-прокси на мок-бэкенд.
Хелперы: `createRepo` (сохранить репозиторий через UI), `getLatestIssueId`
(id из `#/tasks/<id>`), `pollIterationStatus` (дождаться статуса итерации),
`wsProgress`/`bsLog` (кадры SSE `workspace_progress` / `bootstrap_log`).

Юниты backend работают на in-memory фейках (docker/git/pi/MR/Jira/RPC) — реальные
контейнеры, git-пуш и сетевые вызовы не выполняются; интеграционные обёртки
компилируются, но проверяются отдельно (e2e/руками).