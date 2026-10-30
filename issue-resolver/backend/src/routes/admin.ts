import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { eq, sql, type InferSelectModel } from 'drizzle-orm';
import type { Db } from '../db/client';
import { issues } from '../db/schema';
import { cleanupAbandonedIssueRooms, roomsRootFromEnv } from '../pi/rooms';
import { removeWorkspaceDir } from '../processes/workspace-processes';
import { DEFAULT_WORKSPACE_ROOT } from '../workspace/paths';

const API_PATH = '/issue-resolver/api/v1';

interface CleanupResult {
  orphaned_workspaces: number;
  killed_processes: number;
  deleted_dirs: number;
  deleted_rooms: number;
  errors: string[];
}

export async function adminRoutes(
  app: FastifyInstance,
  db: Db,
  workspaceRoot: string = DEFAULT_WORKSPACE_ROOT,
  roomsRoot: string = roomsRootFromEnv(),
): Promise<void> {
  app.post(`${API_PATH}/admin/cleanup-orphans`, async (_request, reply) => {
    const result: CleanupResult = {
      orphaned_workspaces: 0,
      killed_processes: 0,
      deleted_dirs: 0,
      deleted_rooms: 0,
      errors: [],
    };

    const activeIds = new Set(
      db
        .select({ id: issues.id })
        .from(issues)
        .all()
        .map((row) => row.id),
    );

    let dirs: string[];
    try {
      dirs = readdirSync(workspaceRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return reply.status(500).send({ error: 'cannot read workspace root' });
    }

    for (const dir of dirs) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dir)) {
        continue;
      }
      if (activeIds.has(dir)) continue;

      result.orphaned_workspaces += 1;
      const wsPath = join(workspaceRoot, dir);

      try {
        const { killed } = await removeWorkspaceDir(wsPath);
        result.killed_processes += killed.length;
        result.deleted_dirs += 1;
      } catch (error) {
        result.errors.push(
          `${dir}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const rooms = cleanupAbandonedIssueRooms(roomsRoot);
    result.deleted_rooms = rooms.deleted_rooms;
    result.errors.push(...rooms.errors.map((e) => `rooms/${e}`));

    return result;
  });
}