import { messageOf } from "../../lib/errors";
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { stopDevServers } from "../../api/client";
import type { LoadState } from "./types";
import { AsyncStateStatus } from '../../lib/async-state';

interface UseDevServersInput {
  issueId: string | null;
  setState: Dispatch<SetStateAction<LoadState>>;
}

export function useDevServers({ issueId, setState }: UseDevServersInput) {
  const [stoppingDevServers, setStoppingDevServers] = useState(false);
  const [devServerError, setDevServerError] = useState<string | null>(null);
  const [devPortCopied, setDevPortCopied] = useState(false);
  const devPortCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  useEffect(
    () => () => {
      if (devPortCopiedTimerRef.current) {
        clearTimeout(devPortCopiedTimerRef.current);
      }
    },
    [],
  );

  async function handleStopDevServers() {
    if (!issueId) return;
    setStoppingDevServers(true);
    setDevServerError(null);
    try {
      await stopDevServers(issueId);
      setState((current) =>
        current.status === AsyncStateStatus.ready
          ? {
              ...current,
              data: {
                ...current.data,
                issue: { ...current.data.issue, dev_server_port: null },
              },
            }
          : current,
      );
    } catch (error) {
      setDevServerError(messageOf(error));
    } finally {
      setStoppingDevServers(false);
    }
  }

  async function copyDevServerPort(port: number) {
    try {
      await navigator.clipboard?.writeText(String(port));
      setDevPortCopied(true);
      if (devPortCopiedTimerRef.current) {
        clearTimeout(devPortCopiedTimerRef.current);
      }
      devPortCopiedTimerRef.current = setTimeout(
        () => setDevPortCopied(false),
        1500,
      );
    } catch (error) {
      setDevPortCopied(false);
      setDevServerError(messageOf(error));
    }
  }

  return {
    stoppingDevServers,
    devServerError,
    devPortCopied,
    handleStopDevServers,
    copyDevServerPort,
  };
}