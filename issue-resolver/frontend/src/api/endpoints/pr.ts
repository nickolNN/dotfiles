import { API_BASE, requestJson } from './http';

interface ReviewCommentEntry {
  repo: string;
  file: string | null;
  line: number | null;
  body: string;
  author: string;
}

export async function fetchReviewComments(
  iterationId: string,
): Promise<{ comments: ReviewCommentEntry[]; errors?: string[] }> {
  return requestJson<{
    comments: ReviewCommentEntry[];
    errors?: string[];
  }>(`${API_BASE}/iterations/${iterationId}/fetch-review-comments`, {
    method: 'POST',
  });
}
