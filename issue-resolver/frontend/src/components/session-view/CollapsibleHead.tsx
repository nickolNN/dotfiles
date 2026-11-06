export default function CollapsibleHead({
  open,
  onToggle,
  icon,
  toolName,
  label,
  duration,
  error = false,
}: {
  open: boolean;
  onToggle: () => void;
  icon: string;
  toolName: string;
  label?: string;
  duration?: string;
  error?: boolean;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="session-tool-head"
    >
      <span aria-hidden="true" className="session-tool-caret transition-base">
        {open ? '▾' : '▸'}
      </span>
      <span aria-hidden="true" className="session-tool-icon">
        {icon}
      </span>
      <span className="session-tool-name">{toolName}</span>
      {label && <span className="session-tool-label">{label}</span>}
      {error && <span className="session-tool-error-badge">error</span>}
      {duration && <span className="session-tool-duration">{duration}</span>}
    </button>
  );
}