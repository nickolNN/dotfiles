import { useEffect, useRef, useState } from "react";
import type { WorkspaceFile } from "@issue-resolver/shared";
import {
  getResultFiles,
  getResultMarkdown,
  probeResultArtifact,
} from "../../api/client";
import type { ArtifactMeta } from "./types";

interface UseResultArtifactsInput {
  issueId: string | null | undefined;
  refreshTick: number;
  resultReady: boolean;
  autoOpenResult: boolean | undefined;
  stateReady: boolean;
}

export function useResultArtifacts({
  issueId,
  refreshTick,
  resultReady,
  autoOpenResult,
  stateReady,
}: UseResultArtifactsInput) {
  const [resultOpen, setResultOpen] = useState(false);
  const [artifactMeta, setArtifactMeta] = useState<ArtifactMeta | null>(null);
  const [resultMd, setResultMd] = useState<string | null>(null);
  const [resultFiles, setResultFiles] = useState<WorkspaceFile[]>([]);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const autoOpenedRef = useRef(false);

  useEffect(() => {
    if (!autoOpenResult || !stateReady || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    setResultOpen(true);
  }, [autoOpenResult, stateReady]);

  useEffect(() => {
    if (!resultOpen || !issueId) {
      setArtifactMeta(null);
      return;
    }
    let cancelled = false;
    probeResultArtifact(issueId)
      .then((meta) => {
        if (cancelled) return;
        setArtifactMeta(meta);
      })
      .catch(() => {
        if (!cancelled) setArtifactMeta(null);
      });
    return () => {
      cancelled = true;
    };
  }, [resultOpen, issueId, refreshTick]);

  useEffect(() => {
    if (!issueId || !artifactMeta) return;
    const isHtml = artifactMeta.contentType.includes("text/html");
    if (artifactMeta.status !== 200 || isHtml) {
      setResultMd(null);
      return;
    }
    let cancelled = false;
    getResultMarkdown(issueId)
      .then((text) => {
        if (!cancelled) setResultMd(text);
      })
      .catch(() => {
        if (!cancelled) setResultMd(null);
      });
    return () => {
      cancelled = true;
    };
  }, [artifactMeta, issueId]);

  useEffect(() => {
    if (!issueId || !resultReady) {
      setResultFiles([]);
      return;
    }
    let cancelled = false;
    getResultFiles(issueId)
      .then((list) => {
        if (!cancelled) setResultFiles(list);
      })
      .catch(() => {
        if (!cancelled) setResultFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [issueId, resultReady, refreshTick]);

  return {
    resultOpen,
    setResultOpen,
    artifactMeta,
    resultMd,
    resultFiles,
    artifactsOpen,
    setArtifactsOpen,
    openResult: () => setResultOpen(true),
  };
}