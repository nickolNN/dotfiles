// Импорт только типов: подтягивает аугментацию FastifyRequest (isMultipart/parts).
import type {} from '@fastify/multipart';
import type { FastifyRequest } from 'fastify';
import type { UploadInput } from '../workspace/attachments';

/** JSON-тело создания задачи/итерации в multipart-запросе. */
const PAYLOAD_FIELD = 'payload';
/** Имя файлового поля (повторяется на каждый файл). */
const FILES_FIELD = 'files';

export type RequestPayload =
  | { ok: true; body: unknown; files: UploadInput[] }
  | { ok: false; error: string };

/**
 * Тело запроса создания: обычный `application/json` отдаётся как есть (файлов
 * нет), а `multipart/form-data` разбирается на JSON-строку в поле `payload` и
 * повторяющиеся файловые поля `files`. JSON-путь не меняет поведение.
 */
export async function readRequestPayload(
  request: FastifyRequest,
): Promise<RequestPayload> {
  if (!request.isMultipart()) {
    return { ok: true, body: request.body, files: [] };
  }

  let payload: string | undefined;
  const files: UploadInput[] = [];
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      // Файловые части дренируем всегда, сохраняем только поле `files`.
      const buffer = await part.toBuffer();
      if (part.fieldname === FILES_FIELD) {
        files.push({
          filename: part.filename,
          mimetype: part.mimetype,
          buffer,
        });
      }
      continue;
    }
    if (part.fieldname === PAYLOAD_FIELD) {
      payload =
        typeof part.value === 'string' ? part.value : JSON.stringify(part.value);
    }
  }

  if (payload === undefined) {
    return {
      ok: false,
      error: `multipart: отсутствует поле ${PAYLOAD_FIELD} с JSON-телом`,
    };
  }

  try {
    return { ok: true, body: JSON.parse(payload), files };
  } catch {
    return {
      ok: false,
      error: `multipart: поле ${PAYLOAD_FIELD} не является валидным JSON`,
    };
  }
}