import type {} from '@fastify/multipart';
import type { FastifyRequest } from 'fastify';
import type { UploadInput } from '../workspace/attachments';
import { JSON_PARSE_FAILED, tryParseJson } from '../util/json-file';

const PAYLOAD_FIELD = 'payload';
const FILES_FIELD = 'files';

export type RequestPayload =
  | { ok: true; body: unknown; files: UploadInput[] }
  | { ok: false; error: string };

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

  const body = tryParseJson(payload);
  if (body === JSON_PARSE_FAILED) {
    return {
      ok: false,
      error: `multipart: поле ${PAYLOAD_FIELD} не является валидным JSON`,
    };
  }
  return { ok: true, body, files };
}