import type { ReactNode } from 'react';
import { labelClass, urlInputClass } from './formStyles';

export const UrlValidationState = Object.freeze({
  idle: 'idle',
  checking: 'checking',
  valid: 'valid',
  invalid: 'invalid',
  invalid_url: 'invalid-url',
} as const);
export type UrlValidationState =
  (typeof UrlValidationState)[keyof typeof UrlValidationState];

interface UrlInputProps {
  testIdPrefix: string;
  inputId: string;
  messageId: string;
  label: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  error?: string;
  state: UrlValidationState;
  message: string | null;
  hint: string;
  onChange: (value: string) => void;
  children?: ReactNode;
}

export default function UrlInput({
  testIdPrefix,
  inputId,
  messageId,
  label,
  value,
  placeholder,
  disabled = false,
  error,
  state,
  message,
  hint,
  onChange,
  children,
}: UrlInputProps) {
  return (
    <div data-testid={`${testIdPrefix}-input`} data-state={state}>
      <label className={labelClass} htmlFor={inputId}>
        {label}
      </label>
      <div className="relative">
        <input
          id={inputId}
          data-testid={`${testIdPrefix}-field`}
          className={urlInputClass}
          type="text"
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          aria-invalid={state === 'invalid' || Boolean(error)}
          aria-describedby={message || error ? messageId : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
        <span
          data-testid={`${testIdPrefix}-status`}
          data-state={state}
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm"
          aria-hidden="true"
        >
          {state === UrlValidationState.checking && (
            <span
              data-testid={`${testIdPrefix}-spinner`}
              className="block h-4 w-4 animate-spin rounded-full border-2 border-[#008F11] border-t-[#00FF41]"
            />
          )}
          {state === UrlValidationState.valid && (
            <span
              data-testid={`${testIdPrefix}-valid`}
              className="text-[#00FF41]"
            >
              ✓
            </span>
          )}
          {state === 'invalid' && (
            <span
              data-testid={`${testIdPrefix}-invalid`}
              className="text-[#FF0033]"
            >
              ✕
            </span>
          )}
        </span>
      </div>

      {state === 'invalid-url' && (
        <p
          data-testid={`${testIdPrefix}-hint`}
          className="mt-1 text-xs text-[#00FF41]/40"
        >
          {hint}
        </p>
      )}

      {(message || error) && (
        <p
          id={messageId}
          data-testid={`${testIdPrefix}-message`}
          role="alert"
          className="mt-1 text-xs font-medium text-[#FF0033]"
        >
          {message ?? error}
        </p>
      )}

      {state === UrlValidationState.valid && children}
    </div>
  );
}