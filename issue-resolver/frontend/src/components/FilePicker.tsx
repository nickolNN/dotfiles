import type { ChangeEvent } from 'react';

/** Человекочитаемый размер файла (Б/КБ/МБ). */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} Б`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} КБ`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} МБ`;
}

export interface FilePickerProps {
  id?: string;
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
  label?: string;
}

const labelClass = 'block text-sm font-medium text-[#00FF41]/80';

/**
 * Выбор файлов перед созданием задачи/итерации: множественный `<input
 * type="file">` плюс чипы с именем/размером и кнопкой удаления. Только UI —
 * что делать с `File[]`, решает вызывающий (multipart при непустом списке).
 */
export default function FilePicker({
  id,
  files,
  onChange,
  disabled = false,
  label = 'Файлы',
}: FilePickerProps) {
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files;
    if (selected && selected.length > 0) {
      onChange([...files, ...Array.from(selected)]);
    }
    // Сбрасываем value, чтобы повторный выбор того же файла снова триггерил
    // change (иначе input считает набор неизменным).
    event.target.value = '';
  }

  function removeAt(index: number) {
    onChange(files.filter((_, i) => i !== index));
  }

  return (
    <div data-testid="file-picker">
      <div className="mb-1 flex items-center justify-between">
        <label className={labelClass} htmlFor={id}>
          {label}
        </label>
        {files.length > 0 && (
          <span className="text-xs text-[#00FF41]/40">{files.length}</span>
        )}
      </div>
      <input
        id={id}
        type="file"
        multiple
        disabled={disabled}
        onChange={handleChange}
        className="block w-full text-sm text-[#00FF41]/70 file:mr-3 file:min-h-9 file:cursor-pointer file:rounded-none file:border file:border-[#008F11] file:bg-[#003B00] file:px-3 file:text-sm file:text-[#00FF41] hover:file:border-[#00FF41] disabled:opacity-40"
      />
      {files.length > 0 && (
        <ul className="mt-2 space-y-1">
          {files.map((file, index) => (
            <li
              key={`${file.name}-${file.size}-${index}`}
              data-testid="file-chip"
              className="flex items-center gap-2 border border-[#008F11]/40 px-2 py-1 text-xs"
            >
              <span className="min-w-0 flex-1 truncate text-[#00FF41]/80">
                {file.name}
              </span>
              <span className="shrink-0 text-[#00FF41]/50">
                {formatFileSize(file.size)}
              </span>
              <button
                type="button"
                aria-label={`Убрать ${file.name}`}
                disabled={disabled}
                onClick={() => removeAt(index)}
                className="shrink-0 px-1 text-[#008F11] hover:text-[#FF0033] disabled:opacity-40"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}