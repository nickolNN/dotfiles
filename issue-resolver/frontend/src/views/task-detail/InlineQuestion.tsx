import { useEffect, useRef, useState } from "react";
import FormError from "../../components/FormError";
import { inputClass } from "./constants";
import type { QuestionEvent } from "./types";

export default function InlineQuestion({
  question,
  submitting,
  error,
  onSubmit,
  onCancel,
}: {
  question: QuestionEvent;
  submitting: boolean;
  error: string | null;
  onSubmit: (payload: { value?: string; confirmed?: boolean }) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(
    question.prefill ?? question.options?.[0] ?? "",
  );
  const isConfirm = question.method === "confirm";
  const submitLabel = question.method === "editor" ? "Отправить" : "Ответить";

  const inputRef = useRef<HTMLInputElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (submitting) return;
    const field = inputRef.current ?? editorRef.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, []);

  return (
    <div
      data-testid="inline-question"
      className="border border-[#FFB000] bg-[#1A1000] p-3"
    >
      <header className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-[#FFB000]">
          Агент спрашивает
        </span>
        <button
          type="button"
          data-testid="question-close"
          aria-label="Закрыть"
          disabled={submitting}
          onClick={onCancel}
          className="text-[#FFB000]/50 hover:text-[#FFB000] disabled:opacity-50 transition-base"
        >
          ✕
        </button>
      </header>

      <p className="break-words text-sm text-[#FFB000]">{question.title}</p>
      {question.message && (
        <p className="mt-1 whitespace-pre-wrap break-words text-xs text-[#FFB000]/70">
          {question.message}
        </p>
      )}

      {question.method === "select" && (
        <fieldset
          className="mt-3 space-y-2"
          disabled={submitting}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (!submitting && value.trim() !== "") onSubmit({ value });
            }
          }}
        >
          {(question.options ?? []).map((option) => (
            <label
              key={option}
              className="flex cursor-pointer items-center gap-2 text-sm text-[#00FF41]/80"
            >
              <input
                type="radio"
                name={`question-${question.id}`}
                className="accent-[#00FF41]"
                value={option}
                autoFocus={value === option}
                checked={value === option}
                onChange={() => setValue(option)}
                disabled={submitting}
              />
              {option}
            </label>
          ))}
        </fieldset>
      )}

      {question.method === "input" && (
        <input
          ref={inputRef}
          type="text"
          aria-label="Ответ"
          className={`${inputClass} mt-3`}
          value={value}
          placeholder={question.placeholder ?? ""}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.altKey
            ) {
              event.preventDefault();
              if (!submitting && value.trim() !== "") onSubmit({ value });
            }
          }}
          disabled={submitting}
        />
      )}

      {question.method === "editor" && (
        <textarea
          ref={editorRef}
          aria-label="Ответ"
          className={`${inputClass} mt-3`}
          rows={5}
          value={value}
          placeholder={question.placeholder ?? ""}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault();
              if (!submitting && value.trim() !== "") onSubmit({ value });
            }
          }}
          disabled={submitting}
        />
      )}

      <FormError
        message={error}
        className="mt-2 text-xs font-medium text-[#FF0033]"
      />

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {isConfirm && (
          <>
            <button
              type="button"
              disabled={submitting}
              onClick={() => onSubmit({ confirmed: false })}
              className="min-h-9 rounded-none border border-[#FF0033] px-4 py-1 text-sm font-medium text-[#FF0033] hover:bg-[#FF0033] hover:text-[#0D0208] disabled:opacity-50 transition-base"
            >
              Нет
            </button>
            <button
              type="button"
              disabled={submitting}
              autoFocus
              onClick={() => onSubmit({ confirmed: true })}
              className="min-h-9 rounded-none border border-[#00FF41] bg-[#003B00] px-4 py-1 text-sm font-medium text-[#00FF41] hover:bg-[#00FF41] hover:text-[#0D0208] disabled:opacity-50 transition-base"
            >
              Да
            </button>
          </>
        )}

        {!isConfirm && (
          <button
            type="button"
            disabled={submitting || value.trim() === ""}
            onClick={() => onSubmit({ value })}
            className="min-h-9 rounded-none border border-[#00FF41] bg-[#003B00] px-4 py-1 text-sm font-medium text-[#00FF41] hover:bg-[#00FF41] hover:text-[#0D0208] disabled:opacity-50 transition-base"
          >
            {submitting ? "Отправка…" : submitLabel}
          </button>
        )}

        <button
          type="button"
          data-testid="question-cancel"
          disabled={submitting}
          onClick={onCancel}
          className="min-h-9 rounded-none border border-[#008F11] px-4 py-1 text-sm font-medium text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41] disabled:opacity-50 transition-base"
        >
          Отмена
        </button>
      </div>
    </div>
  );
}
