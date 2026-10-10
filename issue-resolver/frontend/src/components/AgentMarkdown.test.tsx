import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import AgentMarkdown from './AgentMarkdown';

afterEach(() => {
  cleanup();
});

describe('AgentMarkdown', () => {
  it('рендерит markdown: **bold** → <strong>, текст остаётся текстом', () => {
    render(<AgentMarkdown>{'обычный **жирный** текст'}</AgentMarkdown>);

    const strong = screen.getByText('жирный');
    expect(strong.tagName).toBe('STRONG');
    expect(screen.getByText(/обычный/)).toBeInTheDocument();
  });

  it('рендерит fenced code в pre > code', () => {
    const { container } = render(
      <AgentMarkdown>{'```ts\nconst x = 1;\n```'}</AgentMarkdown>,
    );

    const code = container.querySelector('pre > code');
    expect(code).not.toBeNull();
    expect(code).toHaveTextContent('const x = 1;');
  });

  it('не использует dangerouslySetInnerHTML (html экранируется как текст)', () => {
    render(<AgentMarkdown>{'<script>alert(1)</script>'}</AgentMarkdown>);

    expect(
      screen.getByText('<script>alert(1)</script>'),
    ).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
  });
});