import { API_BASE, requestJsonOrNull, requestVoid } from './http';

export async function getHostname(): Promise<string> {
  const data = await requestJsonOrNull<{ hostname?: string }>(
    `${API_BASE}/settings/hostname`,
  );
  return data?.hostname ?? '';
}

export function setHostname(hostname: string): Promise<void> {
  return requestVoid(`${API_BASE}/settings/hostname`, {
    method: 'PUT',
    json: { hostname },
  });
}
