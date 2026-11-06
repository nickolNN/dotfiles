import { useMemo, useState } from 'react';
import CollapsibleHead from './CollapsibleHead';
import { prettyJsonValue } from '../../lib/json';
import { formatToolDuration } from './format';
import { ToolStatus } from './types';

export default function ToolUseBlock({
  toolName,
  args,
  partialText,
  status,
  durationMs,
  isError,
}: {
  toolName: string;
  args: unknown;
  partialText?: string;
  status: ToolStatus;
  durationMs: number | null;
  isError: boolean;
}) {
  const [open, setOpen] = useState(false);
  const argsText = useMemo(() => prettyJsonValue(args), [args]);
  const duration = formatToolDuration(durationMs);

  return (
    <div
      data-testid={`tool-use-${toolName}`}
      data-status={status}
      className={`session-tool session-tool--use${isError ? ' session-tool--error' : ''}`}
    >
      <CollapsibleHead
        open={open}
        onToggle={() => setOpen((value) => !value)}
        icon="⚙"
        toolName={toolName}
        label="arguments"
      />
      <div
        data-testid={`tool-status-${toolName}`}
        data-status={status}
        className="flex items-center gap-2 px-2 pb-0.5 text-[10px] uppercase tracking-wider text-[#00FF41]/50"
      >
        <span aria-hidden="true">{statusIcon(status)}</span>
        <span>{statusLabel(status, duration)}</span>
        {isError && <span className="text-[#FF0033]">error</span>}
      </div>
      {open && (
        <pre
          data-testid={`tool-use-args-${toolName}`}
          className="session-tool-body animate-slide-down"
        >
          {argsText}
        </pre>
      )}
      {partialText !== undefined && (
        <pre
          data-testid={`tool-partial-${toolName}`}
          className="session-tool-body session-tool-partial"
        >
          {partialText}
        </pre>
      )}
    </div>
  );
}

function statusIcon(status: ToolStatus): string {
  if (status === ToolStatus.done) return '✓';
  if (status === ToolStatus.running) return '◐';
  return '…';
}

function statusLabel(status: ToolStatus, duration: string): string {
  if (status === ToolStatus.done) {
    return `готово${duration ? ` · ${duration}` : ''}`;
  }
  if (status === ToolStatus.running) return 'выполняется';
  return 'ожидание';
}