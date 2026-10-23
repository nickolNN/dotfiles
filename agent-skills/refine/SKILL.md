---
name: refine
description: >-
  Refine-шаг конвейера issue-resolver: RU-склейка интервью `grilling`
  (design tree → frontier → rounds) с механикой шага — вход шага, вопрос
  через инструмент `question`, `plan.md` и объект `execution`. Сам метод
  живёт в скилле `grilling`, здесь только адаптер. Use when the refine
  step of the issue-resolver pipeline runs and a raw ticket must become a
  plan.
---

# Refine — адаптер шага конвейера

Refine превращает сырой тикет в план, по которому resolve работает без
догадок. **Сам метод — в скилле `grilling`;** этот файл только склеивает
его с механикой шага.

## Метод: grilling

Интервью ведётся по протоколу скилла **`grilling`**: он задаёт форму
(design tree → frontier → rounds), правило «факты — сам, решения — за
пользователем» и момент завершения (frontier пуст). Здесь — только то,
чего оригинал не знает.

Адаптация под пайплайн: у нас нет чат-раунда — есть инструмент
**`question`**, один вызов на вопрос; вызов блокирует ход до ответа
пользователя и возвращает ответ. Поэтому frontier задаётся по одному
вопросу, а не раундом:

```json
{ "question": "...", "options": [ { "label": "...", "description": "..." } ] }
```

2–5 конкретных вариантов, рекомендуемый ответ — первым.

## Вход шага

- `title`, `description` (additional_context), `jira_text` (если есть),
  `repositories`, `iteration_context` (при повторном refine),
  `pipeline_steps`.

## Артефакты (контракт вывода)

- `plan.md` в корне рабочей папки — уточнённый контекст: принятые решения
  с обоснованием, план для resolve, execution topology, риски, файлы,
  интеграционные точки;
- `.issue-step-result.json` — `summary`, `scenarios`, `execution`
  (`mode` / `executors` / `decomposition` / `stages` / `rationale`);
- `iterations/<n>/.refine.md` — нарратив шага для report-агента.

Что писать в `execution` и лимиты воркеров задаёт промпт шага
(`prompts/step-refine.md`) — здесь не дублируются.

## Ограничения

- Не пиши код — реализация за resolve.
- Не коммить и не пушь — это PR-шаг.
- Не дублируй review/test, если они есть в `pipeline_steps`.
- Продуктовые/дизайнерские решения — вопросом пользователю, не сам.