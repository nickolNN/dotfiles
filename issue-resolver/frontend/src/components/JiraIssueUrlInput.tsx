import { useEffect, useId, useRef, useState } from 'react';
import type { JiraIssueInfo } from '@issue-resolver/shared';
import { extractIssueKeyFromUrl } from '@issue-resolver/shared';
import { validateJiraUrl } from '../api/client';

/** Пауза после последнего нажатия, прежде чем дёрнуть API валидации. */
export const JIRA_URL_DEBOUNCE_MS = 600;

type ValidationState =
  | 'idle'
  | 'checking'
  | 'valid'
  | 'invalid'
  | 'invalid-url';

export interface JiraIssueUrlInputProps {
  value: string;
  /** Новый URL и (при успехе) данные Jira-задачи; `null` — сброс. */
  onChange: (url: string, issue: JiraIssueInfo | null) => void;
  /** Внешняя ошибка (например, серверная при submit). */
  error?: string;
  disabled?: boolean;
  id?: string;
  label?: string;
  placeholder?: string;
}

const inputClass =
  'w-full rounded-none border border-[#008F11] bg-[#0D0208] px-3 py-2 pr-10 text-sm text-[#00FF41] outline-none placeholder:text-[#008F11] focus:border-[#00FF41] focus:shadow-[0_0_8px_rgba(0,255,65,0.35)] disabled:opacity-50';
const labelClass = 'mb-1 block text-sm font-medium text-[#00FF41]/80';

/** Карточка enriched-инфо о найденной Jira-задаче. */
function JiraIssueCard({ issue }: { issue: JiraIssueInfo }) {
  return (
    <div
      data-testid="jira-issue-card"
      className="mt-2 border border-[#00FF41]/40 bg-[#0A1A0A] p-3"
    >
      <div className="flex items-center gap-2">
        <span className="rounded-none border border-[#00FF41] px-2 py-0.5 text-xs font-semibold text-[#00FF41]">
          {issue.key}
        </span>
        <span className="text-sm font-medium text-[#00FF41]">
          {issue.title || issue.key}
        </span>
      </div>
      {issue.summary && (
        <p className="mt-2 line-clamp-3 text-xs text-[#00FF41]/60">
          {issue.summary}
        </p>
      )}
    </div>
  );
}

/**
 * Поле ввода ссылки на Jira-задачу с живой валидацией: debounce, индикатор
 * состояния (спиннер/✓/✕), карточка метаданных при успехе и красный текст
 * ошибки при неудаче. Запрос идёт, только когда из URL удалось извлечь ключ.
 */
export default function JiraIssueUrlInput({
  value,
  onChange,
  error,
  disabled = false,
  id,
  label = 'Ссылка на Jira',
  placeholder,
}: JiraIssueUrlInputProps) {
  const autoId = useId();
  const inputId = id ?? `jira-url-${autoId}`;
  const messageId = `${inputId}-message`;

  const [state, setState] = useState<ValidationState>('idle');
  const [issue, setIssue] = useState<JiraIssueInfo | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    // Любое изменение значения сбрасывает прошлый результат.
    setIssue(null);
    setMessage(null);

    const trimmed = value.trim();

    // Пусто или выключено — ничего не проверяем.
    if (!trimmed || disabled) {
      setState('idle');
      return () => {
        cancelled = true;
      };
    }

    // Пытаемся разобрать как URL и извлечь ключ.
    let url: string;
    try {
      url = new URL(trimmed).toString();
    } catch {
      setState('invalid-url');
      return () => {
        cancelled = true;
      };
    }

    const key = extractIssueKeyFromUrl(trimmed);
    if (!key) {
      setState('invalid-url');
      return () => {
        cancelled = true;
      };
    }

    // Спиннер показываем сразу, а запрос шлём только после паузы в вводе.
    setState('checking');

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      validateJiraUrl(url)
        .then((result) => {
          if (cancelled) return;
          if (result.valid && result.issue) {
            setIssue(result.issue);
            setMessage(null);
            setState('valid');
            onChange(trimmed, result.issue);
          } else {
            setIssue(null);
            setMessage(result.error ?? 'Jira-задача не найдена');
            setState('invalid');
            onChange(trimmed, null);
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setIssue(null);
          setMessage(
            err instanceof Error
              ? err.message
              : 'Не удалось проверить Jira-задачу',
          );
          setState('invalid');
          onChange(trimmed, null);
        });
    }, JIRA_URL_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    // onChange сознательно не в зависимостях: родитель может передавать
    // инлайн-функцию, и валидация не должна перезапускаться на каждом рендере.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, disabled]);

  return (
    <div data-testid="jira-url-input" data-state={state}>
      <label className={labelClass} htmlFor={inputId}>
        {label}
      </label>
      <div className="relative">
        <input
          id={inputId}
          data-testid="jira-url-field"
          className={inputClass}
          type="text"
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          aria-invalid={state === 'invalid' || Boolean(error)}
          aria-describedby={message || error ? messageId : undefined}
          onChange={(event) => onChange(event.target.value, null)}
        />
        <span
          data-testid="jira-url-status"
          data-state={state}
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm"
          aria-hidden="true"
        >
          {state === 'checking' && (
            <span
              data-testid="jira-url-spinner"
              className="block h-4 w-4 animate-spin rounded-full border-2 border-[#008F11] border-t-[#00FF41]"
            />
          )}
          {state === 'valid' && (
            <span data-testid="jira-url-valid" className="text-[#00FF41]">
              ✓
            </span>
          )}
          {state === 'invalid' && (
            <span data-testid="jira-url-invalid" className="text-[#FF0033]">
              ✕
            </span>
          )}
        </span>
      </div>

      {state === 'invalid-url' && (
        <p
          data-testid="jira-url-hint"
          className="mt-1 text-xs text-[#00FF41]/40"
        >
          Непохоже на ссылку Jira-задачи
        </p>
      )}

      {(message || error) && (
        <p
          id={messageId}
          data-testid="jira-url-message"
          role="alert"
          className="mt-1 text-xs font-medium text-[#FF0033]"
        >
          {message ?? error}
        </p>
      )}

      {state === 'valid' && issue && <JiraIssueCard issue={issue} />}
    </div>
  );
}