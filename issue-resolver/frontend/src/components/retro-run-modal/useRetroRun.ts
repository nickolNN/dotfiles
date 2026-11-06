import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RetroRunStatus,
  StepRunStatus,
  type ModelDescriptor,
  type RetroRun,
  type RetroRunWithLog,
  type ThinkingLevel,
} from '@issue-resolver/shared';
import { isThinkingLevel } from '../../constants/thinking-levels';
import {
  abortRetroRun,
  getModels,
  getRetroRun,
  getRetroRuns,
  startRetroRun,
} from '../../api/client';
import { subscribeToGlobalStream } from '../../api/sse';
import { parseStepStatusPayload } from '../../api/sse';
import { messageOf } from '../../lib/errors';
import { withLog } from './format';

export function useRetroRun(open: boolean) {
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
    const runs = await getRetroRuns().catch(() => null);
    if (runs !== null) setHistory(runs);
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
  const running = run?.status === RetroRunStatus.running;

  useEffect(() => {
    if (!open || !runId || !running) return;
    const unsubscribe = subscribeToGlobalStream({
      onLog: (event) => {
        if (event.stepRunId !== runId) return;
        setLog((previous) => previous + event.data);
      },
      onStepStatus: (event) => {
        if (event.stepRunId !== runId) return;
        const status = parseStepStatusPayload(event.data);
        if (
          status !== StepRunStatus.success &&
          status !== StepRunStatus.failed
        ) {
          return;
        }
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
        ...(isThinkingLevel(thinking) ? { thinking_level: thinking } : {}),
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
      setSessionLimit(loaded.session_limit ? String(loaded.session_limit) : '');
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
      if (loaded.status !== RetroRunStatus.running) {
        setLog(loaded.stdout + loaded.stderr);
      }
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

  function changeModel(value: string) {
    setModel(value);
    setThinking('');
  }

  return {
    models,
    model,
    thinking,
    sessionLimit,
    instructions,
    run,
    history,
    log,
    logRef,
    starting,
    aborting,
    error,
    running,
    setSessionLimit,
    setInstructions,
    setThinking,
    changeModel,
    handleStart,
    handleOpenRun,
    handleAbort,
    handleDownload,
  };
}

export type RetroRunState = ReturnType<typeof useRetroRun>;