import type {
  CreateTagRequest,
  Tag,
  UpdateTagRequest,
} from '@issue-resolver/shared';
import { API_BASE, requestJson, requestVoid } from './http';

export function getTags(): Promise<Tag[]> {
  return requestJson<Tag[]>(`${API_BASE}/tags`);
}

export function createTag(request: CreateTagRequest): Promise<Tag> {
  return requestJson<Tag>(`${API_BASE}/tags`, { method: 'POST', json: request });
}

export function updateTag(id: string, request: UpdateTagRequest): Promise<Tag> {
  return requestJson<Tag>(`${API_BASE}/tags/${id}`, {
    method: 'PUT',
    json: request,
  });
}

export function deleteTag(id: string): Promise<void> {
  return requestVoid(`${API_BASE}/tags/${id}`, { method: 'DELETE' });
}