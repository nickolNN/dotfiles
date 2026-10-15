/**
 * Читает тело SSE-ответа до первого блока `data:` и возвращает его целиком.
 *
 * Ответ начинается со стартового комментария `: connected` (см. `openSse` в
 * `src/routes/stream.ts`), поэтому первый chunk — не событие. На границу чанков
 * полагаться нельзя: комментарий и событие могут прийти одним куском, так что
 * собираем буфер и отрезаем всё до первого `data: `.
 */
export async function readSseData(reader: {
  read(): Promise<{ value?: Uint8Array; done: boolean }>;
}): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    const start = buffer.indexOf('data: ');
    if (start !== -1) return buffer.slice(start);
    if (done) return buffer;
  }
}