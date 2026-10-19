import { useEffect, useRef, useState } from 'react';
import {
  useCleanupOrphans,
  useHostname,
  useSetHostname,
} from '../stores/queries';
import type { CleanupResult } from '../api/client';
import QueryBoundary from '../components/QueryBoundary';

/** Поле ввода в теме — тот же стиль, что и в форме создания задачи (NewIssue). */
const FIELD_CLASS =
  'w-full rounded-none border border-[#008F11] bg-[#0D0208] px-3 py-2 text-sm text-[#00FF41] outline-none placeholder:text-[#008F11] focus:border-[#00FF41] focus:shadow-[0_0_8px_rgba(0,255,65,0.35)]';

function CleanupButton() {
  const cleanupMutation = useCleanupOrphans();
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cleaning = cleanupMutation.isPending;

  function handleCleanup() {
    setError(null);
    setResult(null);
    cleanupMutation.mutate(undefined, {
      onSuccess: (res) => setResult(res),
      onError: (err) =>
        setError(err instanceof Error ? err.message : 'Ошибка очистки'),
    });
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        data-testid="settings-cleanup"
        disabled={cleaning}
        className="rounded-none border border-[#FF3B3B]/60 px-4 py-2 text-sm font-medium text-[#FF3B3B] transition-colors hover:bg-[#FF3B3B]/10 disabled:opacity-50"
        onClick={handleCleanup}
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

interface SettingsProps {
  /** Текущий hostname инстанса; App грузит его при старте и держит в состоянии. */
  hostname: string;
  /** Сообщает App новый hostname — он же обновляет заголовок вкладки. */
  onHostnameChange: (value: string) => void;
}

/**
 * Страница настроек: единственное поле — hostname инстанса. Значение приходит
 * из App (оно же задаёт заголовок вкладки); сохраняем по кнопке и на 2 секунды
 * показываем «Сохранено».
 */
export default function Settings(props: SettingsProps) {
  return (
    <QueryBoundary>
      <SettingsView {...props} />
    </QueryBoundary>
  );
}

function SettingsView({ hostname, onHostnameChange }: SettingsProps) {
  const { data } = useHostname();
  const currentHostname = data ?? hostname;
  const saveMutation = useSetHostname();

  const [draft, setDraft] = useState(currentHostname);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedTimer = useRef<number | null>(null);

  const saving = saveMutation.isPending;

  // App подтягивает hostname асинхронно: если значение пришло уже после
  // монтирования страницы (в т.ч. при перезагрузке сразу на /settings) —
  // отражаем его в поле.
  useEffect(() => {
    setDraft(currentHostname);
  }, [currentHostname]);

  // Чистим таймер «Сохранено» при размонтировании.
  useEffect(
    () => () => {
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    },
    [],
  );

  function handleSave() {
    const next = draft.trim();
    setError(null);
    saveMutation.mutate(next, {
      onSuccess: () => {
        onHostnameChange(next);
        setDraft(next);
        setSaved(true);
        if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
        savedTimer.current = window.setTimeout(() => setSaved(false), 2000);
      },
      onError: (err) =>
        setError(err instanceof Error ? err.message : 'Не удалось сохранить'),
    });
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