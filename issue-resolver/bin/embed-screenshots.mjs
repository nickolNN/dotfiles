#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const RASTER = /\.(?:png|jpe?g|webp|gif)$/i;
const PLACEHOLDER = /(?<attr>data-slot|src)\s*=\s*(?<q>["'])(?<name>[^"']+\.(?:png|jpe?g|webp|gif))(?<q2>["'])/gi;

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
const CONVERTIBLE = new Set(['.png', '.jpg', '.jpeg']);

function parseArgs(argv) {
  const options = {
    page: 'report.html',
    shots: null,
    quality: 85,
    lossless: false,
    keepPng: false,
    quiet: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--shots':
        options.shots = argv[++index] ?? null;
        break;
      case '--quality':
        options.quality = Number(argv[++index]);
        break;
      case '--lossless':
        options.lossless = true;
        break;
      case '--keep-png':
        options.keepPng = true;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        if (!arg.startsWith('-')) options.page = arg;
    }
  }
  return options;
}

const HELP = `usage: embed-screenshots.mjs [page] [options]

  page            HTML file to patch (default: report.html)
  --shots DIR     screenshots directory (default: <page dir>/screenshots)
  --quality N     WebP quality (default 85)
  --lossless      bit-exact WebP instead of quality 85
  --keep-png      inline original PNG/JPEG bytes
  --quiet         only print the summary line`;

function findEncoder() {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const name of ['cwebp', 'magick', 'convert']) {
    for (const dir of dirs) {
      const candidate = join(dir, name);
      try {
        readFileSync(candidate);
        return { kind: name, binary: candidate };
      } catch {
      }
    }
  }
  return null;
}

function encodeWebp(encoder, source, options) {
  const quality = options.lossless
    ? []
    : ['-quality', String(options.quality)];
  const args =
    encoder.kind === 'cwebp'
      ? [
          '-quiet',
          ...(options.lossless
            ? ['-lossless', '-z', '9']
            : ['-q', String(options.quality)]),
          source,
          '-o',
          '-',
        ]
      : [
          source,
          '-strip',
          ...(options.lossless
            ? ['-define', 'webp:lossless=true', '-define', 'webp:method=4']
            : quality),
          'webp:-',
        ];
  try {
    const out = execFileSync(encoder.binary, args, {
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function dataUri(source, encoder, options) {
  const suffix = source.slice(source.lastIndexOf('.')).toLowerCase();
  if (!options.keepPng && encoder && CONVERTIBLE.has(suffix)) {
    const webp = encodeWebp(encoder, source, options);
    if (webp) {
      const mode = options.lossless ? 'webp-lossless' : `webp-q${options.quality}`;
      return [`src="data:image/webp;base64,${webp.toString('base64')}"`, mode];
    }
  }
  const raw = readFileSync(source).toString('base64');
  const mime = MIME[suffix] ?? 'application/octet-stream';
  return [`src="data:${mime};base64,${raw}"`, 'raw'];
}

function localSlot(match, shotsName) {
  let name = match.groups.name;
  const lowered = name.toLowerCase();
  if (
    lowered.startsWith('http://') ||
    lowered.startsWith('https://') ||
    lowered.startsWith('//') ||
    lowered.startsWith('data:')
  ) {
    return null;
  }
  if (match.groups.attr.toLowerCase() === 'src') {
    const prefix = `${shotsName}/`;
    if (!name.startsWith(prefix)) return null;
    name = name.slice(prefix.length);
  }
  return RASTER.test(name) ? name : null;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(HELP);
    return 0;
  }

  const page = resolve(options.page);
  const shotsDir = resolve(options.shots ?? join(dirname(page), 'screenshots'));
  const shotsName = shotsDir.split(sep).pop();

  let text;
  try {
    text = readFileSync(page, 'utf8');
  } catch {
    console.error(`embed-screenshots: no page at ${page}`);
    return 2;
  }
  const before = Buffer.byteLength(text);
  const encoder = options.keepPng ? null : findEncoder();

  const cache = new Map();
  const missing = new Set();
  const modes = new Map();

  let patched = '';
  let cursor = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = localSlot(match, shotsName);
    if (name === null) continue;
    patched += text.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    if (cache.has(name)) {
      patched += cache.get(name);
      continue;
    }
    const source = resolve(shotsDir, name);
    if (!source.startsWith(shotsDir + sep)) {
      missing.add(name);
      patched += match[0];
      continue;
    }
    try {
      const [uri, mode] = dataUri(source, encoder, options);
      cache.set(name, uri);
      modes.set(mode, (modes.get(mode) ?? 0) + 1);
      patched += uri;
    } catch {
      missing.add(name);
      patched += match[0];
    }
  }
  patched += text.slice(cursor);

  if (missing.size > 0) {
    console.error(
      `embed-screenshots: missing screenshots — ${[...missing].sort().join(', ')}`,
    );
  }

  if (patched !== text) writeFileSync(page, patched, 'utf8');
  const after = Buffer.byteLength(patched);

  let remaining = 0;
  for (const match of patched.matchAll(PLACEHOLDER)) {
    if (localSlot(match, shotsName) !== null) remaining += 1;
  }

  const modeSummary =
    [...modes.entries()]
      .sort(([, left], [, right]) => right - left)
      .map(([mode, count]) => `${count}× ${mode}`)
      .join(', ') || 'nothing';
  console.log(
    `embed-screenshots: inlined ${cache.size} (${modeSummary}), ` +
      `html ${before} → ${after} bytes, placeholders left ${remaining}`,
  );

  if (!options.quiet) {
    for (const [name, uri] of cache) {
      console.log(`  ${name}: ${uri.length} bytes of markup`);
    }
  }

  return remaining > 0 || missing.size > 0 ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));