/**
 * Сборка tar.gz без внешних зависимостей.
 *
 * Используется для скачивания всей рабочей папки задачи одним архивом.
 * Формат — ustar (512-байтные заголовки, POSIX `ustar\0` + версия `00`),
 * сжатие — `zlib.gzip`. Порядок записей детерминированный (по `relPath`),
 * mtime занулён, чтобы один и тот же набор файлов давал одинаковый архив.
 */
import { gzipSync } from 'node:zlib';

/** Файл для упаковки: basename, путь внутри архива и содержимое. */
export interface ArchiveEntry {
  /** Отображаемое имя файла (basename). */
  name: string;
  /** Путь относительно корня архива; используется как имя записи. */
  relPath: string;
  /** Содержимое файла. */
  body: Buffer;
}

const BLOCK_SIZE = 512;

/** Запись числа в octal-поле заголовка (NUL в конце), как требует tar. */
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

/** Разбивает длинное имя на ustar-пару `prefix` / `name` (границы ≤155 / ≤100). */
function splitName(
  path: string,
): { prefix: string; name: string } {
  if (Buffer.byteLength(path) <= 100) {
    return { prefix: '', name: path };
  }
  // Ищем самый правый слэш, при котором суффикс влезает в name (≤100).
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

/** 512-байтный ustar-заголовок для одной записи. */
function buildHeader(entry: ArchiveEntry): Buffer {
  const path = entry.relPath || entry.name;
  const { prefix, name } = splitName(path);
  const block = Buffer.alloc(BLOCK_SIZE);

  block.write(name, 0, 100, 'utf8');
  writeOctal(block, 100, 8, 0o644); // mode
  writeOctal(block, 108, 8, 0); // uid
  writeOctal(block, 116, 8, 0); // gid
  writeOctal(block, 124, 12, entry.body.length); // size
  writeOctal(block, 136, 12, 0); // mtime (0 для детерминизма)
  // chksum заполняется после: сейчас поле — пробелы.
  block.fill(0x20, 148, 156);
  block[156] = 0x30; // typeflag '0' — обычный файл
  block.write('ustar', 257, 5, 'ascii');
  block[262] = 0;
  block[263] = 0x30; // version '0'
  block[264] = 0x30; // version '0'
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

/** Padding до ближайшей границы 512 байт. */
function paddingFor(size: number): number {
  const remainder = size % BLOCK_SIZE;
  return remainder === 0 ? 0 : BLOCK_SIZE - remainder;
}

/** Собирает несжатый tar из записей (детерминированный порядок по relPath). */
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
  // Два пустых блока — признак конца архива.
  parts.push(Buffer.alloc(BLOCK_SIZE * 2));
  return Buffer.concat(parts);
}

/** Собирает gzip-сжатый tar из записей. */
export async function createTarGz(
  entries: readonly ArchiveEntry[],
): Promise<Buffer> {
  return gzipSync(createTar(entries));
}