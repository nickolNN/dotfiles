// Встроенные интерактивные команды pi. RPC-команда `prompt` их НЕ исполняет
// (в отличие от CLI-интерпретатора) — без перехвата `/model`, `/compact` и
// т.п. ушли бы модели обычным текстом. Поэтому сервер обрабатывает их сам и
// шлёт явную RPC-команду (или глотает клиентские действия).
// Вдохновлено pi-web-ui (server/slash-commands.ts), но под наш RPC-транспорт.

/** Спецификация встроенной slash-команды для палитры. */
export interface BuiltinSlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

/**
 * Набор встроенных команд, которые перехватываются сервером (имена без `/`).
 * Держать в синхроне с `handleBuiltinSlash`.
 */
export const BUILTIN_SLASH_COMMANDS: BuiltinSlashCommand[] = [
  {
    name: 'new',
    description: 'Новая сессия (можно с первым промптом: /new <текст>)',
    argumentHint: '[текст]',
  },
  {
    name: 'name',
    description: 'Задать имя текущей сессии',
    argumentHint: '<имя>',
  },
  {
    name: 'model',
    description: 'Сменить модель (provider/id или подстрока; без аргумента — цикл)',
    argumentHint: '[provider/id]',
  },
  {
    name: 'compact',
    description: 'Сжать контекст',
    argumentHint: '[инструкции]',
  },
  {
    name: 'thinking',
    description: 'Уровень размышления (без аргумента — цикл)',
    argumentHint: '[off|minimal|low|medium|high|xhigh|max]',
  },
  {
    name: 'cwd',
    description: 'Текущий рабочий каталог (в RPC-сессии не переключается)',
    argumentHint: '[путь]',
  },
  {
    name: 'resume',
    description: 'Список сессий (в RPC-сессии недоступен)',
  },
  {
    name: 'reload',
    description: 'Перезагрузка расширений (в RPC-сессии недоступна)',
  },
  {
    name: 'help',
    description: 'Показать все команды',
  },
  {
    name: 'copy',
    description: 'Скопировать последний ответ ассистента',
  },
];

const BUILTIN_NAMES: ReadonlySet<string> = new Set(
  BUILTIN_SLASH_COMMANDS.map((command) => command.name),
);

const THINKING_LEVELS: ReadonlySet<string> = new Set([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/**
 * Разбирает текст как `/команда аргументы`. Возвращает null, если это не
 * slash-строка. Аргументы сохраняют пробелы/слэши (`provider/id`).
 */
export function parseSlash(
  text: string,
): { name: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const match = trimmed.match(/^\/([^\s]+)\s*([\s\S]*)$/);
  if (!match || !match[1]) return null;
  return { name: match[1], args: match[2].trim() };
}

/** Результат обработки slash-команды сервером. */
export type SlashOutcome =
  | { kind: 'not-builtin' }
  | {
      kind: 'handled';
      ok: boolean;
      /** RPC-команда pi для отправки; null — перехвачено без запроса. */
      command: Record<string, unknown> | null;
      /** Человекочитаемая причина отказа (при `ok: false`). */
      error?: string;
    };

export interface SlashDeps {
  /** Резолв модели по подстроке (id/name/provider) через get_available_models. */
  resolveModel: (
    query: string,
  ) => Promise<{ provider: string; id: string } | null>;
}

/**
 * Обрабатывает встроенную slash-команду. `not-builtin` — команду обрабатывает
 * сам pi (`prompt`, expansion шаблонов/скиллов); `handled` — сервер исполняет
 * (`command`) либо перехватывает без RPC (`command:null`, `ok:false`).
 */
export async function handleBuiltinSlash(
  name: string,
  args: string,
  deps: SlashDeps,
): Promise<SlashOutcome> {
  if (!BUILTIN_NAMES.has(name)) return { kind: 'not-builtin' };

  switch (name) {
    case 'compact':
      return {
        kind: 'handled',
        ok: true,
        command: {
          type: 'compact',
          ...(args.length > 0 ? { customInstructions: args } : {}),
        },
      };

    case 'thinking': {
      const level = args.trim().toLowerCase();
      if (level.length === 0) {
        return { kind: 'handled', ok: true, command: { type: 'cycle_thinking_level' } };
      }
      if (!THINKING_LEVELS.has(level)) {
        return {
          kind: 'handled',
          ok: false,
          command: null,
          error: `Неизвестный уровень размышления: ${args.trim()}. Доступно: off, minimal, low, medium, high, xhigh, max.`,
        };
      }
      return {
        kind: 'handled',
        ok: true,
        command: { type: 'set_thinking_level', level },
      };
    }

    case 'name':
      if (args.trim().length === 0) {
        return {
          kind: 'handled',
          ok: false,
          command: null,
          error: 'Укажите имя сессии: /name <имя>',
        };
      }
      return {
        kind: 'handled',
        ok: true,
        command: { type: 'set_session_name', name: args.trim() },
      };

    case 'model': {
      const query = args.trim();
      if (query.length === 0) {
        return { kind: 'handled', ok: true, command: { type: 'cycle_model' } };
      }
      // Точная форма provider/id — без обращения к списку моделей.
      const slash = query.indexOf('/');
      if (slash > 0 && slash < query.length - 1) {
        const provider = query.slice(0, slash).trim();
        const modelId = query.slice(slash + 1).trim();
        if (provider.length > 0 && modelId.length > 0) {
          return {
            kind: 'handled',
            ok: true,
            command: { type: 'set_model', provider, modelId },
          };
        }
      }
      const resolved = await deps.resolveModel(query);
      if (!resolved) {
        return {
          kind: 'handled',
          ok: false,
          command: null,
          error: `Модель не найдена: ${query}. Уточните provider/id или подстроку.`,
        };
      }
      return {
        kind: 'handled',
        ok: true,
        command: {
          type: 'set_model',
          provider: resolved.provider,
          modelId: resolved.id,
        },
      };
    }

    case 'new':
      return {
        kind: 'handled',
        ok: true,
        command: { type: 'new_session' },
      };

    // Клиентские (help/copy) и недоступные в RPC-сессии (cwd/resume/reload)
    // команды: глотаем (ok:true — это не ошибка), чтобы pi не отправил их
    // модели как текст; клиент отрисует собственную справку/действие.
    case 'cwd':
    case 'resume':
    case 'reload':
    case 'help':
    case 'copy':
      return { kind: 'handled', ok: true, command: null };

    default:
      return { kind: 'not-builtin' };
  }
}