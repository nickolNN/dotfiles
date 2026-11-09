# Issue Resolver

Оркестратор `pi`-агентов, которые решают задачи разработки: на вход — тикет
(Jira) и git-репозитории, на выход — изменение кода, отчёт о шагах и MR/PR.
Агенты работают в отдельном контейнере задачи, шаги конвейера идут по порядку,
результаты каждого шага и живой лог стримятся в веб-UI.

Этот файл — для человека: как запустить и что где лежит. Что система умеет и как
себя ведёт — [`docs/FEATURES.md`](docs/FEATURES.md). Почему сделано именно так,
и особенно то, что нельзя вывести из кода — [`docs/DESIGN-NOTES.md`](docs/DESIGN-NOTES.md).
Правила для агентов, работающих в этом репозитории — [`AGENTS.md`](AGENTS.md) и
[`CODING_STANDARDS.md`](CODING_STANDARDS.md).

| Пакет | Что внутри |
| --- | --- |
| `shared/` | Доменные типы, статусная модель, чистые функции (workflow, разбор отчёта шага, статус задачи) — контракт для всех пакетов |
| `backend/` | Fastify 5 REST API, workflow-движок, SQLite/Drizzle, адаптеры (docker/git/pi/MR/Jira/RPC) |
| `frontend/` | React 19 + Vite 6 + Tailwind 4 SPA (тема Matrix/hackerman) |
| `prompts/` | Тексты шагов конвейера и разовых прогонов (devops, retro) |
| `frontend/e2e/` | Playwright на мок-стеке: `flows/` (жизненный цикл, bootstrap-тоггл/лог, вопрос, статусы, обрыв SSE, отчёт, две задачи), `scenarios/` (мок-ответы агента), `backend/` (HTTP-сценарии) |
| `bin/` | Операционные скрипты: `up.sh`, `service.sh`, `pw-browsers.sh`, `embed-screenshots.mjs` |

## Запуск

```bash
npm install

# backend: Fastify на 127.0.0.1:8080 (PORT переопределяет порт; наружу не выводится)
cd backend && ISSUE_RESOLVER_LOCAL=1 npm run start

# frontend: Vite на 0.0.0.0:5173, проксирует /issue-resolver → http://localhost:8080
cd frontend && npm run dev -- --host 0.0.0.0 --port 5173

# e2e: сам поднимает мок-стек :8095/:5195 (backend HTTP + flows + scenarios)
cd frontend && npx playwright test
```

`ISSUE_RESOLVER_LOCAL=1` обязателен для dev без docker: без него workspace root
остаётся docker-дефолтом `/workspaces`, которого в dev-контейнере нет → `EACCES`
на первой же задаче. В docker-ветке (`ISSUE_RESOLVER_USE_REAL=1`) `/workspaces`
есть.

- **`bin/up.sh`** — поднять всё одной командой: backend + frontend через
  `bin/service.sh`, ждёт готовности (порт + `GET /ping` → `{"ok":true}`, Vite
  отдаёт `/`) до ~15 с (`IR_UP_WAIT_SECS`), при неудаче печатает `tail -n 20`
  лога и выходит с non-zero. Идемпотентен; в конце печатает готовую host-команду
  публикации порта.
- **`bin/service.sh start|stop|restart|status`** — backend + frontend.
  Режим — `IR_MODE=local|docker` (дефолт `local`), pid-файлы и логи в `/tmp`
  (`IR_PID_DIR`/`IR_LOG_DIR`). `npm run start` — это `tsx src/server.ts`, без
  watch: правки в `backend/src/**` требуют `restart` (автоперезагрузка — только
  у `npm run dev`).
- **`bin/pw-browsers.sh [repo-dir]`** — сделать браузеры работоспособными для
  склонированного репозитория: запускает браузер **родным** Playwright репозитория
  и, только если не вышло, доставляет недостающую ревизию его же
  `playwright install chromium`. Образ везёт браузеры лишь под свою версию
  (`PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`), поэтому чужой пин падает на
  `browserType.launch: Executable doesn't exist at /opt/ms-playwright/…`.
  Скрипт идемпотентен и сам копируется в рабочую папку задачи как
  `pw-browsers.sh` — его и вызывают промпты `devops` и `test`.

### Режимы и данные

- **Локальный (dev без docker) — `ISSUE_RESOLVER_LOCAL=1`**: pi запускается
  напрямую на хосте (`RpcPiRunner('local')`), контейнер задачи — обычная
  host-папка (`LocalContainerController`), git — `GitCliService`.
- **Прод (docker) — `ISSUE_RESOLVER_USE_REAL=1`**: изолированные контейнеры задач
  (`DockerodeContainerController`, `DOCKER_SOCKET`), `RpcPiRunner('docker')`,
  `HttpMrClient` (`MR_TOKEN` как общий фолбек + per-host
  `BITBUCKET_TOKEN`/`GITHUB_TOKEN`/`GITLAB_TOKEN`), `HttpJiraClient`
  (`JIRA_BASE_URL`, `JIRA_TOKEN`).
- Без обоих флагов поднимаются in-memory фейки docker/git/pi/MR/Jira/RPC.
- Токены доступа можно задавать в `backend/config.json` (gitignored, в репо лежит
  шаблон): `loadConfig()` мержит файл с окружением по приоритету
  `process.env` > `config.json` > пустая строка. Битый JSON не фатален.
- **`ISSUE_RESOLVER_DATA_DIR`** — общий каталог данных: БД в
  `<DATA_DIR>/issue-resolver.db`, рабочие папки задач в `<DATA_DIR>/workspaces`,
  git-кэш originals в `<DATA_DIR>/originals`. Без него: БД
  `backend/data/issue-resolver.db`, originals `/tmp/issue-resolver/originals`,
  папки задач — `ISSUE_RESOLVER_WORKSPACE_ROOT` (local-дефолт
  `/home/agent/workspace/.issue-resolver/workspaces`, docker-дефолт
  `/workspaces`). `ISSUE_RESOLVER_WORKSPACE_ROOT` сильнее `DATA_DIR` для папок
  задач. Без `DATA_DIR` кэш originals теряется при пересоздании контейнера, и
  следующий прогон снова платит за полный клон.

### Переменные окружения

| Переменная | Что делает |
| --- | --- |
| `PORT` | порт backend (по умолчанию `8080`, слушает только loopback) |
| `ISSUE_RESOLVER_LOCAL` / `ISSUE_RESOLVER_USE_REAL` | режим: dev без docker / прод docker |
| `ISSUE_RESOLVER_DATA_DIR` | БД + рабочие папки + кэш originals в одном каталоге |
| `ISSUE_RESOLVER_WORKSPACE_ROOT` | каталог рабочих папок задач (сильнее `DATA_DIR`) |
| `ISSUE_RESOLVER_MEMORY_VOLUME` | имя docker-volume памяти модели (дефолт `agent-memory`) |
| `ISSUE_RESOLVER_ALLOWED_ORIGINS` | дополнительные **точные** CORS-ы через запятую; `*` и пустые игнорируются |
| `ISSUE_RESOLVER_RESOLVE_AGENT_TIMEOUT_MS` | таймаут одного pi-агента шага (дефолт 90 мин, минимум 60 с) |
| `ISSUE_RESOLVER_AGENT_STALL_TIMEOUT_MS` | сторож тишины (дефолт 15 мин, минимум 30 с): `follow_up`-нудж → `compact` → снять прогон |
| `ISSUE_RESOLVER_DEVOPS_TIMEOUT_MS` | таймаут pi-агента разовой подготовки (дефолт 90 мин; читает и устаревшее имя) |
| `GIT_TIMEOUT_MS` | таймаут git-операций, включая первичный прогрев originals-кэша (дефолт 5 мин) |
| `DEV_SERVER_PORT_TIMEOUT_MS` | ожидание порта dev-сервера (дефолт 30 с) |
| `MODELS_JSON` | список моделей для `GET /models`; пусто/бито → `user-default` |
| `IR_MODE`, `IR_UP_WAIT_SECS`, `IR_PID_DIR`, `IR_LOG_DIR` | поведение `bin/up.sh` и `bin/service.sh` |

### Доступ по локальной сети

Vite слушает `0.0.0.0:5173` и проксирует `/issue-resolver` на `127.0.0.1:8080`,
поэтому наружу достаточно опубликовать один порт UI — backend слушает только
loopback (`HOST = '127.0.0.1'` в `backend/src/server.ts`) и наружу не выводится.
Внутри dev-контейнера нет docker CLI/`docker.sock`, поэтому с хоста:

```bash
agent-fwd up 5173:5173   # sidecar публикует порт контейнера на 0.0.0.0 хоста
```

UI открывается по `http://<host-IP>:5173`.

## API

Все бизнес-роуты — под префиксом `/issue-resolver/api/v1`; health — `GET /ping`
без префикса.

CORS и защита от чужих origin — в `backend/src/http/origin.ts`. По умолчанию
разрешены только http(s)-origin на `localhost`/`127.0.0.1`/`[::1]` в любом
порту; чужие домены, не-http схемы и `Origin: null` запрещены. Дополнительные
**точные** origins — `ISSUE_RESOLVER_ALLOWED_ORIGINS` (`*` игнорируется). Тот же
allow-list применяется к мутирующим методам (`POST`/`PUT`/`PATCH`/`DELETE`)
root-`preHandler`-хуком: неразрешённый `Origin` → `403 { error: 'origin not
allowed' }`; без `Origin` (curl, e2e) — пропускается. Браузер шлёт `Origin` и на
same-origin POST, поэтому `isSameOrigin` сравнивает host:port с заголовком
`Host` — приложение работает и на LAN-адресе, и на проброшенном порту. Условие:
прокси не должен переписывать `Host` (`changeOrigin: false` во
`frontend/vite.config.ts`).

Тела ошибок собираются в `backend/src/routes/params.ts` (`notFound`,
`badRequest`, `conflict`, `unprocessable`), поэтому одинаковая проверка в разных
роутерах даёт одинаковый ответ.

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
| `POST /issues/:id/iterations` | `{ context, review_context?, is_review_need?, steps?, pr_repository_ids?, model? }` (JSON) **или** multipart (`payload` + `files`) | `201 Iteration`; запускает прогон в фоне; файлы итерации — в `attachments/iteration-<n>/` |
| `GET /issues/:id/files` | — | `IssueFile[]` (загруженные файлы задачи; `rel_path` от корня рабочей папки, `iteration_id` для группировки) / `404` |
| `DELETE /issues/:id` | — | `202 { ok: true }` — удаление фоновое (процессы → контейнер → рабочая папка → БД); прогресс — SSE `issue_deleting` (фазы), финал — `issue_deleted` / `404 { error }` |
| `DELETE /files/:fileId` | — | `204`; удаляет строку и файл с диска (best-effort, guard от path traversal) / `404` |
| `GET /files/:fileId/content` | — | `200` содержимое файла: `Content-Type: <mime_type>` (fallback `application/octet-stream`) + `Content-Disposition: attachment; filename="…"` (safe ASCII + `filename*=UTF-8''…`) / `404` (нет строки, файла или путь вне `attachments/`) |
| `GET /iterations/:id/step-runs` | — | `StepRunWithLog[]` (порядок шагов конвейера, внутри шага `attempt` возр.; сырой лог шага) / `404` |
| `POST /iterations/:id/repeat` | — | `201 Iteration` — копия: те же `context`/`steps`/модели/вложения, `number = max+1`, запускает прогон в фоне. Только для завершённой/проваленной/отменённой итерации; активную (`running`/`pending`) → `409 { error: 'cannot repeat an active iteration' }` / `404` |
| `GET /iterations/:id/agents` | — | `StepAgent[]` (агенты шага resolve: исполнители по `index` 1..N + координатор последним; `id`, `role: 'worker' \| 'coordinator'`, `index`, `label`, `status`, `startedAt`, `stats`) / `404` |
| `GET /iterations/:id/agents/stream?agentId=` | — | SSE: события сессии одного агента шага (`?agentId=<StepAgent.id>`) / `400` (нет `agentId`) |
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
| `PUT /repositories/:id/credentials` | `{ testCredentials: string \| null }` | `200 SavedRepo` (пустая строка → `null`) / `400` / `404`. Тестовый аккаунт репозитория: пишет человек, агенты только читают; едет в промпты `devops` и `test` как `{{CREDENTIALS}}` |
| `DELETE /repositories/:id` | — | `204` / `404` |
| `POST /repositories/:id/validate` | — | `200 SavedRepo` (перевалидирован; `connectionStatus` — итог) / `404` |
| `GET /repositories/:id/branches` | — | `200 { branches: string[] }` (live из резолвера, не из БД) / `502 { error }` / `404` |
| `GET /tags` | — | `Tag[]` (именованные наборы сохранённых репозиториев; каждый — с `repositories: TagRepositoryWithRepo[]`, `run_instructions`, `run_instructions_status`) |
| `POST /tags` | `CreateTagRequest` `{ name, description?, run_instructions?, repositories: [{ repository_id, bootstrap_enabled? }] }` | `201 Tag` / `400 { error }` (`name` обязателен, ≥1 репозиторий) |
| `GET /tags/:id` | — | `Tag` / `404 { error: 'tag not found' }` |
| `PUT /tags/:id` | `UpdateTagRequest` `{ name?, description?, run_instructions?, repositories? }` | `200 Tag`; `repositories` заменяет список связей целиком; `run_instructions` при непустом значении переводит `run_instructions_status` в `'generated'`, при `null`/`''` — в `'unknown'`; **реальная смена текста дополнительно инвалидирует `run_instructions*` репозиториев тега** (`null`/`'unknown'` — иначе движок пропустит повторный анализ) / `400` / `404` |
| `DELETE /tags/:id` | — | `204` / `404`; связи `tag_repositories` снимаются каскадом |
| `GET /settings/hostname` | — | `{ hostname }` (пустая строка, если не задан) |
| `PUT /settings/hostname` | `{ hostname }` (≤ 100 символов) | `{ hostname }` / `400 { error }` |
| `POST /settings/retro` | `{ model?, thinking_level?, session_limit?, instructions? }` (JSON; `thinking_level` — `off…max`, `session_limit` 1–50, `instructions` ≤ 4000) | `202 RetroRun` (`status: 'running'`, прогон идёт в фоне) / `400 { error }` / `409 { error, id }`, если прогон уже идёт / `503 { error }`, если запуск не сконфигурирован. Живой вывод — SSE `log`/`step_event`/`step_status` с `issueId: '__settings__'` и `stepRunId` = id прогона (глобальный поток `GET /stream`) |
| `GET /settings/retro` | — | `{ runs: RetroRun[] }` (последние 20, новые первыми) |
| `POST /settings/retro/:id/abort` | — | `202 { ok: true }` — останавливает идущий прогон (SIGKILL сессии), строка получает `status: 'failed'`, `error: 'прогон остановлен оператором'` / `404 { error }` / `409 { error }` — прогон уже завершён / `503 { error }` — сессия недоступна |
| `GET /settings/retro/:id` | — | `RetroRunWithLog` (`report`, `stdout`, `stderr`, `events`, `stats`) / `404 { error }` |
| `POST /admin/cleanup-orphans` | — | `{ orphaned_workspaces, killed_processes, deleted_dirs, deleted_rooms, errors }` / `500 { error: 'cannot read workspace root' }` |

### Полезные детали

- **`CreateIssueRequest`**: `{ title?, jira_issue_url?, repositories?:
  [{ repository_url, base_branch, create_mr? } | { repo_id, ... }], tag_id?,
  desired_result?, additional_context?, review_context?, is_review_need?,
  pipeline_steps?, model? }`. `title` обязателен, если нет `jira_issue_url`;
  репозиториев может не быть вовсе. `desired_result`: `md` (дефолт), `html`,
  `pr` (требует хотя бы один репозиторий).
- **Загрузка файлов**: `POST /issues` и `POST /issues/:id/iterations` принимают
  либо JSON, либо `multipart/form-data` (`payload` строкой + повторяющееся поле
  `files`, до 10 файлов по 25 МБ). Файлы ложатся в
  `<workspace>/attachments/` (задача и итерация №1) или
  `attachments/iteration-<n>/`, имена санитайзятся, коллизии — суффиксом.
- **SSE**: каждый поток открывается комментарием `: connected` — прокси держат
  заголовки в буфере до первого байта тела. Типы событий и их `data` —
  `docs/FEATURES.md`; форма `SSEEvent` — `shared/`.
- **Терминальные статусы**: `TaskStatus` (задача и итерация), `StepRunStatus`
  (шаг), `StepReportStatus` (отчёт шага) объявлены один раз в
  `shared/src/status.ts` — см. `CODING_STANDARDS.md`.

## Тесты

```bash
npm run typecheck                     # tsc во всех пакетах
npm run lint                          # eslint: правила из eslint.config.mjs
(cd shared   && npx vitest run)
(cd backend  && npx vitest run)
(cd frontend && npx vitest run)
(cd frontend && npx playwright test)  # мок-стек, без Docker/git/pi/сети/токенов
```

Юниты backend работают на in-memory фейках (docker/git/pi/MR/Jira/RPC) — реальные
контейнеры, git-пуш и сетевые вызовы не выполняются. E2E поднимает реальные
роуты и движок поверх мок-агента: `backend/test/e2e-server.ts`, пресеты ответов —
`backend/test/scenarios/*.ts`, спек-файлы — `frontend/e2e/` (`flows/`,
`scenarios/`, `backend/`). `frontend/playwright.config.ts` поднимает свой
мок-стек на свободных портах (`:8095`/`:5195`) и не конфликтует с живым
dev-стеком; цель vite-прокси задаётся `VITE_PROXY_TARGET`.

## Куда дальше

- [`docs/FEATURES.md`](docs/FEATURES.md) — что система делает: конвейер,
  подготовка воркспейса, топология исполнения, отчёт, UI.
- [`docs/DESIGN-NOTES.md`](docs/DESIGN-NOTES.md) — инварианты, которые нельзя
  вывести из кода. Читать перед правкой конвейера, pi-сессий, отчёта, SSE и БД.
- [`AGENTS.md`](AGENTS.md) — правила работы в репозитории.
- [`CODING_STANDARDS.md`](CODING_STANDARDS.md) — код-доктрина,
  [`docs/REVIEW-EXCEPTIONS.md`](docs/REVIEW-EXCEPTIONS.md) — принятые исключения.
