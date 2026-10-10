import { buildApp } from './app';
import { createDb } from './db/client';
import { reconcileInterruptedRuns } from './db/reconcile';
import { buildDepsFromEnv } from './deps';

const DEFAULT_PORT = 8080;
const HOST = '0.0.0.0';

const port = Number(process.env.PORT) || DEFAULT_PORT;

const db = createDb();
reconcileInterruptedRuns(db);

const app = buildApp(db, buildDepsFromEnv(process.env));

try {
  await app.listen({ host: HOST, port });
} catch (error) {
  console.error(error);
  process.exit(1);
}