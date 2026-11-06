import { useState } from 'react';
import CollapsibleHead from './CollapsibleHead';
import { formatToolDuration } from './format';

export default function ToolResultBlock({
  toolName,
  isError,
  durationMs,
  resultText,
}: {
  toolName: string;
  isError: boolean;
  durationMs: number | null;
  resultText: string;
}) {
  const [open, setOpen] = useState(false);
  const duration = formatToolDuration(durationMs);

  return (
    <div
      data-testid={`tool-result-${toolName}`}
      data-error={isError ? 'true' : 'false'}
      className={`session-tool session-tool--result${isError ? ' session-tool--error' : ''}`}
    >
      <CollapsibleHead
        open={open}
        onToggle={() => setOpen((value) => !value)}
        icon={isError ? '✕' : '✓'}
        toolName={toolName}
        label="result"
        duration={duration || undefined}
        error={isError}
      />
      {open && (
        <pre
          data-testid={`tool-result-text-${toolName}`}
          className="session-tool-body animate-slide-down"
        >
          {resultText}
        </pre>
      )}
    </div>
  );
}