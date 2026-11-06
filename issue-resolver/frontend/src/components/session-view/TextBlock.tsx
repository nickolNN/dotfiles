import AgentMarkdown from '../AgentMarkdown';

export default function TextBlock({
  text,
  live = false,
}: {
  text: string;
  live?: boolean;
}) {
  return (
    <div
      data-testid={live ? 'session-text-live' : 'session-text'}
      className="session-msg session-msg--text"
    >
      <AgentMarkdown>{text}</AgentMarkdown>
    </div>
  );
}