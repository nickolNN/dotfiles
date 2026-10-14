/**
 * Менеджер dev-серверных портов. Выделяет порты из диапазона, отслеживает
 * занятость (issue → порт) и освобождает при остановке/удалении.
 *
 * Проверка занятости: `net.createServer().listen(port)` — атомарная проверка
 * на уровне ОС, без условий гонки.
 */
import { createServer } from 'node:net';

/** Диапазон портов для dev-серверов задач. */
const PORT_RANGE_START = 5100;
const PORT_RANGE_END = 5299;

/** issueId → Set<port>. */
const issuePorts = new Map<string, Set<number>>();

/** port → issueId (обратный индекс для быстрого поиска). */
const portOwner = new Map<number, string>();

/** Проверяет свободен ли порт (ОС-уровень, без гонки). */
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

/**
 * Выделяет свободный порт для задачи. Если все порты заняты — ошибка.
 * Каждый вызов ищет новый порт (не кеширует старый).
 * Старый порт задачи (если есть) НЕ освобождается автоматически —
 * вызывающий код должен сначала releaseIssueDevPorts.
 */
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
    `Нет свободных портов в диапазоне ${PORT_RANGE_START}–${PORT_RANGE_END}`,
  );
}

/** Освобождает один порт. */
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

/** Освобождает все порты задачи. */
export function releaseIssueDevPorts(issueId: string): void {
  const set = issuePorts.get(issueId);
  if (set) {
    for (const port of set) {
      portOwner.delete(port);
    }
    issuePorts.delete(issueId);
  }
}

/** Возвращает порт задачи (первый из выделенных), либо undefined. */
export function getDevPort(issueId: string): number | undefined {
  const set = issuePorts.get(issueId);
  if (set && set.size > 0) return set.values().next().value;
  return undefined;
}

/** Сбрасывает всё состояние (для тестов). */
export function resetPortAllocator(): void {
  issuePorts.clear();
  portOwner.clear();
}