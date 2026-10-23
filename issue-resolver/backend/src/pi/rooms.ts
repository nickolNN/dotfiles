/**
 * Уборка брошенных комнат pi-агентов (`<agentDir>/rooms`).
 *
 * Комнату создаёт расширение `pi-agents-talk-to-each-other`; при выходе агента
 * она НЕ удаляется — `disconnect()` лишь помечает запись `agents/<id>.json`
 * как `status: "offline"`. Из-за этого каталог комнаты переживает завершение
 * задачи, и список комнат копит мусор. Здесь — серверная уборка: комната задачи
 * (`issue-<uuid>`, такие спавнит `rpc-runner`) без живых агентов удаляется.
 *
 * Живой агент — запись без `status: "offline"` и со свежим `lastSeen`
 * (расширение шлёт heartbeat каждые 2 с, см. `HEARTBEAT_MS`).
 */
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Комнаты задач: `roomDir(room)` для `room = issue-<issueId>`. */
const ISSUE_ROOM_PREFIX = 'issue-';

/**
 * Порог «свежести» heartbeat. У расширения TTL 30 с; здесь запас ×2, чтобы
 * уборка не снесла комнату живого агента на коротком лаге.
 */
export const ROOM_LIVE_TTL_MS = 60_000;

export interface RoomCleanupResult {
  deleted_rooms: number;
  errors: string[];
}

interface AgentRecord {
  status?: string;
  lastSeen?: number;
}

/**
 * Корень комнат по конвенции pi: `PI_CODING_AGENT_DIR` (иначе `~/.pi/agent`)
 * + `/rooms` — ровно как `getAgentDir()` в расширении.
 */
export function roomsRootFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
  return join(agentDir, 'rooms');
}

/** Есть ли в комнате хоть один агент, который жив прямо сейчас. */
function isRoomLive(roomDir: string, now: number): boolean {
  const agentsDir = join(roomDir, 'agents');
  let files: string[];
  try {
    files = readdirSync(agentsDir);
  } catch {
    return false; // нет каталога agents — комнату создавали впустую
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    let record: AgentRecord;
    try {
      record = JSON.parse(
        readFileSync(join(agentsDir, file), 'utf8'),
      ) as AgentRecord;
    } catch {
      continue; // битая запись не считается живым агентом
    }
    if (record.status === 'offline') continue;
    const lastSeen = typeof record.lastSeen === 'number' ? record.lastSeen : 0;
    if (now - lastSeen <= ROOM_LIVE_TTL_MS) return true;
  }

  return false;
}

/**
 * Удаляет брошенные комнаты задач: `issue-*` без живых агентов. Комнаты с
 * живым агентом и не-`issue-` комнаты (проектные: `code`, `kc_*`, ...) не
 * трогаются. Отсутствие корня комнат — не ошибка (уборка best-effort).
 */
export function cleanupAbandonedIssueRooms(
  roomsRoot: string,
  now: number = Date.now(),
): RoomCleanupResult {
  const result: RoomCleanupResult = { deleted_rooms: 0, errors: [] };
  const deleted = new Set<string>();

  let entries;
  try {
    entries = readdirSync(roomsRoot, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(ISSUE_ROOM_PREFIX)) continue;

    const roomDir = join(roomsRoot, entry.name);
    if (isRoomLive(roomDir, now)) continue;

    try {
      rmSync(roomDir, { recursive: true, force: true });
      deleted.add(entry.name);
      result.deleted_rooms += 1;
    } catch (error) {
      result.errors.push(
        `${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  clearDefaultRoomIfDeleted(roomsRoot, deleted);

  return result;
}

/**
 * Если `defaultRoom` указывал на удалённую комнату, снимаем его — иначе
 * расширение попытается подключиться к несуществующей комнате (оно, впрочем,
 * пересоздаст её через `ensureRoom`). Каталог `control/` и прочие записи
 * `config.json` не трогаем.
 */
function clearDefaultRoomIfDeleted(
  roomsRoot: string,
  deleted: Set<string>,
): void {
  if (deleted.size === 0) return;

  const configPath = join(roomsRoot, 'config.json');
  let config: { defaultRoom?: string };
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      defaultRoom?: string;
    };
  } catch {
    return;
  }
  if (!config.defaultRoom || !deleted.has(config.defaultRoom)) return;

  delete config.defaultRoom;
  try {
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  } catch {
    // best-effort: конфиг необязателен
  }
}