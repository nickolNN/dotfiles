import { describe, expect, it } from 'vitest';
import { errorDetail, failureDetail } from '../src/pr/http-failure';

describe('http failure detail', () => {
  it('пустое тело не выглядит как успешный ответ', () => {
    expect(errorDetail('')).toBe('(body unavailable)');
  });

  it('тело обрезается до 500 символов', () => {
    expect(errorDetail('x'.repeat(600))).toHaveLength(500);
  });

  it('нечитаемое тело ответа даёт ту же подпись, что и пустое', async () => {
    const response = new Response('', { status: 500 });
    expect(await failureDetail(response)).toBe('(body unavailable)');
  });

  it('текст ответа попадает в деталь', async () => {
    const response = new Response('{"error":"boom"}', { status: 500 });
    expect(await failureDetail(response)).toBe('{"error":"boom"}');
  });
});