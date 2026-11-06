import { useEffect, useRef, useState } from 'react';
import CollapsibleHead from './CollapsibleHead';
import { THINKING_BOUNDED_CHARS, THINKING_PREVIEW_CHARS } from './constants';

function previewOf(thinking: string, streaming: boolean): string {
  if (streaming) return thinking.trimEnd().slice(-THINKING_PREVIEW_CHARS);
  return thinking.split('\n')[0].slice(0, THINKING_PREVIEW_CHARS);
}

export default function ThinkingBlock({
  thinking,
  streaming = false,
}: {
  thinking: string;
  streaming?: boolean;
}) {
  const [open, setOpen] = useState(streaming);
  const bodyRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (streaming) setOpen(true);
  }, [streaming]);

  useEffect(() => {
    if (streaming && open && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [thinking, streaming, open]);

  const preview = previewOf(thinking, streaming);
  const bounded = streaming || thinking.length > THINKING_BOUNDED_CHARS;

  return (
    <div
      data-testid="session-thinking"
      data-streaming={streaming ? 'true' : 'false'}
      className="session-thinking"
    >
      <CollapsibleHead
        open={open}
        onToggle={() => setOpen((value) => !value)}
        icon="💭"
        toolName="thinking"
        label={open ? '' : preview}
      />
      {streaming && (
        <div
          data-testid="session-thinking-live"
          className="px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#00FF41]/50"
        >
          думает
          <span className="animate-pulse-subtle">…</span>
        </div>
      )}
      {open && (
        <pre
          ref={bodyRef}
          data-testid="session-thinking-text"
          className={`session-thinking-body animate-slide-down whitespace-pre-wrap break-words${bounded ? ' max-h-96 overflow-auto' : ''}`}
        >
          {thinking}
        </pre>
      )}
    </div>
  );
}