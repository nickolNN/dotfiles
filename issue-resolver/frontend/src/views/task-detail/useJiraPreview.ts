import { useState } from "react";
import { getJiraPreview } from "../../api/client";

interface UseJiraPreviewInput {
  issueId: string | null;
  jiraUrl: string | null | undefined;
}

export function useJiraPreview({ issueId, jiraUrl }: UseJiraPreviewInput) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function openJiraPreview() {
    setOpen(true);
    setText(null);
    if (!issueId || !jiraUrl) return;
    setLoading(true);
    try {
      setText(await getJiraPreview(issueId));
    } catch {
      setText(null);
    } finally {
      setLoading(false);
    }
  }

  function closeJiraPreview() {
    setOpen(false);
  }

  return {
    jiraPreviewOpen: open,
    jiraPreviewText: text,
    jiraPreviewLoading: loading,
    openJiraPreview,
    closeJiraPreview,
  };
}