interface ToggleProps {
  checked: boolean;
  label: string;
  onToggle: () => void;
}

export default function Toggle({ checked, label, onToggle }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onToggle}
      className="flex min-h-12 items-center gap-3 text-sm font-medium text-[#00FF41]/80"
    >
      <span
        aria-hidden="true"
        className={`relative inline-flex h-6 w-11 shrink-0 items-center border transition-colors ${
          checked ? 'border-[#00FF41] bg-[#003B00]' : 'border-[#008F11] bg-[#0D0208]'
        }`}
      >
        <span
          className={`absolute h-4 w-4 transition-transform ${
            checked ? 'translate-x-6 bg-[#00FF41]' : 'translate-x-1 bg-[#008F11]'
          }`}
        />
      </span>
      {label}
    </button>
  );
}