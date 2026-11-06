import { messageOf } from "../../lib/errors";
import { useEffect, useState } from "react";
import type {
  PromptMode,
  SessionCommand,
} from "@issue-resolver/shared";
import {
  promptIteration,
  sendIterationCommand,
  sendIterationMessage,
} from "../../api/client";
import { useIterationControl } from "../../stores/queries";
import { isThinkingLevel } from "../../constants/thinking-levels";
import type { ChatDraftApi } from "./chat-drafts";
import { controlModelList } from "./format";
import { useInvalidateOnTick } from "./useInvalidateOnTick";

export function useAgentChat(
  draft: ChatDraftApi,
  sessionId: string | null,
  active: boolean,
) {
  const [messageSending, setMessageSending] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [controlTick, setControlTick] = useState(0);
  const [controlBusy, setControlBusy] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const [compactOpen, setCompactOpen] = useState(false);
  const [compactInstructions, setCompactInstructions] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);

  const controlQuery = useIterationControl(sessionId, active);
  const controlSnapshot = active ? (controlQuery.data ?? null) : null;

  useInvalidateOnTick(controlTick, sessionId, "iteration-control");

  const slashQuery = draft.text.startsWith("/") ? draft.text.slice(1) : null;
  const commandMatches =
    slashQuery !== null && controlSnapshot
      ? controlSnapshot.commands
          .filter((command) =>
            command.name.toLowerCase().includes(slashQuery.toLowerCase()),
          )
          .slice(0, 12)
      : [];
  const controlState = controlSnapshot?.state ?? null;
  const controlModelOptions = controlModelList(controlSnapshot?.models ?? []);
  const controlThinkingLevels =
    controlSnapshot?.thinkingLevels.filter(isThinkingLevel) ?? [];
  const currentModelValue =
    controlState?.provider && controlState.modelId
      ? modelOptionValue(controlState.provider, controlState.modelId)
      : "";
  const activePaletteIndex =
    commandMatches.length > 0
      ? Math.min(paletteIndex, commandMatches.length - 1)
      : 0;
  const filledCommand = controlSnapshot?.commands.find(
    (command) =>
      draft.text === `/${command.name} ` ||
      draft.text.startsWith(`/${command.name} `),
  );
  const commandHint = filledCommand?.argumentHint ?? null;

  useEffect(() => {
    setPaletteIndex(0);
  }, [draft.text]);

  async function handleMessageSubmit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || !sessionId) return;

    setMessageError(null);
    setMessageSending(true);

    try {
      if (controlSnapshot) {
        const mode: PromptMode | undefined =
          trimmed.startsWith("/") || draft.sendMode === "prompt"
            ? undefined
            : draft.sendMode;
        const result = await promptIteration(sessionId, trimmed, mode);
        if (!result.ok) {
          setMessageError(result.error ?? "Не удалось отправить сообщение");
        } else {
          draft.setText("");
        }
        setControlTick((tick) => tick + 1);
      } else {
        await sendIterationMessage(sessionId, trimmed);
        draft.setText("");
      }
    } catch (error) {
      setMessageError(messageOf(error));
    } finally {
      setMessageSending(false);
    }
  }

  async function runControlCommand(command: SessionCommand) {
    if (!sessionId) return;
    setControlError(null);
    setControlBusy(true);

    try {
      const result = await sendIterationCommand(sessionId, command);
      if (!result.ok) {
        setControlError(result.error ?? "Команда не выполнена");
      }
    } catch (error) {
      setControlError(messageOf(error));
    } finally {
      setControlBusy(false);
      setControlTick((tick) => tick + 1);
    }
  }

  function modelOptionValue(provider: string, id: string): string {
    return `${provider}/${id}`;
  }

  function handleModelChange(value: string) {
    if (value === "__cycle__") {
      void runControlCommand({ type: "cycle_model" });
      return;
    }
    const slash = value.indexOf("/");
    if (slash <= 0) return;
    void runControlCommand({
      type: "set_model",
      provider: value.slice(0, slash),
      modelId: value.slice(slash + 1),
    });
  }

  function handleThinkingChange(level: string) {
    if (!level) return;
    void runControlCommand({ type: "set_thinking_level", level });
  }

  function submitCompact() {
    const instructions = compactInstructions.trim();
    void runControlCommand({
      type: "compact",
      ...(instructions ? { instructions } : {}),
    });
    setCompactOpen(false);
    setCompactInstructions("");
  }

  function recallQueued(text: string) {
    draft.setText((current) =>
      current.trim() ? `${current.trimEnd()} ${text}` : text,
    );
  }

  return {
    messageSending,
    messageError,
    controlBusy,
    controlError,
    controlSnapshot,
    controlState,
    controlModelOptions,
    controlThinkingLevels,
    currentModelValue,
    commandMatches,
    commandHint,
    filledCommand,
    activePaletteIndex,
    setPaletteIndex,
    compactOpen,
    setCompactOpen,
    compactInstructions,
    setCompactInstructions,
    submitCompact,
    recallQueued,
    handleMessageSubmit,
    runControlCommand,
    modelOptionValue,
    handleModelChange,
    handleThinkingChange,
  };
}