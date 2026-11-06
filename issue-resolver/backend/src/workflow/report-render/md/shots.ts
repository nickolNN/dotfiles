import { escapeHtml } from '../html';

const IMAGE_PATH = /\.(?:png|jpe?g|webp|gif)$/i;
const SHOT_MENTION = /`?([\w./-]*?)([\w-]+\.(?:png|jpe?g|webp|gif))`?/gi;

const shots: string[] = [];

export function resetShots(): void {
  shots.length = 0;
}

export function collectedShots(): string[] {
  return [...shots];
}

function remember(name: string): void {
  if (!shots.includes(name)) shots.push(name);
}

export function shotName(raw: string): string | null {
  const path = raw.trim().replace(/^\.\//, '');
  if (path === '' || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  if (path.startsWith('/') || path.split('/').includes('..')) return null;
  if (!IMAGE_PATH.test(path)) return null;
  return path.split('/').pop() ?? null;
}

export function shotFigure(
  path: string,
  caption: string,
  block: boolean,
): string {
  const name = shotName(path);
  if (name === null) return caption;
  remember(name);
  const alt = caption.trim() === '' ? name : caption.trim();
  const inner = `<a class="shot-link" href="#"><img${block ? ' class="shot-image"' : ' class="inline-shot"'} data-slot="${escapeHtml(name)}" alt="${escapeHtml(alt)}"></a>`;
  if (!block) return inner;
  return `<figure class="shot">${inner}<figcaption>${escapeHtml(alt)}</figcaption></figure>`;
}

export function figuresForMentions(
  text: string,
  available: string[],
  used: Set<string>,
): string {
  const figures: string[] = [];
  for (const match of text.matchAll(SHOT_MENTION)) {
    const name = match[2];
    if (!available.includes(name)) continue;
    used.add(name);
    remember(name);
    figures.push(
      `<figure class="shot"><a class="shot-link" href="#"><img class="shot-image" data-slot="${escapeHtml(name)}" alt="${escapeHtml(name)}"></a></figure>`,
    );
  }
  return figures.join('');
}