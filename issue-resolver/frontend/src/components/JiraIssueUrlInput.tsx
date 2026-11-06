import { useId } from 'react';
import type { JiraIssueInfo } from '@issue-resolver/shared';
import { extractIssueKeyFromUrl } from '@issue-resolver/shared';
import { validateJiraUrl } from '../api/client';
import UrlInput, { UrlValidationState } from './UrlInput';
import useUrlValidation from './useUrlValidation';

const JIRA_URL_DEBOUNCE_MS = 600;

interface JiraIssueUrlInputProps {
  value: string;
  onChange: (url: string, issue: JiraIssueInfo | null) => void;
  error?: string;
  disabled?: boolean;
  id?: string;
  label?: string;
  placeholder?: string;
}


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

  const { state, message, data: issue } = useUrlValidation<JiraIssueInfo>({
    value,
    disabled,
    delayMs: JIRA_URL_DEBOUNCE_MS,
    inspect: (raw) => {
      const trimmed = raw.trim();
      try {
        const url = new URL(trimmed).toString();
        return extractIssueKeyFromUrl(trimmed)
          ? { url }
          : { state: UrlValidationState.invalid_url };
      } catch {
        return { state: UrlValidationState.invalid_url };
      }
    },
    validate: async (url) => {
      const result = await validateJiraUrl(url);
      return result.valid && result.issue
        ? { data: result.issue }
        : { data: null, error: result.error };
    },
    onChange,
    invalidMessage: 'Jira-задача не найдена',
    errorMessage: 'Не удалось проверить Jira-задачу',
  });

  return (
    <UrlInput
      testIdPrefix="jira-url"
      inputId={inputId}
      messageId={messageId}
      label={label}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      error={error}
      state={state}
      message={message}
      hint="Непохоже на ссылку Jira-задачи"
      onChange={(next) => onChange(next, null)}
    >
      {issue && <JiraIssueCard issue={issue} />}
    </UrlInput>
  );
}
