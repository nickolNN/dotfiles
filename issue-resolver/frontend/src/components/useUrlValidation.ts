import { useEffect, useRef, useState } from 'react';
import { messageOf } from '../lib/errors';
import { UrlValidationState } from './UrlInput';

type LocalState = Extract<UrlValidationState, 'invalid' | 'invalid-url'>;

export type UrlInspection =
  | { url: string }
  | { state: LocalState; message?: string | null };

export interface UrlValidationResult<T> {
  data: T | null;
  error?: string;
}

interface UseUrlValidationOptions<T> {
  value: string;
  disabled: boolean;
  delayMs: number;
  inspect: (value: string) => UrlInspection;
  validate: (url: string) => Promise<UrlValidationResult<T>>;
  onChange: (value: string, data: T | null) => void;
  invalidMessage: string;
  errorMessage: string;
}

interface ValidationState<T> {
  state: UrlValidationState;
  message: string | null;
  data: T | null;
}

export default function useUrlValidation<T>({
  value,
  disabled,
  delayMs,
  inspect,
  validate,
  onChange,
  invalidMessage,
  errorMessage,
}: UseUrlValidationOptions<T>): ValidationState<T> {
  const [state, setState] = useState<UrlValidationState>(UrlValidationState.idle);
  const [message, setMessage] = useState<string | null>(null);
  const [data, setData] = useState<T | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const latest = useRef({ inspect, validate, onChange, invalidMessage, errorMessage });
  useEffect(() => {
    latest.current = { inspect, validate, onChange, invalidMessage, errorMessage };
  });

  useEffect(() => {
    let cancelled = false;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    setData(null);
    setMessage(null);

    const trimmed = value.trim();
    if (!trimmed || disabled) {
      setState(UrlValidationState.idle);
      return () => {
        cancelled = true;
      };
    }

    const inspection = latest.current.inspect(value);
    if ('state' in inspection) {
      setState(inspection.state);
      setMessage(inspection.message ?? null);
      return () => {
        cancelled = true;
      };
    }

    setState(UrlValidationState.checking);
    const url = inspection.url;

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      latest.current
        .validate(url)
        .then((result) => {
          if (cancelled) return;
          if (result.data !== null) {
            setData(result.data);
            setMessage(null);
            setState(UrlValidationState.valid);
            latest.current.onChange(trimmed, result.data);
          } else {
            setData(null);
            setMessage(result.error ?? latest.current.invalidMessage);
            setState(UrlValidationState.invalid);
            latest.current.onChange(trimmed, null);
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setData(null);
          setMessage(messageOf(err, latest.current.errorMessage));
          setState(UrlValidationState.invalid);
          latest.current.onChange(trimmed, null);
        });
    }, delayMs);

    return () => {
      cancelled = true;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [value, disabled, delayMs]);

  return { state, message, data };
}
