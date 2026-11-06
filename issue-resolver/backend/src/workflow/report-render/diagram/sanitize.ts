const DISALLOWED_TAG =
  /<\s*(script|iframe|object|embed|foreignObject)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const SELF_CLOSING_DISALLOWED =
  /<\s*(script|iframe|object|embed|foreignObject)\b[^>]*\/?\s*>/gi;
const HANDLER_ATTR = /\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_URL =
  /(href|xlink:href)\s*=\s*("javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]*)/gi;

export function sanitizeSvg(body: string): {
  body: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  let clean = body;
  const count = (pattern: RegExp, source: string): number =>
    (source.match(pattern) ?? []).length;

  const scriptTags =
    count(DISALLOWED_TAG, clean) + count(SELF_CLOSING_DISALLOWED, clean);
  if (scriptTags > 0)
    warnings.push(
      `report.json: ${scriptTags} unsafe element(s) removed from a raw svg`,
    );
  clean = clean.replace(DISALLOWED_TAG, '').replace(SELF_CLOSING_DISALLOWED, '');

  const handlers = count(HANDLER_ATTR, clean);
  if (handlers > 0)
    warnings.push(
      `report.json: ${handlers} event handler(s) removed from a raw svg`,
    );
  clean = clean.replace(HANDLER_ATTR, '');

  const jsUrls = count(JS_URL, clean);
  if (jsUrls > 0)
    warnings.push('report.json: javascript: URL removed from a raw svg');
  clean = clean.replace(JS_URL, 'href="#"');
  return { body: clean, warnings };
}