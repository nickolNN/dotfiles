import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb, dbPathFromEnv } from './db/client';
import { reconcileInterruptedRuns } from './db/reconcile';
import { buildDepsFromEnv } from './deps';

const config = loadConfig();
for (const [key, val] of Object.entries(config)) {
  if (val && !process.env[key]) process.env[key] = val;
}

const DEFAULT_PORT = 8080;
const HOST = '127.0.0.1';

const port = Number(process.env.PORT) || DEFAULT_PORT;

const db = createDb(dbPathFromEnv(process.env));
reconcileInterruptedRuns(db);

const app = buildApp(db, buildDepsFromEnv(process.env));

try {
  await app.listen({ host: HOST, port });
} catch (error) {
  console.error(error);
  process.exit(1);
}