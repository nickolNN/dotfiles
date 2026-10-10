# Issue Resolver Backend — Функциональная спецификация

> Составлено на основе полного исследования исходного кода Go-бэкенда `kc_issue_resolver_back`.
> Документ описывает **что** делает бэкенд, а не **как** он реализован.

---

## 1. Назначение системы

**Issue Resolver Backend** — сервер-оркестратор AI-агента. Принимает задачу (Jira + git-репозитории + контекст), готовит Git-окружение, запускает AI для написания кода, коммитит/пушит результат, и опционально запускает второго AI-агента (Reviewer) для проверки качества через реальное тестирование (браузерная автоматизация).

---

## 2. Технологический стек (в оригинале)

- Go 1.26 + Fiber (HTTP) + PostgreSQL + Docker + Wire (DI) + golang-migrate
- AI-агент: Kilo CLI v7.4.21, запускается в Docker-контейнере через `docker run`
- Docker-образ: `node:22-bookworm` с Playwright + Chromium + Git + Go + Docker CLI/Compose

---

## 3. REST API

Базовый префикс: `/issue-resolver/api/v1`

| Метод | Путь | Назначение |
|-------|------|-----------|
| `GET` | `/ping` | Health-check |
| `GET` | `/issues` | Список всех задач (с репозиториями и статусом последней итерации) |
| `POST` | `/issues` | Создать задачу (атомарно: Issue + Iteration #1 + worker.Enqueue) |
| `GET` | `/issues/:id` | Одна задача по ID |
| `GET` | `/issues/:id/iterations` | Все итерации задачи |
| `POST` | `/issues/:id/iterations` | Создать новую итерацию (перезапуск с новым контекстом) |

### 3.1. POST /issues — Создать задачу

**Тело**:
```json
{
  "jira_issue_url": "https://jira.example.com/browse/KLA-5672",
  "repositories": [
    { "repository_url": "git@gitlab.example.com:project.git", "base_branch": "dev" }
  ],
  "additional_context": "Дополнительные инструкции",
  "review_context": "Контекст для Reviewer",
  "is_review_need": false
}
```

**Валидация**: `jira_issue_url` (URL), `repositories` (≥1), `repository_url` (URL), `base_branch` (непустая).

**Бизнес-логика (в одной транзакции)**:
1. INSERT в `issues` (UUID, jira_issue_url, session_id='', timestamps)
2. INSERT каждого репозитория в `issue_repositories`
3. INSERT первой итерации (number=1, status=`pending`, context=`additional_context`)
4. Commit транзакции
5. Enqueue задачи Resolver в воркер (вне транзакции)

### 3.2. GET /issues — Список задач

Возвращает все задачи, отсортированные по `created_at DESC`. Статус задачи определяется через `JOIN LATERAL` по последней итерации (MAX number).

### 3.3. POST /issues/:id/iterations — Создать итерацию

**Тело**:
```json
{
  "context": "Новый контекст",
  "review_context": "Контекст для Reviewer",
  "is_review_need": true
}
```

**Валидация**: `context` обязателен.

**Бизнес-логика**:
1. Номер = `MAX(number) + 1`
2. Статус: `pending` (если `is_review_need`), иначе `running`
3. Если `!is_review_need` — enqueue Resolver в воркер

---

## 4. База данных (PostgreSQL)

### 4.1. Таблицы

```sql
issues (
  id UUID PK,
  jira_issue_url TEXT,
  session_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

issue_repositories (
  id UUID PK,
  issue_id UUID FK→issues CASCADE,
  repository_url TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  created_at TIMESTAMP, updated_at TIMESTAMP,
  UNIQUE(issue_id, repository_url, branch_name)
);

issue_iterations (
  id UUID PK,
  issue_id UUID FK→issues CASCADE,
  number INT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  review_context TEXT NOT NULL DEFAULT '',
  is_review_need BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL,
  created_at TIMESTAMP, updated_at TIMESTAMP,
  UNIQUE(issue_id, number)
);

issue_review_reports (
  id UUID PK,
  issue_iteration_id UUID FK→issue_iterations CASCADE UNIQUE,
  report JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP, updated_at TIMESTAMP
);
```

### 4.2. Статусная модель итераций

```
pending → running → completed
                  → failed
                  → cancelled
```

Статус задачи = статус последней итерации (через `JOIN LATERAL`).

---

## 5. Worker — основной бизнес-процесс

Worker потребляет задачи из in-memory Go-канала (буфер 100). Два типа задач:

### 5.1. Resolver — «Решить задачу»

1. **Загрузить данные**: Issue + репозитории + текущая Iteration из БД
2. **Статус → `running`**
3. **Jira API**: если есть `jira_issue_url` и `JIRA_TOKEN` → запрос к `/rest/api/2/issue/{key}` → получение `summary`, `description`, `status`, `priority`
4. **Git-окружение**:
   - Originals-кэш: клонирование в `originals/<name>-<sha256[:4]>` (иммутабельный, обновляется `git pull --ff-only`)
   - Workspace: клонирование из кэша в `workspaces/<issue-id>/`
   - Ветка: имя = Jira issue key (напр. `KLA-5672`) или `issue-resolver/<uuid>`
   - Если ветка уже в remote → чекаут (продолжение работы)
   - `git config core.longpaths true` (Windows-совместимость)
5. **Скопировать `books/`**: 3 книги по разработке ПО в workspace как read-only референс для AI
6. **Запустить AI-агента (Kilo)** через `docker run`:
   - Контейнер: `issue-resolver-kilo:latest`
   - Подключение: `--network container:kilo-serve` (общий сетевой namespace с persistent Kilo)
   - Промпт включает: данные Jira-тикета, контекст итерации, дополнительный контекст
   - **Жёсткие правила для агента**: НЕ запускать сборки/тесты/линтеры без явного разрешения, НЕ коммитить, НЕ пушить, НЕ создавать ветки, следовать архитектуре репозитория, использовать `books/` как референс
   - SessionID: сохраняется между итерациями (агент «помнит» контекст)
   - При ошибке "session not found" — перезапуск без sessionID
   - Парсинг JSON-строк из stdout
7. **Коммит и push**: для каждого репозитория — `git add -A`, `git commit -m "feat: <summary>"`, `git push --set-upstream origin <branch>`. Пушит даже если нет изменений.
8. **Если `is_review_need == false`**: статус → `completed`, очистка workspace
9. **Если `is_review_need == true`**: enqueue задачи Reviewer в воркер

### 5.2. Reviewer — «Проверить решение»

1. **Загрузить контекст**: текущая итерация + **вся история итераций** (для понимания что менялось)
2. **Статус → `running`**
3. **Запустить AI-агента как ревьюера**:
   - **Роль**: «Ты независимый ревьюер. НЕ продолжай реализацию. Инспектируй, тестируй, проверяй.»
   - **Разрешено**: устанавливать зависимости, запускать сборки, тесты, dev-серверы, Docker Compose, браузерную автоматизацию (через chrome-devtools MCP)
   - **Требуется**: проверять реальное поведение, не только код; использовать браузер для UI; если CORS — создать временный reverse-proxy; скриншоты как доказательства
   - **Результат**: файл `.issue-reviewer-result.json` со структурой:
     ```json
     {
       "status": "pass" | "fail" | "blocked",
       "summary": "текст",
       "scenarios": [{ "name": "...", "status": "pass"|"fail", "details": "..." }],
       "findings": [{ "severity": "minor"|"major"|"critical", "description": "..." }]
     }
     ```
4. **Прочитать результат**: парсинг `.issue-reviewer-result.json`
5. **Сохранить скриншоты**: копирование из workspace в `screenshots/<issue-id>/<iteration-id>/`
6. **Сохранить отчёт в БД**: UPSERT в `issue_review_reports` (по `issue_iteration_id`)
7. **Очистить Docker-ресурсы ревьюера**: удалить контейнеры/сети/volumes по compose project label
8. **Итоговый статус**: `completed` (pass) или `failed` (fail/blocked/ошибка)

---

## 6. Git-сервис

- **Originals-кэш**: каждый репозиторий клонируется один раз в `originals/<name>-<sha256(remoteURL)[:4]>`. Иммутабельный — только `git pull --ff-only`.
- **Ветки**: Jira key (если есть) или `issue-resolver/<uuid>`. Коллизии по одному URL с разными base branch → уникальные имена веток.
- **Windows**: `core.longpaths=true` на всех git-операциях.
- **Stale lock**: `index.lock` удаляется перед коммитом.

---

## 7. Интеграция с AI-агентом (Kilo)

В кодовой базе **два** подхода:
- `internal/gateway/kilo/kilo.go` — HTTP REST-клиент (написан, но **не используется**)
- `internal/service/worker/worker.go` — **реально используется** `docker run` CLI

Реальное выполнение: `docker run --rm -i --network container:kilo-serve issue-resolver-kilo:latest run --attach http://127.0.0.1:4096 --dir /workspaces/<id> --auto --format json --agent code`

Kilo-контейнер (`issue-resolver-kilo:latest`) на базе `node:22-bookworm` содержит:
- `@kilocode/cli@7.4.21`
- Playwright + Chromium (браузерная автоматизация)
- chrome-devtools-mcp
- Git, Python, Docker CLI, Docker Compose, Go
- Кэши npm/yarn/pnpm/corepack (монтируются как Docker volumes)

SessionID сохраняется в `issues.session_id` и передаётся между итерациями.

---

## 8. Конфигурация

| Параметр | Переменная | Default | Назначение |
|----------|-----------|--------|------------|
| server-host | `SERVER_HOST` | `localhost:8080` | HTTP-сервер |
| jira-token | `JIRA_TOKEN` | — | Jira REST API |
| postgres-user/password/host/db-name | `POSTGRES_*` | `postgres/postgres/localhost/postgres` | БД |
| mq-host | `MQ_HOST` | `amqp://...` | RabbitMQ (задекларирован, не используется) |
| auth-host | `AUTH_HOST` | `kc-dev.dev.yadro.com:443` | gRPC auth (задекларирован, не используется) |

---

## 9. Docker-развёртывание

Два контейнера:
1. **`kilo-serve`** — persistent AI-сервис на порту 4096
2. **Основной** — Go-бэкенд + Kilo CLI + Playwright

Основной образ: `node:22-bookworm` с установленными Kilo CLI, Playwright, Chromium, Git, Go, Docker CLI/Compose, chrome-devtools-mcp.

---

## 10. Что НЕ сделано / задекларировано но не используется

- **RabbitMQ**: флаги и код подключения есть, но worker — in-memory channel
- **gRPC Auth**: флаг есть, но хендлеры не проверяют авторизацию (только CORS)
- **Kilo HTTP Gateway**: написан REST-клиент для Kilo API, но реально используется `docker run` CLI

---

## 11. Ключевые архитектурные решения

1. **Транзакционное создание**: Issue + Iteration #1 создаются в одной транзакции; worker.Enqueue — после commit
2. **Status через LATERAL JOIN**: статус Issue = статус последней итерации
3. **SessionID между итерациями**: AI-агент помнит контекст предыдущей работы
4. **Originals-кэш**: иммутабельные копии репозиториев, обновляются `pull --ff-only`
5. **Ревьюер не модифицирует код**: только инспектирует и тестирует; результат — structured JSON
6. **Очистка workspace**: после каждой итерации workspace удаляется
7. **Скриншоты сохраняются** в `screenshots/` даже после очистки workspace
8. **Review-отчёт**: структурированный JSON (`status` + `summary` + `scenarios[]` + `findings[]`)