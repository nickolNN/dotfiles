import { createServer } from 'node:net';

export const PORT_RANGE_START = 5100;
export const PORT_RANGE_END = 5299;

export const PORT_RANGE_LABEL = `${PORT_RANGE_START}–${PORT_RANGE_END}`;

const issuePorts = new Map<string, Set<number>>();

const portOwner = new Map<number, string>();

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

export async function allocateDevPort(
  issueId: string,
): Promise<number> {
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (portOwner.has(port)) continue;
    if (await isPortFree(port)) {
      const set = issuePorts.get(issueId) ?? new Set();
      set.add(port);
      issuePorts.set(issueId, set);
      portOwner.set(port, issueId);
      return port;
    }
  }

  throw new Error(
    `Нет свободных портов в диапазоне ${PORT_RANGE_LABEL}`,
  );
}

export async function reserveDevPort(
  issueId: string,
  port: number,
): Promise<boolean> {
  const owner = portOwner.get(port);
  if (owner !== undefined && owner !== issueId) return false;
  if (!(await isPortFree(port))) return false;
  const set = issuePorts.get(issueId) ?? new Set<number>();
  set.add(port);
  issuePorts.set(issueId, set);
  portOwner.set(port, issueId);
  return true;
}

export function releaseDevPort(port: number): void {
  const owner = portOwner.get(port);
  if (owner) {
    const set = issuePorts.get(owner);
    if (set) {
      set.delete(port);
      if (set.size === 0) issuePorts.delete(owner);
    }
    portOwner.delete(port);
  }
}

export function releaseIssueDevPorts(issueId: string): void {
  const set = issuePorts.get(issueId);
  if (set) {
    for (const port of set) {
      portOwner.delete(port);
    }
    issuePorts.delete(issueId);
  }
}

export function getDevPort(issueId: string): number | undefined {
  const set = issuePorts.get(issueId);
  if (set && set.size > 0) return set.values().next().value;
  return undefined;
}

export function resetPortAllocator(): void {
  issuePorts.clear();
  portOwner.clear();
}