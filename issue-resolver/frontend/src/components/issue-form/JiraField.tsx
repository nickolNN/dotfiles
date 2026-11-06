import JiraIssueUrlInput from '../JiraIssueUrlInput';

interface JiraFieldProps {
  expanded: boolean;
  value: string;
  onChange: (value: string) => void;
  onMakeVisible: () => void;
  onRemove: () => void;
}

const linkClass =
  'text-sm font-medium text-[#008F11] underline hover:text-[#00FF41]';

export default function JiraField({
  expanded,
  value,
  onChange,
  onMakeVisible,
  onRemove,
}: JiraFieldProps) {
  if (!expanded) {
    return (
      <button type="button" className={linkClass} onClick={onMakeVisible}>
        Добавить ссылку на Jira
      </button>
    );
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <button type="button" className={linkClass} onClick={onRemove}>
          Убрать
        </button>
      </div>
      <JiraIssueUrlInput
        value={value}
        onChange={onChange}
        placeholder="https://jira.example.com/browse/PROJ-123"
      />
    </div>
  );
}