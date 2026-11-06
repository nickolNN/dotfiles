import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { JSON_PARSE_FAILED, readJsonFile, tryParseJson } from '../util/json-file';
import { asRecord } from '../util/records';
import { stringOrNull } from '../util/scalars';
import { messageOf } from '../util/errors';

const ISSUE_ROOM_PREFIX = 'issue-';

export const ROOM_LIVE_TTL_MS = 60_000;

export interface RoomCleanupResult {
  deleted_rooms: number;
  errors: string[];
}

export function roomsRootFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
  return join(agentDir, 'rooms');
}

function isRoomLive(roomDir: string, now: number): boolean {
  const agentsDir = join(roomDir, 'agents');
  let files: string[];
  try {
    files = readdirSync(agentsDir);
  } catch {
    return false;
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const record = asRecord(
      tryParseJson(readFileSync(join(agentsDir, file), 'utf8')),
    );
    if (record === null) continue;
    if (record.status === 'offline') continue;
    const lastSeen = typeof record.lastSeen === 'number' ? record.lastSeen : 0;
    if (now - lastSeen <= ROOM_LIVE_TTL_MS) return true;
  }

  return false;
}

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
        `${entry.name}: ${messageOf(error)}`,
      );
    }
  }

  clearDefaultRoomIfDeleted(roomsRoot, deleted);

  return result;
}

function clearDefaultRoomIfDeleted(
  roomsRoot: string,
  deleted: Set<string>,
): void {
  if (deleted.size === 0) return;

  const configPath = join(roomsRoot, 'config.json');
  const config = readJsonFile(configPath, asRecord);
  if (!config) return;
  const defaultRoom = stringOrNull(config.defaultRoom);
  if (!defaultRoom || !deleted.has(defaultRoom)) return;

  delete config.defaultRoom;
  try {
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  } catch {
  }
}