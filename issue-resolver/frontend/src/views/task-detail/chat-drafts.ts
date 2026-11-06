import { useCallback, useState } from "react";
import type { SendMode } from "./types";

interface ChatDraft {
  text: string;
  sendMode: SendMode;
}

const EMPTY_DRAFT: ChatDraft = { text: "", sendMode: "steer" };

const drafts = new Map<string, ChatDraft>();

function readDraft(sessionId: string): ChatDraft {
  return drafts.get(sessionId) ?? EMPTY_DRAFT;
}

type TextUpdate = string | ((current: string) => string);

export interface ChatDraftApi {
  text: string;
  sendMode: SendMode;
  setText: (value: TextUpdate) => void;
  setSendMode: (value: SendMode) => void;
}

export function useChatDraft(sessionId: string): ChatDraftApi {
  const [draft, setDraft] = useState<ChatDraft>(() => readDraft(sessionId));
  const [currentId, setCurrentId] = useState(sessionId);

  if (currentId !== sessionId) {
    setCurrentId(sessionId);
    setDraft(readDraft(sessionId));
  }

  const write = useCallback(
    (update: Partial<ChatDraft>) => {
      setDraft((previous) => {
        const next = { ...previous, ...update };
        drafts.set(sessionId, next);
        return next;
      });
    },
    [sessionId],
  );

  const setText = useCallback(
    (value: TextUpdate) => {
      write({
        text: typeof value === "function" ? value(readDraft(sessionId).text) : value,
      });
    },
    [sessionId, write],
  );

  const setSendMode = useCallback(
    (value: SendMode) => {
      write({ sendMode: value });
    },
    [write],
  );

  return { text: draft.text, sendMode: draft.sendMode, setText, setSendMode };
}