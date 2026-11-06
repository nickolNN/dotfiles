const MAX_DETAIL_LENGTH = 500;
const BODY_UNAVAILABLE = '(body unavailable)';

export function errorDetail(body: string): string {
  return (body || BODY_UNAVAILABLE).slice(0, MAX_DETAIL_LENGTH);
}

export async function failureDetail(response: Response): Promise<string> {
  return errorDetail(await response.text().catch(() => ''));
}