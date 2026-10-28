import { useEffect, useId, useRef, useState } from 'react';
import type { RepoInfo, RepoPlatform } from '@issue-resolver/shared';
import { validateRepos } from '../api/client';

export const REPO_URL_DEBOUNCE_MS = 600;

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const SSH_URL = /^[^@/]+@([^:/]+)[:/](.+)$/;

export function normalizeRepoUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/\s/.test(trimmed)) return null;

  const sshMatch = SSH_URL.exec(trimmed);
  const candidate = sshMatch
    ? `https://${sshMatch[1].toLowerCase()}/${sshMatch[2].replace(/^\/+/, '')}`
    : URL_SCHEME.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;

  try {
    const url = new URL(candidate);
    return url.hostname ? url.toString() : null;
  } catch {
    return null;
  }
}

export function isLikelyRepoUrl(value: string): boolean {
  const normalized = normalizeRepoUrl(value);
  if (!normalized) return false;
  try {
    const url = new URL(normalized);
    const segments = url.pathname.split('/').filter((s) => s.length > 0);
    return segments.length >= 2;
  } catch {
    return false;
  }
}

type ValidationState =
  | 'idle'
  | 'checking'
  | 'valid'
  | 'invalid'
  | 'invalid-url';

export interface RepoUrlInputProps {
  value: string;
  onChange: (url: string, info?: RepoInfo | null) => void;
  error?: string;
  disabled?: boolean;
  id?: string;
  label?: string;
  placeholder?: string;
}

const inputClass =
  'w-full rounded-none border border-[#008F11] bg-[#0D0208] px-3 py-2 pr-10 text-sm text-[#00FF41] outline-none placeholder:text-[#008F11] focus:border-[#00FF41] focus:shadow-[0_0_8px_rgba(0,255,65,0.35)] disabled:opacity-50';
const labelClass = 'mb-1 block text-sm font-medium text-[#00FF41]/80';

export const PLATFORM_LABELS: Record<RepoPlatform, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  unknown: 'Repo',
};

export const PLATFORM_CHIP_CLASSES: Record<RepoPlatform, string> = {
  github: 'border-[#00FF41] text-[#00FF41]',
  gitlab: 'border-[#00FF41] text-[#00FF41]',
  bitbucket: 'border-[#2684FF] bg-[#001B4D]/40 text-[#5CA8FF]',
  unknown: 'border-[#008F11] text-[#00FF41]/70',
};

function RepoInfoCard({ info }: { info: RepoInfo }) {
  return (
    <div
      data-testid="repo-info-card"
      className="mt-2 space-y-1 border border-[#008F11]/40 bg-[#0D0208] p-2 text-xs text-[#00FF41]/80"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          data-testid="repo-platform"
          className={`border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${PLATFORM_CHIP_CLASSES[info.platform]}`}
        >
          {PLATFORM_LABELS[info.platform]}
        </span>
        <span className="text-[#00FF41]">{info.fullName}</span>
        {info.isPrivate && (
          <span className="border border-[#008F11] px-2 py-0.5 text-[10px] text-[#008F11]">
            private
          </span>
        )}
      </div>
      {info.description && (
        <p className="text-[#00FF41]/60">{info.description}</p>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[#00FF41]/60">
        {info.language && (
          <span data-testid="repo-language">{info.language}</span>
        )}
        <span data-testid="repo-stars">★ {info.stars}</span>
        <span data-testid="repo-branch">ветка: {info.defaultBranch}</span>
      </div>
    </div>
  );
}

export default function RepoUrlInput({
  value,
  onChange,
  error,
  disabled = false,
  id,
  label = 'Адрес',
  placeholder,
}: RepoUrlInputProps) {
  const autoId = useId();
  const inputId = id ?? `repo-url-${autoId}`;
  const messageId = `${inputId}-message`;

  const [state, setState] = useState<ValidationState>('idle');
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    setInfo(null);
    setMessage(null);

    const trimmed = value.trim();
    const normalized = normalizeRepoUrl(value);

    if (!trimmed || disabled) {
      setState('idle');
      return () => {
        cancelled = true;
      };
    }

    if (!normalized) {
      setState('invalid');
      setMessage('Invalid URL');
      return () => {
        cancelled = true;
      };
    }

    if (!isLikelyRepoUrl(value)) {
      setState('invalid-url');
      return () => {
        cancelled = true;
      };
    }

    setState('checking');
    const url = normalized;

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      validateRepos([url])
        .then((results) => {
          if (cancelled) return;
          const result = results.find((item) => item.url === url) ?? results[0];
          if (result?.valid && result.info) {
            setInfo(result.info);
            setMessage(null);
            setState('valid');
            onChange(trimmed, result.info);
          } else {
            setInfo(null);
            setMessage(result?.error ?? 'Репозиторий не найден');
            setState('invalid');
            onChange(trimmed, null);
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setInfo(null);
          setMessage(
            err instanceof Error
              ? err.message
              : 'Не удалось проверить репозиторий',
          );
          setState('invalid');
          onChange(trimmed, null);
        });
    }, REPO_URL_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, disabled]);

  return (
    <div data-testid="repo-url-input" data-state={state}>
      <label className={labelClass} htmlFor={inputId}>
        {label}
      </label>
      <div className="relative">
        <input
          id={inputId}
          data-testid="repo-url-field"
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
          data-testid="repo-url-status"
          data-state={state}
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm"
          aria-hidden="true"
        >
          {state === 'checking' && (
            <span
              data-testid="repo-url-spinner"
              className="block h-4 w-4 animate-spin rounded-full border-2 border-[#008F11] border-t-[#00FF41]"
            />
          )}
          {state === 'valid' && (
            <span data-testid="repo-url-valid" className="text-[#00FF41]">
              ✓
            </span>
          )}
          {state === 'invalid' && (
            <span data-testid="repo-url-invalid" className="text-[#FF0033]">
              ✕
            </span>
          )}
        </span>
      </div>

      {state === 'invalid-url' && (
        <p
          data-testid="repo-url-hint"
          className="mt-1 text-xs text-[#00FF41]/40"
        >
          Непохоже на URL репозитория
        </p>
      )}

      {(message || error) && (
        <p
          id={messageId}
          data-testid="repo-url-message"
          role="alert"
          className="mt-1 text-xs font-medium text-[#FF0033]"
        >
          {message ?? error}
        </p>
      )}

      {state === 'valid' && info && <RepoInfoCard info={info} />}
    </div>
  );
}