import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface AgentMarkdownProps {
  children: string;
}

/** Markdown-рендер вывода агента (GFM), стилизованный под Matrix-тему. */
export default function AgentMarkdown({ children }: AgentMarkdownProps) {
  return (
    <div className="agent-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}