import { gzipSync } from 'node:zlib';

export interface ArchiveEntry {
  name: string;
  relPath: string;
  body: Buffer;
}

const BLOCK_SIZE = 512;

function writeOctal(
  block: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  const str = value.toString(8).padStart(length - 1, '0');
  block.write(str, offset, length - 1, 'ascii');
  block[offset + length - 1] = 0;
}

function splitName(
  path: string,
): { prefix: string; name: string } {
  if (Buffer.byteLength(path) <= 100) {
    return { prefix: '', name: path };
  }
  let idx = path.lastIndexOf('/');
  while (idx > 0) {
    const prefix = path.slice(0, idx);
    const name = path.slice(idx + 1);
    if (
      Buffer.byteLength(name) <= 100 &&
      Buffer.byteLength(prefix) <= 155
    ) {
      return { prefix, name };
    }
    idx = path.lastIndexOf('/', idx - 1);
  }
  throw new Error(`archive entry path too long for ustar: ${path}`);
}

function buildHeader(entry: ArchiveEntry): Buffer {
  const path = entry.relPath || entry.name;
  const { prefix, name } = splitName(path);
  const block = Buffer.alloc(BLOCK_SIZE);

  block.write(name, 0, 100, 'utf8');
  writeOctal(block, 100, 8, 0o644);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, entry.body.length);
  writeOctal(block, 136, 12, 0);
  block.fill(0x20, 148, 156);
  block[156] = 0x30;
  block.write('ustar', 257, 5, 'ascii');
  block[262] = 0;
  block[263] = 0x30;
  block[264] = 0x30;
  block.write(prefix, 345, 155, 'utf8');

  let checksum = 0;
  for (let i = 0; i < BLOCK_SIZE; i += 1) {
    checksum += block[i];
  }
  const checksumOctal = checksum.toString(8).padStart(6, '0');
  block.write(checksumOctal, 148, 6, 'ascii');
  block[154] = 0;
  block[155] = 0x20;

  return block;
}

function paddingFor(size: number): number {
  const remainder = size % BLOCK_SIZE;
  return remainder === 0 ? 0 : BLOCK_SIZE - remainder;
}

export function createTar(entries: readonly ArchiveEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const left = a.relPath || a.name;
    const right = b.relPath || b.name;
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });

  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(buildHeader(entry));
    parts.push(entry.body);
    const padding = paddingFor(entry.body.length);
    if (padding > 0) {
      parts.push(Buffer.alloc(padding));
    }
  }
  parts.push(Buffer.alloc(BLOCK_SIZE * 2));
  return Buffer.concat(parts);
}

export async function createTarGz(
  entries: readonly ArchiveEntry[],
): Promise<Buffer> {
  return gzipSync(createTar(entries));
}