import { useId } from 'react';
import type { RepoInfo } from '@issue-resolver/shared';
import { validateRepos } from '../api/client';
import PlatformChip from './PlatformChip';
import UrlInput, { UrlValidationState } from './UrlInput';
import useUrlValidation from './useUrlValidation';

const REPO_URL_DEBOUNCE_MS = 600;

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const SSH_URL = /^[^@/]+@([^:/]+)[:/](.+)$/;

export function normalizeRepoUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/\s/.test(trimmed)) return null;

  const sshMatch = SSH_URL.exec(trimmed);
  let candidate = trimmed;
  if (sshMatch) {
    candidate = `https://${sshMatch[1].toLowerCase()}/${sshMatch[2].replace(/^\/+/, '')}`;
  } else if (!URL_SCHEME.test(trimmed)) {
    candidate = `https://${trimmed}`;
  }

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

interface RepoUrlInputProps {
  value: string;
  onChange: (url: string, info?: RepoInfo | null) => void;
  error?: string;
  disabled?: boolean;
  id?: string;
  label?: string;
  placeholder?: string;
}

function RepoInfoCard({ info }: { info: RepoInfo }) {
  return (
    <div
      data-testid="repo-info-card"
      className="mt-2 space-y-1 border border-[#008F11]/40 bg-[#0D0208] p-2 text-xs text-[#00FF41]/80"
    >
      <div className="flex flex-wrap items-center gap-2">
        <PlatformChip platform={info.platform} />
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
        {info.branches.length > 0 ? (
          <span data-testid="repo-branch">ветка: {info.defaultBranch}</span>
        ) : (
          <span data-testid="repo-empty">
            нет веток — пустой репозиторий
          </span>
        )}
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

  const { state, message, data: info } = useUrlValidation<RepoInfo>({
    value,
    disabled,
    delayMs: REPO_URL_DEBOUNCE_MS,
    inspect: (raw) => {
      const normalized = normalizeRepoUrl(raw);
      if (!normalized) return { state: UrlValidationState.invalid, message: 'Invalid URL' };
      if (!isLikelyRepoUrl(raw)) return { state: UrlValidationState.invalid_url };
      return { url: normalized };
    },
    validate: async (url) => {
      const results = await validateRepos([url]);
      const result = results.find((item) => item.url === url) ?? results[0];
      return result?.valid && result.info
        ? { data: result.info }
        : { data: null, error: result?.error };
    },
    onChange,
    invalidMessage: 'Репозиторий не найден',
    errorMessage: 'Не удалось проверить репозиторий',
  });

  return (
    <UrlInput
      testIdPrefix="repo-url"
      inputId={inputId}
      messageId={messageId}
      label={label}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      error={error}
      state={state}
      message={message}
      hint="Непохоже на URL репозитория"
      onChange={(next) => onChange(next, null)}
    >
      {info && <RepoInfoCard info={info} />}
    </UrlInput>
  );
}
