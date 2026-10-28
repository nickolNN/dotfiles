import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { embedReportScreenshots } from '../src/workflow/embed-screenshots';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const dirs: string[] = [];

async function workspace(
  page: string,
  shots: Record<string, string | Buffer> = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'embed-shots-'));
  dirs.push(dir);
  await writeFile(join(dir, 'report.html'), page, 'utf8');
  if (Object.keys(shots).length > 0) {
    await mkdir(join(dir, 'screenshots'), { recursive: true });
    for (const [name, content] of Object.entries(shots)) {
      await writeFile(join(dir, 'screenshots', name), content);
    }
  }
  return dir;
}

function png(name: string): Record<string, Buffer> {
  return { [name]: Buffer.from(PNG_1X1, 'base64') };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('embedReportScreenshots', () => {
  it('плейсхолдеры data-slot → data URI, повторный прогон — no-op', async () => {
    const dir = await workspace(
      '<img alt="board" data-slot="01-board.png">',
      png('01-board.png'),
    );

    const first = await embedReportScreenshots(dir);
    expect(first.ok).toBe(true);
    expect(first.summary).toContain('inlined 1');
    expect(first.summary).toContain('placeholders left 0');

    const html = await readFile(join(dir, 'report.html'), 'utf8');
    expect(html).toContain('src="data:image/');
    expect(html).not.toContain('data-slot=');

    const second = await embedReportScreenshots(dir);
    expect(second.ok).toBe(true);
    expect(second.summary).toContain('inlined 0');
    expect(await readFile(join(dir, 'report.html'), 'utf8')).toBe(html);
  });

  it('src="screenshots/…" тоже расширяется, внешние ссылки не трогаются', async () => {
    const dir = await workspace(
      '<img src="screenshots/02-modal.png"><img src="https://example.com/a.png">',
      png('02-modal.png'),
    );

    const result = await embedReportScreenshots(dir);
    expect(result.ok).toBe(true);

    const html = await readFile(join(dir, 'report.html'), 'utf8');
    expect(html).toContain('src="data:image/');
    expect(html).toContain('src="https://example.com/a.png"');
  });

  it('отсутствующий скриншот — не ok, но страница остаётся на месте', async () => {
    const dir = await workspace('<img data-slot="ghost.png">');

    const result = await embedReportScreenshots(dir);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('ghost.png');
    expect(await readFile(join(dir, 'report.html'), 'utf8')).toContain('data-slot="ghost.png"');
  });

  it('страница без плейсхолдеров — ok и без изменений', async () => {
    const page = '<html><body><p>no images</p></body></html>';
    const dir = await workspace(page);

    const result = await embedReportScreenshots(dir);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('inlined 0');
    expect(await readFile(join(dir, 'report.html'), 'utf8')).toBe(page);
  });

  it('страницы нет — не ok, без исключения', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'embed-shots-'));
    dirs.push(dir);

    const result = await embedReportScreenshots(dir);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('report.html');
  });
});