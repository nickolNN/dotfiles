export interface ActiveRuns {
  has(id: string): boolean;
  add(id: string): void;
  delete(id: string): void;
  first(): string | null;
}

export function skipIfActive(
  isActive: (id: string) => boolean,
  kind: string,
  issueId: string,
  trigger?: string,
): boolean {
  if (!isActive(issueId)) return false;
  console.error('agent skipped: run already active', {
    kind,
    issueId,
    trigger: trigger ?? 'manual',
  });
  return true;
}

export function createActiveRuns(): ActiveRuns {
  const active = new Set<string>();
  return {
    has: (id) => active.has(id),
    add: (id) => void active.add(id),
    delete: (id) => void active.delete(id),
    first: () => active.values().next().value ?? null,
  };
}