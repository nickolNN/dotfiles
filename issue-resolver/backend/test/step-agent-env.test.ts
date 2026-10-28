import { describe, expect, it } from 'vitest';
import { stepAgentEnv } from '../src/pi/rpc-runner';

describe('stepAgentEnv', () => {
  it('не наследует идентичность сессии и модель запускающего', () => {
    const env = stepAgentEnv(
      {
        PATH: '/usr/bin',
        PI_CODING_AGENT_DIR: '/home/agent/.pi/agent',
        PI_SESSION_FILE: '/home/agent/.pi/agent/sessions/foreign.jsonl',
        PI_SESSION_ID: '01a17c93',
        PI_SESSION_NAME: 'launcher',
        PI_MODEL: 'deepseek-v4.1-flash',
        PI_PROVIDER: 'custom',
      },
      'issue-123',
    );

    expect(env.PI_SESSION_FILE).toBeUndefined();
    expect(env.PI_SESSION_ID).toBeUndefined();
    expect(env.PI_SESSION_NAME).toBeUndefined();
    expect(env.PI_MODEL).toBeUndefined();
    expect(env.PI_PROVIDER).toBeUndefined();
    expect(env.PI_CODING_AGENT_DIR).toBe('/home/agent/.pi/agent');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.PI_AGENT_ROOM).toBe('issue-123');
  });

  it('не мутирует исходный env и не наследует комнату запускающего', () => {
    const base = { PI_SESSION_FILE: '/tmp/s.jsonl', PI_AGENT_ROOM: 'dotfiles' };

    const env = stepAgentEnv(base);

    expect(base.PI_SESSION_FILE).toBe('/tmp/s.jsonl');
    expect(env.PI_SESSION_FILE).toBeUndefined();
    expect(env.PI_AGENT_ROOM).toBeUndefined();
  });

  it('не ходит в pi.dev: каталог и версия отключены, телеметрия выключена', () => {
    const env = stepAgentEnv({ PATH: '/usr/bin' });

    expect(env.PI_OFFLINE).toBe('1');
    expect(env.PI_SKIP_VERSION_CHECK).toBe('1');
    expect(env.PI_TELEMETRY).toBe('0');
  });
});
