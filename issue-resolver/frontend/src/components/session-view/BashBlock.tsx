export default function BashBlock({ text }: { text: string }) {
  return (
    <div
      data-testid="session-bash"
      className="border border-[#008F11] bg-[#000200]"
    >
      <div className="border-b border-[#008F11]/50 px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#00FF41]/50">
        bash
      </div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words p-2 font-mono text-[11px] text-[#00FF41]/85">
        {text}
      </pre>
    </div>
  );
}