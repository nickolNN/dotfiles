import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stepRunStatusFromResult } from '@issue-resolver/shared';
import { RpcPiRunner } from '../src/pi/rpc-runner';

const here = dirname(fileURLToPath(import.meta.url));
const SHIM = resolve(here, 'fixtures/fake-pi-shim.mjs');

const shimRunner = (mode: string): RpcPiRunner =>
  new RpcPiRunner('resolve', 'local', {
    piCommand: process.execPath,
    piArgs: [SHIM, mode],
  });

describe('RpcPiRunner — живой pi-процесс (shim)', () => {
  it('нормальное завершение: agent_settled → exit0, aborted нет, report не aborted', async () => {
    const result = await shimRunner('normal').run('shim-container', 'do it');

    expect(result.exitCode).toBe(0);
    expect(result.aborted).toBeUndefined();
    expect(result.report?.status).not.toBe('fail');
    expect(result.stats?.sessionId).toBe('shim-session');
    expect(stepRunStatusFromResult(result.exitCode, result.report)).toBe(
      'success',
    );
  });

  it('краш процесса без agent_settled → exitCode != 0 (report null), не виснет', async () => {
    const result = await shimRunner('crash').run('shim-container', 'do it');

    expect(result.exitCode).not.toBe(0);
    expect(result.report).toBeNull();
    expect(result.aborted).toBeUndefined();
    expect(result.stderr).toContain('shim crash');
  });

  it('agent_settled{aborted:true} → aborted:true и маппинг движка даёт aborted', async () => {
    const result = await shimRunner('aborted').run('shim-container', 'do it');

    expect(result.aborted).toBe(true);
    expect(result.report).toEqual({ status: 'fail', summary: 'aborted' });
    const mapped = result.aborted
      ? 'aborted'
      : stepRunStatusFromResult(result.exitCode, result.report);
    expect(mapped).toBe('aborted');
  });

  it('зависание + timeoutMs → промис реджектится таймаутом, не виснет', async () => {
    await expect(
      shimRunner('hang').run('shim-container', 'do it', { timeoutMs: 300 }),
    ).rejects.toThrow(/timed out after 300ms/);
  });
});