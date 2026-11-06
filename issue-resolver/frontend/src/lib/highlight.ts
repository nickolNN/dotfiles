import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import 'highlight.js/styles/github-dark.css';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('python', python);
hljs.registerLanguage('go', go);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('sql', sql);

hljs.registerAliases(['js', 'jsx'], { languageName: 'javascript' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['html', 'htm', 'svg'], { languageName: 'xml' });
hljs.registerAliases(['sh', 'zsh'], { languageName: 'bash' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });

export function extToLanguage(ext: string): string | null {
  switch (ext.toLowerCase()) {
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return 'javascript';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'css':
      return 'css';
    case 'html':
    case 'htm':
    case 'xml':
    case 'svg':
      return 'xml';
    case 'json':
      return 'json';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'bash';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'py':
      return 'python';
    case 'go':
      return 'go';
    case 'c':
    case 'h':
      return 'c';
    case 'cpp':
    case 'cc':
    case 'hpp':
      return 'cpp';
    case 'sql':
      return 'sql';
    default:
      return null;
  }
}

function highlightCode(
  code: string,
  language: string | null,
): string | null {
  if (!language) return null;
  try {
    return hljs.highlight(code, { language }).value;
  } catch {
    return null;
  }
}

export type HighlightNode =
  | { type: 'text'; text: string }
  | { type: 'span'; className: string; children: HighlightNode[] };

const HIGHLIGHT_TOKEN =
  /<span class="([^"]*)">|<\/span>|([^<]+)/g;

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseHighlightHtml(html: string): HighlightNode[] {
  HIGHLIGHT_TOKEN.lastIndex = 0;
  const root: HighlightNode[] = [];
  const stack: HighlightNode[][] = [root];
  let match: RegExpExecArray | null;
  while ((match = HIGHLIGHT_TOKEN.exec(html)) !== null) {
    if (match[1] !== undefined) {
      const node: HighlightNode = {
        type: 'span',
        className: match[1],
        children: [],
      };
      stack[stack.length - 1].push(node);
      stack.push(node.children);
    } else if (match[0] === '</span>') {
      if (stack.length > 1) stack.pop();
    } else if (match[2] !== undefined) {
      stack[stack.length - 1].push({
        type: 'text',
        text: decodeEntities(match[2]),
      });
    }
  }
  return root;
}

export function highlightTree(
  code: string,
  language: string | null,
): HighlightNode[] | null {
  const html = highlightCode(code, language);
  return html === null ? null : parseHighlightHtml(html);
}
