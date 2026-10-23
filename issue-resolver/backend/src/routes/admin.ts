import { execSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { eq, sql, type InferSelectModel } from 'drizzle-orm';
import type { Db } from '../db/client';
import { issues } from '../db/schema';
import { cleanupAbandonedIssueRooms, roomsRootFromEnv } from '../pi/rooms';
import { DEFAULT_WORKSPACE_ROOT } from '../workspace/paths';

const API_PATH = '/issue-resolver/api/v1';

interface CleanupResult {
  orphaned_workspaces: number;
  killed_processes: number;
  deleted_dirs: number;
  /** Брошенные комнаты задач (`issue-*` без живых агентов). */
  deleted_rooms: number;
  errors: string[];
}

/**
 * Находит орфанед-воркспейсы (папки на диске без живой записи в БД),
 * убивает прибитые к ним процессы и удаляет сами папки. Заодно убирает
 * брошенные комнаты задач (`issue-*` без живых агентов).
 */
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

    // Все issue id из БД, у которых статус != 'deleted'.
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
      // UUID workspace-папок: 8-4-4-4-12 символов + дефисы.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dir)) {
        continue;
      }
      if (activeIds.has(dir)) continue;

      result.orphaned_workspaces += 1;
      const wsPath = join(workspaceRoot, dir);

      // Убиваем процессы, привязанные к этой папке (cwd или cmdline).
      try {
        const killed = execSync(
          `killed=0; ` +
          // Процессы, чей cwd внутри wsPath.
          `for p in /proc/*/cwd; do ` +
          `  cwd=$(readlink "$p" 2>/dev/null || true); ` +
          `  case "$cwd" in ${wsPath}*) pid=$(echo "$p" | grep -oE '[0-9]+'); kill "$pid" 2>/dev/null && killed=$((killed+1)) || true;; ` +
          `  esac; ` +
          `done; ` +
          // Процессы, у которых wsPath в cmdline.
          `killed2=$(pkill -f '${wsPath}' -c 2>/dev/null || echo 0); ` +
          `echo $((killed + killed2))`,
          { encoding: 'utf-8', timeout: 5_000 },
        ).trim();
        result.killed_processes += Number.parseInt(killed, 10) || 0;
      } catch {
        // pkill -c вернул ненулевой код: процессов не найдено — это нормально.
        // execSync кидает ошибку, но результат уже записан в stdout.
      }

      // Ждём и добиваем SIGKILL.
      try {
        execSync(`sleep 0.5; pkill -9 -f '${wsPath}' 2>/dev/null || true`, {
          timeout: 3_000,
        });
      } catch {
        // sleep/pkill killed сигналом при timeout — ok.
      }

      // Удаляем папку.
      try {
        await rm(wsPath, { recursive: true, force: true });
        result.deleted_dirs += 1;
      } catch (error) {
        result.errors.push(
          `${dir}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Комнаты задач живут вне workspaceRoot, поэтому чистим отдельно и
    // best-effort: их отсутствие/недоступность не роняет уборку.
    const rooms = cleanupAbandonedIssueRooms(roomsRoot);
    result.deleted_rooms = rooms.deleted_rooms;
    result.errors.push(...rooms.errors.map((e) => `rooms/${e}`));

    return result;
  });
}