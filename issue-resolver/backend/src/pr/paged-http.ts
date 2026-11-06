export const MR_PAGE_SIZE = 100;

export const MR_MAX_PAGES = 50;

export const BITBUCKET_CLOUD_API = 'https://api.bitbucket.org/2.0';

export function apiPathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

export interface PageShape {
  items<T>(data: unknown): T[];
  next(
    data: unknown,
    pageUrl: string,
    label: string,
    collected: number,
  ): string | null;
}

function parsePageUrl(url: string, label: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new Error(`${label}: не разобран URL следующей страницы — ${url}`);
  }
}

function setStartParam(url: string, label: string, start: number): string {
  const u = parsePageUrl(url, label);
  u.searchParams.set('start', String(start));
  return u.toString();
}

function nextPageParam(url: string, label: string): string {
  const u = parsePageUrl(url, label);
  const page = Number(u.searchParams.get('page') ?? '1');
  u.searchParams.set('page', String((Number.isFinite(page) ? page : 1) + 1));
  return u.toString();
}

export const BITBUCKET_PAGES: PageShape = {
  items: <T,>(data: unknown): T[] => (data as { values?: T[] }).values ?? [],
  next: (data, pageUrl, label, collected) => {
    const page = data as {
      isLastPage?: boolean;
      nextPageStart?: number;
      next?: string;
    };
    if (page.next) return page.next;
    if (page.isLastPage === false) {
      return setStartParam(pageUrl, label, page.nextPageStart ?? collected);
    }
    return null;
  },
};

export const ARRAY_PAGES: PageShape = {
  items: <T,>(data: unknown): T[] => data as T[],
  next: (data, pageUrl, label) =>
    (data as unknown[]).length >= MR_PAGE_SIZE
      ? nextPageParam(pageUrl, label)
      : null,
};

async function fetchPageJson(
  url: string,
  headers: Record<string, string>,
  label: string,
): Promise<unknown> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`${label} failed: ${res.status} — GET ${apiPathOf(url)}`);
  }
  return res.json();
}

function paginationCapReached(label: string, firstUrl: string): Error {
  return new Error(
    `${label}: pagination cap (${MR_MAX_PAGES} pages) reached at ${apiPathOf(firstUrl)} — часть комментариев могла не прийти`,
  );
}

export async function collectPages<T>(
  firstUrl: string,
  headers: Record<string, string>,
  label: string,
  shape: PageShape = ARRAY_PAGES,
): Promise<T[]> {
  const out: T[] = [];
  let pageUrl: string | null = firstUrl;
  for (let page = 0; page < MR_MAX_PAGES && pageUrl !== null; page++) {
    const data = await fetchPageJson(pageUrl, headers, label);
    out.push(...shape.items<T>(data));
    pageUrl = shape.next(data, pageUrl, label, out.length);
  }
  if (pageUrl !== null) {
    throw paginationCapReached(label, firstUrl);
  }
  return out;
}