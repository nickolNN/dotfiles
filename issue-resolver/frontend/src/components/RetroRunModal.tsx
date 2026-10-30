import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ModelDescriptor,
  RetroRun,
  RetroRunWithLog,
  ThinkingLevel,
} from '@issue-resolver/shared';
import {
  abortRetroRun,
  getModels,
  getRetroRun,
  getRetroRuns,
  startRetroRun,
} from '../api/client';
import { subscribeToGlobalStream } from '../api/sse';
import AgentMarkdown from './AgentMarkdown';
import ModelThinkingSelect, {
  thinkingLevelsFor,
} from './ModelThinkingSelect';

const FIELD_CLASS =
  'w-full rounded-none border border-[#008F11] bg-[#0D0208] px-3 py-2 text-sm text-[#00FF41] outline-none placeholder:text-[#008F11] focus:border-[#00FF41] focus:shadow-[0_0_8px_rgba(0,255,65,0.35)]';

const STATUS_LABEL: Record<RetroRun['status'], string> = {
  running: 'идёт',
  success: 'готово',
  failed: 'ошибка',
};

const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['running']);

function statusColor(status: RetroRun['status']): string {
  if (status === 'failed') return 'text-[#FF3B3B]';
  if (status === 'running') return 'text-[#FFB000]';
  return 'text-[#00FF41]';
}

function formatStamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('ru-RU');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withLog(run: RetroRun): RetroRunWithLog {
  return { ...run, stdout: '', stderr: '', events: [], stats: null };
}

export interface RetroRunModalProps {
  open: boolean;
  onClose: () => void;
}

export default function RetroRunModal({ open, onClose }: RetroRunModalProps) {
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [model, setModel] = useState('');
  const [thinking, setThinking] = useState('');
  const [sessionLimit, setSessionLimit] = useState('10');
  const [instructions, setInstructions] = useState('');
  const [run, setRun] = useState<RetroRunWithLog | null>(null);
  const [history, setHistory] = useState<RetroRun[]>([]);
  const [log, setLog] = useState('');
  const [starting, setStarting] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await getRetroRuns());
    } catch {
      // история не критична для запуска
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void getModels()
      .then((list) => {
        if (!cancelled) setModels(list);
      })
      .catch(() => undefined);
    void refreshHistory();
    return () => {
      cancelled = true;
    };
  }, [open, refreshHistory]);

  const runId = run?.id;
  const running = run?.status === 'running';

  useEffect(() => {
    if (!open || !runId || !running) return;
    const unsubscribe = subscribeToGlobalStream({
      onLog: (event) => {
        if (event.stepRunId !== runId) return;
        setLog((previous) => previous + event.data);
      },
      onStepStatus: (event) => {
        if (event.stepRunId !== runId) return;
        let next: unknown;
        try {
          next = (JSON.parse(event.data) as { status?: unknown }).status;
        } catch {
          return;
        }
        if (next !== 'success' && next !== 'failed') return;
        void getRetroRun(runId)
          .then((loaded) => {
            setRun(loaded);
            setLog(loaded.stdout + loaded.stderr);
          })
          .catch((err: unknown) => setError(messageOf(err)));
        void refreshHistory();
      },
    });
    return unsubscribe;
  }, [open, runId, running, refreshHistory]);

  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [log]);

  async function handleStart() {
    setStarting(true);
    setError(null);
    setLog('');
    setRun(null);
    const limit = Number.parseInt(sessionLimit, 10);
    try {
      const created = await startRetroRun({
        ...(model ? { model } : {}),
        ...(thinking ? { thinking_level: thinking as ThinkingLevel } : {}),
        ...(Number.isFinite(limit) ? { session_limit: limit } : {}),
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      });
      setRun(withLog(created));
      setHistory((previous) => [created, ...previous]);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setStarting(false);
    }
  }

  async function handleOpenRun(id: string) {
    setError(null);
    try {
      const loaded = await getRetroRun(id);
      setRun(loaded);
      setLog(loaded.stdout + loaded.stderr);
      setModel(loaded.model ?? '');
      setThinking(loaded.thinking_level ?? '');
      setSessionLimit(
        loaded.session_limit ? String(loaded.session_limit) : '',
      );
      setInstructions(loaded.instructions ?? '');
    } catch (err) {
      setError(messageOf(err));
    }
  }

  async function handleAbort() {
    if (!run) return;
    setAborting(true);
    setError(null);
    try {
      await abortRetroRun(run.id);
      const loaded = await getRetroRun(run.id);
      setRun(loaded);
      if (loaded.status !== 'running') setLog(loaded.stdout + loaded.stderr);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setAborting(false);
    }
  }

  function handleDownload() {
    if (!run?.report) return;
    const blob = new Blob([run.report], {
      type: 'text/markdown;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `retro-${run.id.slice(0, 8)}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Память и ретро"
      data-testid="retro-modal"
    >
      <div className="my-4 w-full max-w-3xl space-y-4 border border-[#008F11] bg-[#0D0208] p-4 text-[#00FF41]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">Память и ретро</h2>
            <p className="mt-1 text-xs text-[#00FF41]/50">
              Сессия компактит память агента и проводит ретро по скиллу retro.
              Итог — markdown-отчёт, который можно отдать агенту для правок
              пайплайна.
            </p>
          </div>
          <button
            type="button"
            data-testid="retro-close"
            className="border border-[#008F11]/60 px-2 py-1 text-xs text-[#00FF41]/70 hover:bg-[#008F11]/10"
            onClick={onClose}
          >
            Закрыть
          </button>
        </div>

        <div className="space-y-3">
          <ModelThinkingSelect
            models={models}
            thinkingLevels={thinkingLevelsFor(
              models.find((item) => item.id === model),
            )}
            modelValue={model}
            thinkingValue={thinking}
            disabled={starting || running}
            thinkingDisabled={!model}
            modelLabel="Модель"
            thinkingLabel="Thinking effort"
            labelClassName="text-xs text-[#00FF41]/70"
            modelTestId="retro-model"
            thinkingTestId="retro-thinking"
            modelAriaLabel="Модель ретро-агента"
            thinkingAriaLabel="Thinking effort ретро-агента"
            modelSelectClassName={`${FIELD_CLASS} sm:w-64`}
            thinkingSelectClassName={`${FIELD_CLASS} sm:w-48`}
            onModelChange={(value) => {
              setModel(value);
              setThinking('');
            }}
            onThinkingChange={setThinking}
          />
          <label className="block text-xs text-[#00FF41]/70">
            Сессий для анализа
            <input
              data-testid="retro-sessions"
              type="number"
              min={1}
              max={50}
              className={`${FIELD_CLASS} mt-1 w-full sm:w-40`}
              value={sessionLimit}
              onChange={(event) => setSessionLimit(event.currentTarget.value)}
            />
          </label>
        </div>

        <label className="block text-xs text-[#00FF41]/70">
          Что ещё учесть
          <textarea
            data-testid="retro-instructions"
            rows={3}
            placeholder="например: посмотри, почему ревью пропускало ошибки в миграциях"
            className={`${FIELD_CLASS} mt-1`}
            value={instructions}
            onChange={(event) => setInstructions(event.currentTarget.value)}
          />
        </label>

        <div className="flex items-center gap-3">
          <button
            type="button"
            data-testid="retro-start"
            disabled={starting || running}
            className="rounded-none border border-[#00FF41] px-4 py-2 text-sm font-medium text-[#00FF41] transition-colors hover:bg-[#00FF41]/10 disabled:opacity-50"
            onClick={() => void handleStart()}
          >
            Запустить
          </button>
          {starting && (
            <span className="text-xs text-[#00FF41]/50">Запуск...</span>
          )}
          {running && (
            <button
              type="button"
              data-testid="retro-abort"
              disabled={aborting}
              className="rounded-none border border-[#FFB000] px-4 py-2 text-sm font-medium text-[#FFB000] transition-colors hover:bg-[#FFB000]/10 disabled:opacity-50"
              onClick={() => void handleAbort()}
            >
              {aborting ? 'Останавливаю...' : 'Остановить'}
            </button>
          )}
          {run && (
            <span
              data-testid="retro-status"
              className={`text-xs ${statusColor(run.status)}`}
            >
              {STATUS_LABEL[run.status]} ·{' '}
              {formatStamp(run.updated_at)}
            </span>
          )}
        </div>

        {run && (
          <p
            data-testid="retro-run-params"
            className="text-[11px] text-[#00FF41]/40"
          >
            {run.model ?? 'модель по умолчанию'}
            {run.thinking_level ? ` · ${run.thinking_level}` : ''}
            {' · '}
            {run.session_limit
              ? `${run.session_limit} сессий`
              : 'лимит по умолчанию'}
            {run.instructions ? ' · свои инструкции' : ''}
          </p>
        )}

        {error && (
          <p role="alert" data-testid="retro-error" className="text-sm text-[#FF3B3B]">
            {error}
          </p>
        )}

        {run?.error && (
          <p data-testid="retro-run-error" className="text-sm text-[#FF3B3B]">
            {run.error}
          </p>
        )}

        {log && (
          <pre
            ref={logRef}
            data-testid="retro-log"
            className="max-h-48 overflow-auto whitespace-pre-wrap border border-[#008F11]/40 bg-black/40 p-2 text-xs text-[#00FF41]/80"
          >
            {log}
          </pre>
        )}

        {run?.report && (
          <section data-testid="retro-report" className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">Отчёт</h3>
              <button
                type="button"
                data-testid="retro-download"
                className="border border-[#008F11]/60 px-2 py-1 text-xs text-[#00FF41]/80 hover:bg-[#008F11]/10"
                onClick={handleDownload}
              >
                Скачать .md
              </button>
            </div>
            <div className="max-h-96 overflow-auto border border-[#008F11]/40 p-2">
              <AgentMarkdown>{run.report}</AgentMarkdown>
            </div>
          </section>
        )}

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">История</h3>
          {history.length === 0 ? (
            <p className="text-xs text-[#00FF41]/50">Прогонов ещё не было</p>
          ) : (
            <ul data-testid="retro-history" className="space-y-1">
              {history.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 border border-[#008F11]/30 px-2 py-1 text-left text-xs hover:bg-[#008F11]/10"
                    onClick={() => void handleOpenRun(item.id)}
                  >
                    <span className={statusColor(item.status)}>
                      {STATUS_LABEL[item.status]}
                    </span>
                    <span className="text-[#00FF41]/60">
                      {formatStamp(item.created_at)}
                    </span>
                    <span className="text-[#00FF41]/40">
                      {item.model ?? 'по умолчанию'}
                    </span>
                    {item.session_limit && (
                      <span className="text-[#00FF41]/40">
                        {item.session_limit} сессий
                      </span>
                    )}
                    {item.thinking_level && (
                      <span className="text-[#00FF41]/40">
                        {item.thinking_level}
                      </span>
                    )}
                    {!ACTIVE_STATUSES.has(item.status) && item.report && (
                      <span className="text-[#00FF41]/40">md</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}