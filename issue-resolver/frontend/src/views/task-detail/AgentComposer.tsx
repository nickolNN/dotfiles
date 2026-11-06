import ModelThinkingSelect from "../../components/ModelThinkingSelect";
import type { SessionEvent } from "../../api/session-events";
import type { ChatDraftApi } from "./chat-drafts";
import { CYCLE_MODEL_ID, inputClass } from "./constants";
import type { StepLogIteration, StepLogTarget } from "./types";
import { isSendMode } from "./types";
import type { useAgentChat } from "./useAgentChat";

interface AgentComposerProps {
  target: StepLogTarget;
  iteration: StepLogIteration;
  chat: ReturnType<typeof useAgentChat>;
  draft: ChatDraftApi;
}

export default function AgentComposer({
  target,
  iteration,
  chat,
  draft,
}: AgentComposerProps) {
  return (
            <div className="border-t border-[#008F11] py-3 px-2 sm:px-4">
              {chat.controlSnapshot && (
                <div
                  data-testid="live-controls"
                  className="mb-3 flex flex-wrap items-center gap-2 text-xs"
                >
                  <ModelThinkingSelect
                    models={chat.controlModelOptions}
                    thinkingLevels={chat.controlThinkingLevels}
                    modelValue={chat.currentModelValue}
                    thinkingValue={chat.controlState?.thinkingLevel ?? ""}
                    disabled={chat.controlBusy}
                    modelOptionValue={(model) =>
                      model.id === CYCLE_MODEL_ID
                        ? CYCLE_MODEL_ID
                        : chat.modelOptionValue(model.provider ?? "", model.id)
                    }
                    modelPlaceholder={chat.controlState?.model ?? "—"}
                    thinkingPlaceholder="—"
                    modelLabel="модель"
                    thinkingLabel="thinking"
                    labelClassName="text-xs text-[#00FF41]/70"
                    modelTestId="control-model"
                    thinkingTestId="control-thinking"
                    modelAriaLabel="Модель сессии"
                    thinkingAriaLabel="Уровень размышления"
                    modelSelectClassName={`${inputClass} w-auto py-1`}
                    thinkingSelectClassName={`${inputClass} w-auto py-1`}
                    className="contents"
                    onModelChange={chat.handleModelChange}
                    onThinkingChange={chat.handleThinkingChange}
                  />

                  <button
                    type="button"
                    data-testid="control-compact"
                    disabled={chat.controlBusy}
                    onClick={() => chat.setCompactOpen((open) => !open)}
                    className="min-h-8 border border-[#FFB000] px-2 py-0.5 text-[#FFB000] hover:bg-[#FFB000] hover:text-[#0D0208] disabled:opacity-50 transition-base"
                  >
                    compact
                  </button>
                  <button
                    type="button"
                    data-testid="control-clear-queue"
                    disabled={chat.controlBusy}
                    onClick={() =>
                      void chat.runControlCommand({ type: "clear_queue" })
                    }
                    className="min-h-8 border border-[#008F11] px-2 py-0.5 text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41] disabled:opacity-50 transition-base"
                  >
                    очистить очередь
                  </button>
                  <button
                    type="button"
                    data-testid="abort-iteration-modal"
                    disabled={iteration.aborting}
                    onClick={() => {
                      if (iteration.id) {
                        iteration.onAbort(target.sessionId);
                      }
                    }}
                    className="min-h-8 border border-[#FF0033] bg-[#2A0008] px-2 py-0.5 text-xs text-[#FF0033] hover:bg-[#FF0033] hover:text-[#0D0208] disabled:opacity-50 transition-base"
                  >
                    {iteration.aborting ? "Прерываем…" : "Прервать"}
                  </button>
                </div>
              )}

              {chat.compactOpen && (
                <div
                  data-testid="compact-panel"
                  className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center"
                >
                  <input
                    type="text"
                    aria-label="Инструкции компакции"
                    className={`${inputClass} min-w-0 flex-1`}
                    value={chat.compactInstructions}
                    onChange={(event) =>
                      chat.setCompactInstructions(event.target.value)
                    }
                    placeholder="Инструкции для компакции (необязательно)…"
                  />
                  <button
                    type="button"
                    data-testid="compact-run"
                    onClick={chat.submitCompact}
                    className="min-h-9 shrink-0 border border-[#00FF41] bg-[#003B00] px-3 py-1 text-xs font-medium text-[#00FF41] disabled:opacity-50 transition-base"
                  >
                    Сжать
                  </button>
                  <button
                    type="button"
                    onClick={() => chat.setCompactOpen(false)}
                    className="min-h-9 shrink-0 border border-[#008F11] px-3 py-1 text-xs text-[#00FF41]/80 hover:border-[#00FF41] transition-base"
                  >
                    Отмена
                  </button>
                </div>
              )}

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <form
                  className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (iteration.id) {
                      void chat.handleMessageSubmit(draft.text);
                    }
                  }}
                >
                  <input
                    type="text"
                    aria-label="Сообщение"
                    className={`${inputClass} min-w-0 flex-1 order-1 sm:order-3`}
                    value={draft.text}
                    onChange={(event) => draft.setText(event.target.value)}
                    onKeyDown={(event) => {
                      if (chat.commandMatches.length === 0) return;
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        chat.setPaletteIndex(
                          (index) => (index + 1) % chat.commandMatches.length,
                        );
                      } else if (event.key === "ArrowUp") {
                        event.preventDefault();
                        chat.setPaletteIndex(
                          (index) =>
                            (index - 1 + chat.commandMatches.length) %
                            chat.commandMatches.length,
                        );
                      } else if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        draft.setText(
                          `/${chat.commandMatches[chat.activePaletteIndex].name} `,
                        );
                      }
                    }}
                    placeholder="Написать этому агенту…"
                    disabled={chat.messageSending}
                  />
                  {chat.controlSnapshot && (
                    <select
                      data-testid="send-mode"
                      aria-label="Режим отправки"
                      className={`${inputClass} w-auto py-1 order-2 sm:order-1`}
                      value={draft.sendMode}
                      disabled={chat.messageSending}
                      onChange={(event) => {
                        const mode = event.target.value;
                        if (isSendMode(mode)) draft.setSendMode(mode);
                      }}
                    >
                      <option value="prompt">prompt</option>
                      <option value="steer">steer</option>
                      <option value="followUp">follow-up</option>
                    </select>
                  )}
                  {(() => {
                    let queueEvent: SessionEvent | undefined;
                    for (
                      let i = target.events.length - 1;
                      i >= 0;
                      i -= 1
                    ) {
                      if (target.events[i].type === "queue") {
                        queueEvent = target.events[i];
                        break;
                      }
                    }
                    if (!queueEvent || queueEvent.type !== "queue")
                      return null;
                    const steering: string[] = queueEvent.steering ?? [];
                    const followUp: string[] = queueEvent.followUp ?? [];
                    if (steering.length === 0 && followUp.length === 0)
                      return null;
                    return (
                      <span
                        data-testid="queue-recall-inline"
                        className="order-2 sm:order-2 flex flex-wrap gap-1"
                      >
                        {steering.map((text: string, i: number) => (
                          <button
                            key={`steer-${i}`}
                            type="button"
                            data-testid={`queue-recall-steer-${i}`}
                            onClick={() => chat.recallQueued(text)}
                            disabled={chat.messageSending}
                            className="min-h-7 border border-[#FFB000] px-1.5 text-[10px] text-[#FFB000] hover:bg-[#FFB000]/20 disabled:opacity-50 transition-base"
                            title={text}
                          >
                            ↩steer
                          </button>
                        ))}
                        {followUp.map((text: string, i: number) => (
                          <button
                            key={`follow-${i}`}
                            type="button"
                            data-testid={`queue-recall-follow-${i}`}
                            onClick={() => chat.recallQueued(text)}
                            disabled={chat.messageSending}
                            className="min-h-7 border border-[#00B4FF] px-1.5 text-[10px] text-[#00B4FF] hover:bg-[#00B4FF]/20 disabled:opacity-50 transition-base"
                            title={text}
                          >
                            ↩follow
                          </button>
                        ))}
                      </span>
                    );
                  })()}
                  <button
                    type="submit"
                    disabled={!draft.text.trim() || chat.messageSending}
                    className="min-h-9 shrink-0 rounded-none border border-[#00FF41] bg-[#003B00] px-3 py-1 text-xs font-medium text-[#00FF41] disabled:opacity-50 transition-base order-3 sm:order-4"
                  >
                    {chat.messageSending ? "Отправка…" : "Отправить"}
                  </button>
                </form>
              </div>

              {chat.commandHint !== null && (
                <p
                  data-testid="command-hint"
                  className="mt-1 font-mono text-[10px] text-[#00FF41]/50"
                >
                  /{chat.filledCommand?.name} {chat.commandHint}
                </p>
              )}

              {chat.commandMatches.length > 0 && (
                <div
                  data-testid="command-palette"
                  className="mt-2 border border-[#008F11] bg-[#000200] text-xs"
                >
                  {chat.commandMatches.map((command, index) => (
                    <button
                      key={command.name}
                      type="button"
                      data-testid={`command-option-${command.name}`}
                      data-active={
                        index === chat.activePaletteIndex ? "true" : "false"
                      }
                      onClick={() => draft.setText(`/${command.name} `)}
                      className={`block w-full px-2 py-1 text-left hover:bg-[#003B00]${index === chat.activePaletteIndex ? " bg-[#003B00]" : ""} transition-base`}
                    >
                      <span className="text-[#00FF41]">/{command.name}</span>
                      {command.argumentHint && (
                        <span className="ml-1 font-mono text-[10px] text-[#00FF41]/40">
                          {command.argumentHint}
                        </span>
                      )}
                      <span className="ml-2 border border-[#008F11] px-1 text-[10px] uppercase tracking-wider text-[#00FF41]/60">
                        {command.source}
                      </span>
                      {command.description && (
                        <span className="ml-2 text-[#00FF41]/50">
                          {command.description}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {chat.controlError && (
                <p
                  role="alert"
                  data-testid="control-error"
                  className="mt-2 text-xs font-medium text-[#FF0033]"
                >
                  {chat.controlError}
                </p>
              )}
              {chat.messageError && (
                <p
                  role="alert"
                  data-testid="message-error"
                  className="mt-2 text-xs font-medium text-[#FF0033]"
                >
                  {chat.messageError}
                </p>
              )}
              {iteration.abortError && (
                <p
                  role="alert"
                  className="mt-2 text-xs font-medium text-[#FF0033]"
                >
                  {iteration.abortError}
                </p>
              )}
            </div>
  );
}
