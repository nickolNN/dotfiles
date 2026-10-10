# Issue Resolver — План реализации

> Итог гриллинг-сессии. Новая система, отталкивающаяся от
> `ISSUE_RESOLVER_SPEC.md` + `ISSUE_RESOLVER_BACKEND_SPEC.md`, но на стеке
> **Node.js + Fastify + React** с AI-агентом **`pi`** в переиспользуемом
> **`dotfiles-agent`** образе.

---

## 1. Назначение

Веб-интерфейс, который по описанию задачи (или Jira-тикету) запускает
конвейер AI-шагов (уточнение требований → написание кода → ревью → тесты →
PR/MR) в изолированном контейнере на задачу, с живым стримом прогресса и
возможностью подключиться к работающей сессии агента прямо из браузера.

---

## 2. Ключевые решения (сводно)

| Область | Решение |
|---|---|
| Масштаб | Личный инструмент, один пользователь, без отдельной auth |
| БД | SQLite (Drizzle ORM), swap на PG при необходимости |
| Бэкенд | Node.js + Fastify + TypeScript, отдельный самостоятельный сервис |
| Frontend | React + Vite + Tailwind (мысль «оставить React» выполнена) |
| AI-агент | `pi` (JS), ключи зашиты в `dotfiles-agent` образ (`pi/models.json`) |
| Где бэкенд | Свой контейнер с замонтированным `docker.sock` |
| Запуск агента | На задачу: папка → контейнер (аналог `agent-attach`) → в нём `pi` |
| Итерации | Контейнер переиспользуем, **свежая pi-сессия** на каждую итерацию |
| Тикеты | Опциональны; сейчас Jira + pluggable интеграции обогащения контента |
| Имя задачи | Ручное, если нет тикета |
| Git-результат | PR-skill генерирует описание → бэкенд пушит и создаёт **MR** через API |
| Git-креды | Хостовые creds из dotfiles-agent (достаточно для любых git-операций) |
| MR-токен | Зашивается в образ ровно как в dotfiles-agent (см. §10) |
| Прогресс | SSE живой стрим |
| Конвейер | Шаги выбираются в UI на задачу, каждый шаг = отдельный запуск `pi` |
| Цикл провала | Fail → обратно на разработку с фидбеком; авто до N, потом спросить |
| Лог для SSE | Сырой stdout/stderr pi + префикс шага конвейера |
| Мультирепо | Все N репозиториев в один контейнер задачи |

---

## 3. Что берём из оригинала (не меняем)

- **Модель домена**: Issue → repositories → iterations; статусная модель
  `pending → running → completed/failed/cancelled` (расширена, см. §7)
- **Каркас SPA**: 3 экрана (новая задача / список / деталь), фиксированный
  сайдбар (десктоп), UI-константы (Rubik, цвета статусов, адаптив
  1200/1000/700 — десктоп; мобильная адаптация — §5.9)
- **Git-воркфлоу**: originals-кэш (иммутабельный, `git pull --ff-only`),
  workspace на задачу, ветка → коммит → push (`core.longpaths=true`)
- **Правила**: имя репо из URL, сортировка итераций по `number`, относительное
  время, формат `DD.MM.YYYY, HH:MM` (ru-RU), race-protection, AbortController

## 4. Что меняем (стек + архитектура)

1. **Go/Fiber → Node/Fastify + TS**, ORM `Drizzle` (SQLite)
2. **Kilo CLI → `pi`**: `pi --mode rpc` (стрим/интерактив) + `pi --print`
   (разовые шаги)
3. **`docker run issue-resolver-kilo` → программный спавн** через `dockerode`
   (реплика логики `container-name.sh`/`attach.sh`: имя по папке, volumes,
   uid/gid)
4. **In-memory Go-канал → workflow-движок** с персистентными шагами + SSE-хаб
5. **Жёсткий «Resolver→Reviewer» → конвейер** с условными переходами и циклом
   фидбека

## 5. Новые фичи

1. **Refine-шаг (grilling)**: первый шаг получает **весь вход одним контекстом**
   — заголовок + описание задачи (`additional_context`) + текст Jira +
   репозитории + контекст итерации — задаёт пользователю уточняющие вопросы
   (вывод в живой лог/SSE), затем по полученным ответам строит план.
   Переиспользует зашитые в образ скиллы `grill-me` (+ `to-questionnaire`).
   Текст Jira докачивается на прогоне через `jira.fetchIssue` (см. §10).
   Результат = уточнённый контекст, который идёт в Resolve.
2. **Конвейер шагов**, выбираемый в UI на задачу + override на итерацию.
3. **Цикл фидбека**: fail шага → вернуть на разработку с промптом-фидбеком.
4. **Встроенный live-вью агента** (по мотивам `pi-web-ui`): подключение к
   работающей pi-сессии и интерактив из браузера. **Реализовано (Фаза 2):**
   каждый шаг = живая steerable `pi --mode rpc`-сессия (`RpcPiRunner`,
   транспорт `docker`|`local`), steer — `POST /iterations/:id/message`,
   прерывание шага — `POST /iterations/:id/abort`; лог рендерится как Markdown
   (`AgentMarkdown`), шаг раскрывается в полноэкранный modal.
5. **SSE-стрим** логов/статуса (вместо «обнови страницу»).
6. **Опциональные тикеты** + pluggable интеграции (Jira сейчас), ручное
   название задачи.
7. **PR-skill**: агент генерирует описание MR/PR, бэкенд создаёт MR с ним.
8. **Мультиагентные комнаты**: сложный шаг запускает не один `pi`, а **комнату из
   нескольких агентов** (coordinator + workers) в том же контейнере — как в
   текущей сессии (координатор + воркеры). Реализуется штатной pi-room-механикой.
9. **Адаптивный UI (desktop + mobile, первый класс на обеих платформах)**:
   десктоп — фиксированный сайдбар; мобильные (~320–640px) — нижняя навигация
   (или гамбургер) вместо сайдбара. Подход mobile-first на Tailwind: base
   (мобильные), `md` 768, `lg` 1024, `xl` 1280. Формы (поля/репозитории) и
   списки — fluid; обязателен `<meta name="viewport">`.
10. **Дизайн в стиле Матрицы (Matrix, фильм)**: неоновая CRT-тема с точной палитрой
   «Matrix Code Green» (SchemeColor): фон `#0D0208` (Vampire Black),
   тёмно-зелёный `#003B00` (панели), средний `#008F11` (бордеры/hover),
   фирменный зелёный `#00FF41` (Erin) — основной текст/акцент. Шрифт —
   моноширинный (system monospace / JetBrains Mono / Fira Code) вместо Rubik.
   Эффекты: лёгкое text-shadow-свечение, тонкие scanline/терминальные рамки.
   Цвета статусов по мотивам фильма (зелёный код + красная/синяя таблетки):
   completed=`#00FF41`, failed=`#FF0033` (красная таблетка),
   running=`#00B4FF` (синяя таблетка), pending=`#008F11` (приглушённый зелёный),
   cancelled=`#8A8A8A` (серый «агентов»).
11. **Селектор модели в UI**: при создании задачи пользователь выбирает модель
   (`provider/id`) для шага `resolve` (и опц. для других шагов). Список отдаёт
   бэкенд через `GET /issue-resolver/api/v1/models`. Источник — `pi --list-models`
   в среде агента (список аутентифицированных моделей), кэш + ручной refresh;
   альтернатива — курируемый список `models` в конфиге бэкенда (без ключей).
   Ключи остаются в `models.json`/`auth.json`, в UI не утекают.
12. **Персистентные логи шагов + детальный вид итерации (Фаза 1)**: сырой
   stdout/stderr каждого прогона шага сохраняется в `step_outputs` и отдаётся
   через `GET /iterations/:id/step-runs` (тип `StepRunWithLog`, `LEFT JOIN`,
   порядок step-first); в детальном виде UI итерации кликабельны (по умолчанию
   активна последняя), а выбранная показывает каждый шаг как «сессию» с сырым
   stdout/stderr.
13. **Фаза 2 — steerable-сессии шагов (реализовано)**: каждый шаг конвейера =
    живая steerable `pi --mode rpc`-сессия (`RpcPiRunner`, транспорт
    `docker`|`local`), активные сессии в `InMemoryStepSessionRegistry`; мёртвый
    `RpcBridge` удалён. Локальный режим (`ISSUE_RESOLVER_LOCAL=1`) — pi напрямую
    на хосте, `LocalContainerController`, `GitCliService`, workspace root по
    умолчанию `/home/agent/.issue-resolver/workspaces`. Прод docker-ветка
    (`ISSUE_RESOLVER_USE_REAL=1` + `DOCKER_SOCKET`) — изолированные контейнеры.
    Frontend: Markdown-рендер лога (`AgentMarkdown` + react-markdown@10 /
    remark-gfm@4), полноэкранный modal шага («Развернуть»), кнопка «Прервать».
    Промпты конвейера (`workflow/prompts.ts`) и `pr`-скилл переведены на
    английский. Лаунчер — `bin/service.sh` (`start|stop|restart|status`,
    `IR_MODE=local|docker`, PID/логи в `/tmp`).
14. **Желаемый результат задачи (реализовано)**: поле `Issue.desired_result`
    (`'md'` дефолт / `'html'` / `'pr'`). `'md'`/`'html'` задают артефакт
    `resolve` (`report.md` plain-markdown / self-contained `report.html`) и
    удаляют шаг `pr` из конвейера; `'pr'` его гарантирует. Артефакт отдаётся
    через `GET /issues/:id/result` (inline) и `/result/download`
    (attachment).
15. **Преемственность итераций (реализовано)**: итерация `number > 1` получает
    в промпт каждого шага блок `Previous iteration outcome` — `status`+`summary`
    resolve-отчёта предыдущей итерации плюс документ результата из рабочей
    папки (`report.md`/`report.html`, обрезка ~4000 символов). Агент продолжает
    с итога, а не решает задачу заново; битый JSON/отсутствующий документ
    деградируют без падения прогона.

---

## 6. Архитектура

```
Хост (macOS)
├── Backend-контейнер (Fastify + docker.sock)          ← единственный "оркестратор"
│     ├── REST API              ├── Workflow-движок (стейт-машина шагов)
│     ├── Docker-контроллер (dockerode)   ├── SSE-хаб
│     ├── Реестр pi-сессий (steer/abort)  └── SQLite (volume)
│
└── dotfiles-agent контейнер (по одному на задачу, создаётся из папки)
      ├── pi (room: Coordinator + N workers, ключи в models.json)
      ├── Playwright / agent-browser
      ├── git + хостовые creds      ├── скиллы (pr, grill-me, code-review …)
      ├── agent-memory → ~/.pi/agent/memory  (общая память модели, named volume)
      └── /workspaces/<issue-id>/  (клоны всех репозиториев задачи)
```

**На хосте запущено только Docker** (daemon + сборка/запуск контейнеров) и
браузер. Бэкенд-процесс, frontend-сервер и `pi` — всё в контейнерах.

**Прогон задачи:**
1. Пользователь создаёт задачу (описание + опц. тикет + репозитории + шаги)
2. Транзакция: `issue` + `iteration#1` + `repositories` → enqueue
3. Docker-контроллер создаёт папку + контейнер под задачу
4. Workflow гоняет выбранные шаги (каждый = живая steerable
   `pi --mode rpc`-сессия через `RpcPiRunner`)
5. Захват stdout/stderr → SSE (сырой + префикс шага)
6. Git commit/push; PR-шаг генерирует описание → создание MR через API
7. Статусы шагов/итерации пишутся в БД, стримятся на фронт; сырой stdout/stderr
   каждого прогона шага персистится в `step_outputs` и отдаётся вместе с шагами
   через `GET /iterations/:id/step-runs` (`LEFT JOIN`, порядок step-first).

**Память модели.** В контейнер задачи монтируется общий named volume
`agent-memory` (env `ISSUE_RESOLVER_MEMORY_VOLUME`) на
`/home/agent/.pi/agent/memory` — единый pi-memory на все задачи/комнаты,
поэтому ретро и восстановление статуса видят один «мозг».

**Продовый wiring.** `backend/src/deps.ts#buildDepsFromEnv`:
- `ISSUE_RESOLVER_LOCAL=1` (dev без docker) — pi запускается НАПРЯМУЮ
  (`RpcPiRunner('local')`), контейнер задачи = host-папка
  (`LocalContainerController`), `GitCliService`, workspace root по умолчанию
  `/home/agent/.issue-resolver/workspaces` (`ISSUE_RESOLVER_WORKSPACE_ROOT`).
- `ISSUE_RESOLVER_USE_REAL=1` — реальные адаптеры (`DockerodeContainerController`
  через `DOCKER_SOCKET`, `GitCliService`, `RpcPiRunner('docker')`, `HttpMrClient`
  с `MR_TOKEN`, `HttpJiraClient` с `JIRA_BASE_URL`/`JIRA_TOKEN`,
  `InMemoryStepSessionRegistry`); иначе `buildApp` использует Fake*-адаптеры.
  `server.ts` = `createDb()` + `buildDepsFromEnv(process.env)`, listen
  `0.0.0.0:8080`.

**Лаунчер.** `bin/service.sh` (`start|stop|restart|status`, `IR_MODE=local|docker`)
поднимает backend+frontend; PID/логи — в `/tmp`.

**Доступ по LAN.** Backend слушает `0.0.0.0:8080`; Vite — `0.0.0.0:5173` с
прокси `/issue-resolver → localhost:8080`. Наружу публикуется только UI:
`agent-fwd up 5173:5173` на хосте (внутри dev-контейнера нет docker CLI/sock).

---

## 7. Модель данных (SQLite / Drizzle)

```
issues (
  id TEXT PK,                 -- UUID
  title TEXT,                 -- ручное / из тикета
  description TEXT,           -- additional_context (до Jira-обогащения)
  jira_issue_url TEXT NULL,   -- NULL если тикет не выбран
  source TEXT NULL,           -- источник тикета (jira | ...) + метаданные JSON
  pipeline_steps TEXT,        -- JSON: выбранные при создании шаги (дефолт ['refine','resolve'])
  container_name TEXT,        -- имя/образ контейнера задачи
  status TEXT,                -- статус последней итерации
  created_at, updated_at
)

issue_repositories (
  id TEXT PK, issue_id FK→issues CASCADE,
  repository_url TEXT, branch_name TEXT,
  create_mr INTEGER NOT NULL DEFAULT 0,  -- per-repo: создавать ли MR/PR
  created_at, updated_at,
  UNIQUE(issue_id, repository_url, branch_name)
)

iterations (
  id TEXT PK, issue_id FK→issues CASCADE,
  number INT,                 -- MAX+1
  context TEXT,               -- уточнённый/доп. контекст
  review_context TEXT,        -- контекст для Reviewer (может быть пустым)
  is_review_need INT,         -- нужен ли запуск Reviewer
  steps TEXT,                 -- JSON override шагов (дефолт = pipeline_steps)
  model TEXT NULL,            -- модель pi для шага resolve
  status TEXT, created_at, updated_at,
  UNIQUE(issue_id, number)
)

step_runs (                    -- трек каждого шага и попыток цикла
  id TEXT PK, iteration_id FK→iterations CASCADE,
  step TEXT,                   -- refine | resolve | review | test | pr
  attempt INT,                 -- 1..N (цикл фидбека)
  status TEXT,                 -- pending|running|success|failed|needs_input|skipped
  context TEXT,                -- промпт шага
  feedback TEXT,               -- фидбек от предыдущего шага (при fail-цикле)
  created_at, updated_at
)

step_outputs (
  id TEXT PK, step_run_id FK→step_runs CASCADE UNIQUE,
  report TEXT,                 -- JSON-отчёт шага
  stdout TEXT NOT NULL DEFAULT '',  -- сырой stdout прогона шага
  stderr TEXT NOT NULL DEFAULT '',  -- сырой stderr прогона шага
  screenshots_dir TEXT,
  created_at, updated_at
)
```

Сырой лог шага хранится построчно в `step_outputs`; для уже существующих БД
недостающие колонки доводит идемпотентная `ensureStepOutputColumns` (ALTER при
отсутствии `stdout`/`stderr`). API отдаёт шаг как `StepRunWithLog`: `StepRun`
плюс `stdout`/`stderr` (`''` без output-строки) и `report`/`screenshots_dir`
(`null` без отчёта), собранные `LEFT JOIN`-ом и отсортированные step-first.

**Статусы:** `TaskStatus = pending|running|completed|failed|cancelled`.
`step_runs.status` добавляет `success|needs_input|skipped` (`needs_input` —
точка, где пользователь решает при цикле фидбека после N попыток).

---

## 8. Workflow / конвейер

Шаги: **refine → resolve → review → test → pr**. Дефолт при создании задачи —
`['refine', 'resolve']`; `resolve` гарантированно присутствует. Выбор в UI
дополняется флагами: `is_review_need` вставляет `review`+`test` сразу после
`resolve`; `create_mr: true` хотя бы у одного репозитория добавляет `pr` в
конец. `review_context` уходит Reviewer-у.

- Каждый шаг = **1..N запусков `pi`** в контейнере задачи (живая steerable
  `pi --mode rpc`-сессия на шаг, `RpcPiRunner`; транспорт `docker`|`local`):
  - простые шаги — один `pi`-процесс;
  - сложные (resolve по нескольким подсистемам/репозиториям) — **room из
    нескольких агентов** (coordinator + workers), скоординированных через
    `room_send_message`, `coordinator`-скилл и `pi-agents-talk-to-each-other`.
  - Обмен контекстом — **явно** через сообщения и файлы (context, feedback),
    не через session-memory (решение: «контейнер переиспользуем, свежая
    pi-сессия на итерацию»).
- Переходы:
  - `review`/`test` → `success` ⇒ следующий шаг; `failed` ⇒ откат на `resolve`
    с `feedback` (attempt+1).
  - **Цикл фидбека**: авто до **N=3**, затем `needs_input` — стоп и вопрос
    пользователю (продолжить / изменить промпт / остановить).
  - `pr` ⇒ генерация описания; commit/push + создание MR только для
    репозиториев с `create_mr: true` (остальные — файлы в рабочей папке);
    при 0 репозиториев — без git/MR.
- Провал любого другого шага ⇒ iteration `failed`.

---

## 9. Скиллы

| Скилл | Статус | Назначение |
|---|---|---|
| `grill-me` | ✅ в образе (remote) | Refine-шаг: гриллинг-сессия уточнения требований |
| `to-questionnaire` | ✅ в образе (remote) | Превращение описания в вопросы (к гриллингу) |
| `code-review` | ✅ в образе (remote) | Review-шаг |
| `pr` | ❌ **написать** | Генерация описания MR/PR |
| `resolve` / `test` | ⚠️ обёртки-промпты | Промпт-шаблоны шагов конвейера (по необходимости) |

Новые скиллы живут в `agent-skills/<name>/SKILL.md` (ре-синкаются в образ на
каждом запуске без пересборки).

---

## 10. Секреты (паттерн dotfiles-agent)

- **pi-ключи**: `pi/models.json` — gitignored per-machine файл, зашивается в
  образ при `build.sh`. Как сейчас.
- **MR-токен** (GitLab PAT / GitHub token): **так же, как в dotfiles-agent** —
  gitignored per-machine файл, зашиваемый в образ на этапе сборки (рядом с
  `models.json`, напр. `secrets.json` / отдельный ключ в конфиге). Передаётся в
  бэкенд-контейнер как зашитая конфигурация, а не env в рантайме.
- `localhost` → `host.docker.internal` rewrite в `mcp.json` — сохраняем паттерн.

---

## 11. Тестовая стратегия и фазы

**Пирамида тестов:**

| Слой | Инструмент | Что покрывает |
|---|---|---|
| unit | vitest | чистые доменные функции (`shared`) |
| integration | vitest + `app.inject` | REST-контракт и правила (`backend`) |
| component | vitest + testing-library | экраны SPA (`frontend`) |
| E2E | **Playwright** + Chromium | браузерные сценарии (`e2e/`) |

Актуальный прогон: `shared` — 52, `backend` — 155, `frontend` — 65, `e2e` — 2.

Playwright используется в двух ролях:
1. **E2E самого Issue Resolver** — браузерные сценарии UI (создать задачу →
   список → детали → итерации); на срезах Фаз 1–2 оркестратор заглушен (без
   реального Docker/агента).
2. **Рантайм шага `test`/`review`** — агент гоняет ЦЕЛЕВОЕ приложение в браузере
   через Playwright/agent-browser (это конвейер, см. §8).

В образе уже есть Playwright (chromium/firefox/webkit) + agent-browser:
дополнительная установка не нужна, только `@playwright/test` как dev-зависимость `e2e/`.

### Фазы

1. **Фаза 0 — Каркас**: монррепо, Fastify+TS+Drizzle+SQLite, React+Vite+
   Tailwind, SSE-хелпер, Docker-контроллер (реплика `agent-attach` на dockerode)
2. **Фаза 1 — Ядро без pi** ✅: CRUD issue/iterations, форма с выбором шагов и
   опциональным тикетом, список + деталь; персистентные логи шагов
   (`step_outputs.stdout/stderr`, тип `StepRunWithLog`) и детальный вид итерации
   (кликабельные итерации, по умолчанию активна последняя; шаг = «сессия» с
   сырым логом)
3. **Фаза 2 — Запуск агента** ✅: steerable `pi --mode rpc`-сессии шагов
   (`RpcPiRunner`), реестр сессий (steer/abort), локальный режим без docker,
   git-резолв (originals-кэш, ветка, commit, push), SSE-лог
4. **Фаза 3 — Конвейер**: workflow-движок, стейт-машина, цикл фидбека
   (`step_runs`/`step_outputs`)
5. **Фаза 4 — PR/MR**: `pr`-скилл → описание → создание MR через API
6. **Фаза 5 — Live-вью**: встроить pi-web-ui, RPC-релей, интерактив
7. **Фаза 6 — Refine + Jira**: гриллинг-шаг (`grill-me`) + Jira и pluggable
   интеграции тикетов
8. **E2E-пакет**: `e2e/` на `@playwright/test` — сквозные браузерные сценарии UI;
   на срезах Фаз 1–2 гоняются поверх заглушенного оркестратора

---

## 12. Открытые вопросы / риски

- **Где живёт workspace задачи** (решено): backend использует
  `/workspaces/<issue-id>/`; в `DockerodeContainerController.spawn` это
  source-bind, монтируемый в контейнер задачи по тому же пути
  `/workspaces/<issue-id>/`; имя контейнера `issue-resolver-<issue-id>`.
  Память модели монтируется отдельным named volume `agent-memory`
  (`ISSUE_RESOLVER_MEMORY_VOLUME`) на `/home/agent/.pi/agent/memory`.
  uid/gid выравнивается под хостового пользователя (реплика `agent-attach`).
- **`pi-web-ui`** — изучить механизм подключения (RPC-стрим поверх WS/SSE),
  чтобы корректно встроить релей в бэкенд.
- **Цикл фидбека против «свежей сессии»**: контекст между шагами только явный —
  убедиться, что промпт-пайплайн передаёт фидбек полностью (не терять).
- **Нативный билд/docker.sock на macOS** — uid/gid alignment и том volumes
  продумать при репликации `agent-attach`.
- **Мультиагентный room**: конкуренция за файлы и стримы нескольких pi-процессов
  в одном контейнере — нужен явный протокол непересекающихся файлов и один
  SSE-агрегатор на комнату.

---

## 13. Требования к spawned-агенту (что нужно pi на шаге конвейера)

Оркестратор обязан предоставить каждому шагу — иначе агент будет гадать:

1. **Контекст-бандл** (явный, не ad-hoc строка): issue + контекст итерации +
   пути клонированных репозиториев + конвенции проекта (AGENTS.md / GLOSSARY.md)
   + фидбек предыдущих шагов + выходной контракт + hard-rules.
2. **Корректный `--dir`** на `workspaces/<issue-id>/<repo>`, ветка уже
   создана/чекаутнута до запуска агента.
3. **Тулы и allowlist по шагу** (`--tools`, MCP exposure): `resolve` — без
   прав на build/test/commit/push; `review`/`test` — build/test/browser
   разрешены.
4. **Скиллы шага** присутствуют в контейнере: `pr`, `code-review`, `grill-me`,
   `tdd`, `coordinator` (+ языковые при необходимости).
5. **Git identity + creds** настроены до запуска (`user.name/email`, хостовые
   creds из dotfiles-agent).
6. **Выходной контракт**: каждый шаг пишет структурированный
   `.issue-step-result.json` + возвращает `exit code` → оркестратор
   детерминированно парсит (обобщение `.issue-reviewer-result.json` оригинала).
   Формат `.issue-step-result.json`:
   ```json
   {
     "status": "pass" | "fail" | "blocked",
     "summary": "текст",
     "scenarios": [{ "name": "...", "status": "pass"|"fail", "details": "..." }],
     "findings": [{ "severity": "minor"|"major"|"critical", "description": "..." }]
   }
   ```
   Маппинг в `StepRunStatus` (реализовано в `shared/step-result.ts`):
   `exit 0` + (`pass`/null) → `success`; `exit 0` + `blocked` → `needs_input`;
   иначе → `failed`.
7. **Мультиагентность**: для сложных шагов — room (coordinator + workers) с
   непересекающимися файлами; room-механика включена.
8. **Чёткие hard-rules** шага (запреты: commit/push у resolve без финального
   шага pr; build/test только по разрешению).
9. **Ожидания стрима**: stdout/stderr уходят в SSE — агент структурирует вывод
   (префикс шага), а RPC-клиент честно читает stdout (backpressure).