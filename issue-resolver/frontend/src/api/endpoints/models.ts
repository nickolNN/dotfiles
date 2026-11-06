import type { ModelDescriptor } from '@issue-resolver/shared';
import { API_BASE, requestJson } from './http';

export function getModels(): Promise<ModelDescriptor[]> {
  return requestJson<ModelDescriptor[]>(`${API_BASE}/models`);
}