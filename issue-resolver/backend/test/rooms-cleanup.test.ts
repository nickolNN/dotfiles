import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import {
  cleanupAbandonedIssueRooms,
  ROOM_LIVE_TTL_MS,
  roomsRootFromEnv,
} from '../src/pi/rooms';

const ISSUE_A = 'issue-11111111-1111-1111-1111-111111111111';
const ISSUE_B = 'issue-22222222-2222-2222-2222-222222222222';
const ISSUE_LIVE = 'issue-33333333-3333-3333-3333-333333333333';
const ISSUE_STALE = 'issue-44444444-4444-4444-4444-444444444444';

function makeRoom(
  root: string,
  name: string,
  agent?: { status?: string; lastSeen?: number },
): void {
  const roomDir = join(root, name);
  if (!agent) {
    mkdirSync(roomDir, { recursive: true });
    return;
  }
  const agentsDir = join(roomDir, 'agents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, 'agent-deadbeef-1.json'),
    JSON.stringify({ id: 'agent-deadbeef-1', room: name, ...agent }),
  );
}

const tmpRoots: string[] = [];

function makeTmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
});

describe('roomsRootFromEnv', () => {
  it('PI_CODING_AGENT_DIR задан → <AGENT_DIR>/rooms', () => {
    expect(roomsRootFromEnv({ PI_CODING_AGENT_DIR: '/cfg/pi' })).toBe(
      join('/cfg/pi', 'rooms'),
    );
  });

  it('не задан → ~/.pi/agent/rooms', () => {
    expect(roomsRootFromEnv({})).toBe(join(homedir(), '.pi', 'agent', 'rooms'));
  });
});

describe('cleanupAbandonedIssueRooms', () => {
  it('удаляет issue-* без живых агентов и не трогает проектные комнаты', () => {
    const root = makeTmpRoot('ir-rooms-');
    const now = Date.now();

    makeRoom(root, ISSUE_A, { status: 'offline', lastSeen: now });
    makeRoom(root, ISSUE_B);
    makeRoom(root, ISSUE_LIVE, { status: 'idle', lastSeen: now });
    makeRoom(root, ISSUE_STALE, {
      status: 'idle',
      lastSeen: now - ROOM_LIVE_TTL_MS - 1,
    });
    makeRoom(root, 'kc_front');
    mkdirSync(join(root, 'control'), { recursive: true });
    writeFileSync(join(root, 'config.json'), '{"defaultRoom":".config"}');

    const result = cleanupAbandonedIssueRooms(root, now);

    expect(result).toEqual({ deleted_rooms: 3, errors: [] });
    expect(readdirSync(root).sort()).toEqual(
      ['config.json', 'control', 'kc_front', ISSUE_LIVE].sort(),
    );
    expect(readdirSync(join(root, ISSUE_LIVE))).toContain('agents');
  });

  it('снимает defaultRoom, указывавший на удалённую комнату', () => {
    const root = makeTmpRoot('ir-rooms-');
    makeRoom(root, ISSUE_A, { status: 'offline', lastSeen: 0 });
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ defaultRoom: ISSUE_A, keep: true }),
    );

    cleanupAbandonedIssueRooms(root);

    expect(
      JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')),
    ).toEqual({ keep: true });
  });

  it('несуществующий корень — не ошибка (0 удалённых)', () => {
    expect(
      cleanupAbandonedIssueRooms(join(tmpdir(), 'ir-rooms-missing-x')),
    ).toEqual({ deleted_rooms: 0, errors: [] });
  });
});

describe('POST /admin/cleanup-orphans — комнаты', () => {
  it('в ответе приходит deleted_rooms, брошенная комната исчезает', async () => {
    const roomsRoot = makeTmpRoot('ir-rooms-');
    const workspaceRoot = makeTmpRoot('ir-ws-');
    makeRoom(roomsRoot, ISSUE_A, { status: 'offline', lastSeen: 0 });

    const app = buildApp(createDb(':memory:'), { workspaceRoot, roomsRoot });

    const response = await app.inject({
      method: 'POST',
      url: '/issue-resolver/api/v1/admin/cleanup-orphans',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ deleted_rooms: 1, errors: [] });
    expect(readdirSync(roomsRoot)).not.toContain(ISSUE_A);

    await app.close();
  });
});