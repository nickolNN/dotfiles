import { useEffect, useRef, useState } from 'react';
import { cleanupOrphans, getHostname, setHostname } from '../api/client';
import type { CleanupResult } from '../api/client';

/** Поле ввода в теме — тот же стиль, что и в форме создания задачи (NewIssue). */
const FIELD_CLASS =
  'w-full rounded-none border border-[#008F11] bg-[#0D0208] px-3 py-2 text-sm text-[#00FF41] outline-none placeholder:text-[#008F11] focus:border-[#00FF41] focus:shadow-[0_0_8px_rgba(0,255,65,0.35)]';

/**
 * Страница настроек: единственное поле — hostname инстанса. Загружает текущее
 * значение из бэкенда, сохраняет по кнопке и на 2 секунды показывает «Сохранено».
 */
function CleanupButton() {
  const [cleaning, setCleaning] = useState(false);
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCleanup() {
    setCleaning(true);
    setError(null);
    setResult(null);
    try {
      const res = await cleanupOrphans();
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка очистки');
    } finally {
      setCleaning(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        data-testid="settings-cleanup"
        disabled={cleaning}
        className="rounded-none border border-[#FF3B3B]/60 px-4 py-2 text-sm font-medium text-[#FF3B3B] transition-colors hover:bg-[#FF3B3B]/10 disabled:opacity-50"
        onClick={() => void handleCleanup()}
      >
        Очистить орфанед-задачи
      </button>
      {cleaning && (
        <span className="block text-sm text-[#00FF41]/50">Очистка...</span>
      )}
      {result && (
        <span className="block text-sm text-[#00FF41]">
          Удалено папок: {result.deleted_dirs}, убито процессов:{' '}
          {result.killed_processes}
          {result.errors.length > 0 && (
            <span className="text-[#FF3B3B]">
              , ошибок: {result.errors.length}
            </span>
          )}
        </span>
      )}
      {error && (
        <span role="alert" className="block text-sm text-[#FF3B3B]">
          {error}
        </span>
      )}
    </div>
  );
}

export default function Settings() {
  const [hostname, setHostnameValue] = useState('');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedTimer = useRef<number | null>(null);

  // Забираем текущий hostname при открытии страницы.
  useEffect(() => {
    let cancelled = false;
    void getHostname().then((value) => {
      if (cancelled) return;
      setHostnameValue(value);
      setDraft(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Заголовок вкладки отражает hostname при загрузке и после сохранения.
  useEffect(() => {
    document.title = hostname || 'Issue Resolver';
  }, [hostname]);

  // Чистим таймер «Сохранено» при размонтировании.
  useEffect(
    () => () => {
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    },
    [],
  );

  async function handleSave() {
    const next = draft.trim();
    setSaving(true);
    setError(null);
    try {
      await setHostname(next);
      setHostnameValue(next);
      setDraft(next);
      setSaved(true);
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mx-auto max-w-4xl">
      <h1 className="mb-4 text-lg font-semibold">Настройки</h1>
      <form
        className="max-w-md space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSave();
        }}
      >
        <label className="block text-sm text-[#00FF41]/70" htmlFor="hostname">
          Hostname
        </label>
        <input
          id="hostname"
          data-testid="settings-hostname-input"
          type="text"
          value={draft}
          placeholder="hostname"
          spellCheck={false}
          className={FIELD_CLASS}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
        <div className="flex items-center gap-3">
          <button
            type="submit"
            data-testid="settings-save"
            disabled={saving}
            className="rounded-none border border-[#00FF41] px-4 py-2 text-sm font-medium text-[#00FF41] transition-colors hover:bg-[#00FF41]/10 disabled:opacity-50"
          >
            Сохранить
          </button>
          {saved && (
            <span
              data-testid="settings-saved"
              role="status"
              className="text-sm text-[#00FF41]"
            >
              Сохранено
            </span>
          )}
          {error && (
            <span
              data-testid="settings-error"
              role="alert"
              className="text-sm text-[#FF3B3B]"
            >
              {error}
            </span>
          )}
        </div>
      </form>

      <hr className="my-8 max-w-md border-[#008F11]/20" />

      <section className="max-w-md">
        <h2 className="mb-2 text-sm font-semibold">Обслуживание</h2>
        <p className="mb-3 text-xs text-[#00FF41]/50">
          Находит и удаляет папки задач, удалённых из базы, и убивает
          оставшиеся от них процессы (dev-серверы, агенты).
        </p>
        <CleanupButton />
      </section>
    </section>
  );
}