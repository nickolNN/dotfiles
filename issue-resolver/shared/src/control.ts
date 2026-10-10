// Управляющий API живого pi-контракта. Не трогать без согласования с координатором.

/** Режим доставки сообщений в очередь: все сразу или по одному. */
export type SteeringMode = 'all' | 'one-at-a-time';

/** Режим отправки пользовательского промпта: прервать (`steer`) или в очередь. */
export type PromptMode = 'steer' | 'followUp';

/**
 * Слэш-команда для палитры. `source: 'builtin'` — встроенная команда pi,
 * которую backend перехватывает на `POST /iterations/:id/prompt`; остальные
 * приходят из `get_commands` и раскрываются самим pi.
 */
export interface SessionCommandInfo {
  name: string;
  description?: string;
  /** Подсказка аргументов, напр. `[provider/id]`. */
  argumentHint?: string;
  source: 'builtin' | 'extension' | 'prompt' | 'skill';
}

/** Модель, доступная для выбора в текущей pi-сессии. */
export interface SessionModelInfo {
  provider: string;
  id: string;
  name?: string;
}

/** Текущее состояние управления живой pi-сессией. */
export interface SessionControlState {
  /** Отображаемая метка модели (`name`, иначе `id`). */
  model: string | null;
  provider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  steeringMode: SteeringMode | null;
  followUpMode: SteeringMode | null;
  autoCompactionEnabled: boolean | null;
  autoRetryEnabled: boolean | null;
  isStreaming: boolean;
  sessionName: string | null;
}

/** Полный снимок управления: состояние, доступные модели, уровни и команды. */
export interface SessionControlSnapshot {
  state: SessionControlState;
  models: SessionModelInfo[];
  thinkingLevels: string[];
  commands: SessionCommandInfo[];
}

/** Команды управления живой pi-сессией. `ControlResult.data` — ответ pi. */
export type SessionCommand =
  | { type: 'set_model'; provider: string; modelId: string }
  | { type: 'cycle_model' }
  | { type: 'set_thinking_level'; level: string }
  | { type: 'cycle_thinking_level' }
  | { type: 'compact'; instructions?: string }
  | { type: 'clear_queue' }
  | { type: 'set_auto_compaction'; enabled: boolean }
  | { type: 'set_auto_retry'; enabled: boolean }
  | { type: 'abort_retry' }
  | { type: 'set_steering_mode'; mode: SteeringMode }
  | { type: 'set_follow_up_mode'; mode: SteeringMode }
  | { type: 'bash'; command: string }
  | { type: 'abort_bash' };

/** Результат управляющей команды (compaction, model, bash и т.п.). */
export interface ControlResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Результат отправки промпта: `started` — пошёл в работу; `queued` — встал в
 * очередь; `handled` — потреблён ожидающим обработчиком ввода.
 */
export interface PromptResult {
  ok: boolean;
  disposition: 'started' | 'queued' | 'handled';
  /** Человекочитаемая причина отказа (при `ok: false`). */
  error?: string;
}