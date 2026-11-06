import { messageOf } from "../../lib/errors";
import { useEffect, useState } from "react";
import type { IssueFile } from "@issue-resolver/shared";
import { deleteIssueFile, getIssueFiles } from "../../api/client";
import { filterArtifacts } from "./format";

export function useIssueFiles(
  issueId: string | null | undefined,
  refreshTick: number,
) {
  const [issueFiles, setIssueFiles] = useState<IssueFile[]>([]);
  const [deletingFileId, setDeletingFileId] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    if (!issueId) return;
    let cancelled = false;
    getIssueFiles(issueId)
      .then((list) => {
        if (!cancelled) setIssueFiles(filterArtifacts(list));
      })
      .catch(() => {
        if (!cancelled) setIssueFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [issueId, refreshTick]);

  async function handleDeleteFile(fileId: string) {
    setDeletingFileId(fileId);
    try {
      await deleteIssueFile(fileId);
      setIssueFiles((current) => current.filter((file) => file.id !== fileId));
    } catch (error) {
      setFileError(messageOf(error));
    } finally {
      setDeletingFileId(null);
    }
  }

  return {
    issueFiles,
    setIssueFiles,
    deletingFileId,
    fileError,
    setFileError,
    handleDeleteFile,
  };
}