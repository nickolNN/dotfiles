const DEFAULT_GIT_TIMEOUT_MS = 300_000;

export const gitTimeoutMs = (): number => {
  const raw = Number(process.env.GIT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GIT_TIMEOUT_MS;
};

const DEFAULT_DEV_SERVER_TIMEOUT_MS = 30_000;

export const devServerTimeoutMs = (): number => {
  const raw = Number(process.env.DEV_SERVER_PORT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DEV_SERVER_TIMEOUT_MS;
};