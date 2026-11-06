import { asRecord } from '../util/records';
import { stringOrNull } from '../util/scalars';

export interface BitbucketCloneLink {
  name: string;
  href: string;
}

export function bitbucketAuthHeaders(
  token: string,
  username: string,
  password: string,
): Record<string, string> {
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  if (username) {
    const basic = Buffer.from(`${username}:${password}`).toString('base64');
    return { Authorization: `Basic ${basic}` };
  }
  return {};
}

export function cloneLinks(
  value: unknown,
): BitbucketCloneLink[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const name = stringOrNull(record?.name);
    const href = stringOrNull(record?.href);
    return name !== null && href !== null ? [{ name, href }] : [];
  });
}

export function cloneHref(
  links: BitbucketCloneLink[] | undefined,
  name: string,
): string | null {
  return links?.find((link) => link.name === name)?.href ?? null;
}