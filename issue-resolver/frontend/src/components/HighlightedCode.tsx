import { Fragment } from 'react';
import type { HighlightNode } from '../lib/highlight';

function renderNodes(nodes: HighlightNode[]) {
  return nodes.map((node, index) =>
    node.type === 'text' ? (
      <Fragment key={index}>{node.text}</Fragment>
    ) : (
      <span key={index} className={node.className}>
        {renderNodes(node.children)}
      </span>
    ),
  );
}

export default function HighlightedCode({ nodes }: { nodes: HighlightNode[] }) {
  return <code className="hljs">{renderNodes(nodes)}</code>;
}
