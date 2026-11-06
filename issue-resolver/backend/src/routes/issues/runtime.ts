import { eq } from 'drizzle-orm';
import type { IssuesContext } from './context';
import { issues } from '../../db/schema';
import { releaseIssueDevPorts } from '../../port-allocator';
import { containerNameFor } from '../../workspace/paths';
import { ROUTE_PATH } from './paths';
import { notFound } from '../params';

export function registerIssueRuntime(ctx: IssuesContext): void {
  const { app, db, deps, service, config } = ctx;

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/container-stats`,
    async (request, reply) => {
      const { id } = request.params;
      if (!service.getIssue(db, config, id)) {
        return notFound(reply, 'issue not found');
      }

      const containerName = containerNameFor(id);
      try {
        return await deps.container.stats(containerName);
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === 404) {
          return { containerName, error: 'container_not_found' };
        }
        console.error('container stats failed', error);
        return {
          containerName,
          cpuPercent: null,
          memoryUsageBytes: 0,
          memoryLimitBytes: 0,
          pids: 0,
        };
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/stop-dev-servers`,
    async (request, reply) => {
      const { id } = request.params;
      const issue = service.getIssue(db, config, id);
      if (!issue) {
        return notFound(reply, 'issue not found');
      }

      const pid =
        db
          .select({ dev_server_pid: issues.dev_server_pid })
          .from(issues)
          .where(eq(issues.id, id))
          .get()?.dev_server_pid ?? null;
      if (pid) {
        const signal = (sig: NodeJS.Signals): void => {
          try {
            process.kill(-pid, sig);
          } catch {
            try {
              process.kill(pid, sig);
            } catch (error) {
              void error;
            }
          }
        };
        signal('SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 500));
        signal('SIGKILL');
      }

      releaseIssueDevPorts(id);
      db.update(issues)
        .set({ dev_server_port: null, dev_server_pid: null })
        .where(eq(issues.id, id))
        .run();

      return { ok: true };
    },
  );
}
