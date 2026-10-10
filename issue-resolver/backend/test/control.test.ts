import type { ControlResult, PromptMode } from '@issue-resolver/shared';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import {
  InMemoryStepSessionRegistry,
  type StepSessionControl,
} from '../src/pi/session-registry';
import { BUILTIN_SLASH_COMMANDS } from '../src/pi/slash-commands';

const BASE = '/issue-resolver/api/v1/iterations';

/** Control-шпион: фиксирует prompt/send и отдаёт заранее заданные ответы. */
function makeControl(options?: {
  onSend?: (command: Record<string, unknown>) => ControlResult;
}): {
  control: StepSessionControl;
  prompts: Array<{ message: string; mode?: PromptMode }>;
  commands: Array<Record<string, unknown>>;
} {
  const prompts: Array<{ message: string; mode?: PromptMode }> = [];
  const commands: Array<Record<string, unknown>> = [];
  return {
    control: {
      steer: () => undefined,
      abort: () => undefined,
      respond: () => undefined,
      prompt: (message, mode) => {
        prompts.push({ message, ...(mode ? { mode } : {}) });
        return Promise.resolve({ ok: true, disposition: 'started' });
      },
      send: (command) => {
        commands.push(command);
        return Promise.resolve(options?.onSend?.(command) ?? { ok: true });
      },
    },
    prompts,
    commands,
  };
}

describe('POST /iterations/:id/prompt', () => {
  it('нет сессии → 409', async () => {
    const app = buildApp(createDb(':memory:'), {
      control: new InMemoryStepSessionRegistry(),
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `${BASE}/it1/prompt`,
        payload: { message: 'привет' },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'no active step session' });
    } finally {
      await app.close();
    }
  });

  it('пустой message → 400; невалидный mode → 400', async () => {
    const registry = new InMemoryStepSessionRegistry();
    registry.register('run-1', 'it1', makeControl().control);
    const app = buildApp(createDb(':memory:'), { control: registry });
    try {
      const empty = await app.inject({
        method: 'POST',
        url: `${BASE}/it1/prompt`,
        payload: { message: '   ' },
      });
      expect(empty.statusCode).toBe(400);

      const badMode = await app.inject({
        method: 'POST',
        url: `${BASE}/it1/prompt`,
        payload: { message: 'ок', mode: 'nope' },
      });
      expect(badMode.statusCode).toBe(400);
      expect(badMode.json()).toEqual({ error: 'invalid mode' });
    } finally {
      await app.close();
    }
  });

  it('валидный prompt → PromptResult, mode уходит в control', async () => {
    const registry = new InMemoryStepSessionRegistry();
    const spy = makeControl();
    registry.register('run-1', 'it1', spy.control);
    const app = buildApp(createDb(':memory:'), { control: registry });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `${BASE}/it1/prompt`,
        payload: { message: 'уточни', mode: 'followUp' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, disposition: 'started' });
      expect(spy.prompts).toEqual([{ message: 'уточни', mode: 'followUp' }]);
    } finally {
      await app.close();
    }
  });
});

describe('GET /iterations/:id/control', () => {
  it('нет сессии → 409', async () => {
    const app = buildApp(createDb(':memory:'), {
      control: new InMemoryStepSessionRegistry(),
    });
    try {
      const response = await app.inject({ method: 'GET', url: `${BASE}/it1/control` });
      expect(response.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it('собирает snapshot из get_state/models/levels/commands', async () => {
    const registry = new InMemoryStepSessionRegistry();
    const spy = makeControl({
      onSend: (command) => {
        switch (command.type) {
          case 'get_state':
            return {
              ok: true,
              data: {
                model: {
                  id: 'claude-sonnet-4',
                  name: 'Claude Sonnet 4',
                  provider: 'anthropic',
                },
                thinkingLevel: 'high',
                steeringMode: 'all',
                followUpMode: 'one-at-a-time',
                autoCompactionEnabled: true,
                isStreaming: true,
                sessionName: 'моя сессия',
              },
            };
          case 'get_available_models':
            return {
              ok: true,
              data: {
                models: [
                  { id: 'm1', name: 'Model 1', provider: 'p1', extra: 'ignored' },
                  { id: 'm2', provider: 'p2' },
                  { name: 'no id' },
                ],
              },
            };
          case 'get_available_thinking_levels':
            return { ok: true, data: { levels: ['off', 'high'] } };
          case 'get_commands':
            return {
              ok: true,
              data: {
                commands: [
                  { name: 'fix', description: 'fix it', source: 'prompt' },
                  { name: 'ext', source: 'extension' },
                  { name: 'skill:foo', source: 'skill' },
                  { name: 'weird', source: 'tool' },
                  { source: 'prompt' },
                ],
              },
            };
          default:
            return { ok: true };
        }
      },
    });
    registry.register('run-1', 'it1', spy.control);
    const app = buildApp(createDb(':memory:'), { control: registry });
    try {
      const response = await app.inject({ method: 'GET', url: `${BASE}/it1/control` });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({
        state: {
          model: 'Claude Sonnet 4',
          provider: 'anthropic',
          modelId: 'claude-sonnet-4',
          thinkingLevel: 'high',
          steeringMode: 'all',
          followUpMode: 'one-at-a-time',
          autoCompactionEnabled: true,
          autoRetryEnabled: null,
          isStreaming: true,
          sessionName: 'моя сессия',
        },
        models: [
          { provider: 'p1', id: 'm1', name: 'Model 1' },
          { provider: 'p2', id: 'm2' },
        ],
        thinkingLevels: ['off', 'high'],
      });
      // Встроенные команды идут первыми (source:'builtin'), затем get_commands.
      expect(body.commands).toEqual([
        ...BUILTIN_SLASH_COMMANDS.map((command) => ({
          name: command.name,
          description: command.description,
          ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
          source: 'builtin',
        })),
        { name: 'fix', description: 'fix it', source: 'prompt' },
        { name: 'ext', source: 'extension' },
        { name: 'skill:foo', source: 'skill' },
        { name: 'weird', source: 'extension' },
      ]);
      // Все четыре запроса ушли в живую сессию.
      expect(spy.commands.map((c) => c.type)).toEqual([
        'get_state',
        'get_available_models',
        'get_available_thinking_levels',
        'get_commands',
      ]);
    } finally {
      await app.close();
    }
  });

  it('builtins первыми и дедуп коллизии из get_commands', async () => {
    const registry = new InMemoryStepSessionRegistry();
    const spy = makeControl({
      onSend: (command) =>
        command.type === 'get_commands'
          ? {
              ok: true,
              data: {
                commands: [
                  // Коллизия с builtin'ом — должна быть пропущена.
                  { name: 'compact', description: 'dup', source: 'prompt' },
                  { name: 'other', description: 'x', source: 'prompt' },
                ],
              },
            }
          : { ok: true, data: {} },
    });
    registry.register('run-1', 'it1', spy.control);
    const app = buildApp(createDb(':memory:'), { control: registry });
    try {
      const commands = (
        await app.inject({ method: 'GET', url: `${BASE}/it1/control` })
      ).json().commands as Array<{ name: string; source: string }>;

      const compactBuiltin = BUILTIN_SLASH_COMMANDS.find(
        (command) => command.name === 'compact',
      );
      const compact = commands.filter((command) => command.name === 'compact');
      expect(compact).toEqual([
        {
          name: 'compact',
          description: compactBuiltin?.description,
          ...(compactBuiltin?.argumentHint
            ? { argumentHint: compactBuiltin.argumentHint }
            : {}),
          source: 'builtin',
        },
      ]);
      const names = commands.map((command) => command.name);
      expect(names.indexOf('compact')).toBeLessThan(names.indexOf('other'));
      expect(names.filter((name) => name === 'other')).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('argumentHint: встроенные hints + passthrough из get_commands', async () => {
    const registry = new InMemoryStepSessionRegistry();
    const spy = makeControl({
      onSend: (command) =>
        command.type === 'get_commands'
          ? {
              ok: true,
              data: {
                commands: [
                  { name: 'tpl', source: 'prompt', argumentHint: '[x]' },
                  { name: 'nohint', source: 'prompt' },
                ],
              },
            }
          : { ok: true, data: {} },
    });
    registry.register('run-1', 'it1', spy.control);
    const app = buildApp(createDb(':memory:'), { control: registry });
    try {
      const commands = (
        await app.inject({ method: 'GET', url: `${BASE}/it1/control` })
      ).json().commands as Array<{
        name: string;
        argumentHint?: string;
        source: string;
      }>;
      const byName = new Map(commands.map((command) => [command.name, command]));

      expect(byName.get('model')?.argumentHint).toBe('[provider/id]');
      expect(byName.get('thinking')?.argumentHint).toBe(
        '[off|minimal|low|medium|high|xhigh|max]',
      );
      expect(byName.get('compact')?.argumentHint).toBe('[инструкции]');
      expect(byName.get('tpl')?.argumentHint).toBe('[x]');
      expect(byName.get('nohint')?.argumentHint).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('model без name → label = id', async () => {
    const registry = new InMemoryStepSessionRegistry();
    const spy = makeControl({
      onSend: (command) =>
        command.type === 'get_state'
          ? { ok: true, data: { model: { id: 'llama-3', provider: 'local' } } }
          : { ok: true, data: {} },
    });
    registry.register('run-1', 'it1', spy.control);
    const app = buildApp(createDb(':memory:'), { control: registry });
    try {
      const response = await app.inject({ method: 'GET', url: `${BASE}/it1/control` });
      expect(response.json().state.model).toBe('llama-3');
      expect(response.json().state.steeringMode).toBeNull();
      expect(response.json().state.autoCompactionEnabled).toBeNull();
      expect(response.json().state.sessionName).toBeNull();
    } finally {
      await app.close();
    }
  });
});

describe('POST /iterations/:id/control', () => {
  it('нет сессии → 409', async () => {
    const app = buildApp(createDb(':memory:'), {
      control: new InMemoryStepSessionRegistry(),
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `${BASE}/it1/control`,
        payload: { command: { type: 'cycle_model' } },
      });
      expect(response.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it('unknown type и невалидные поля → 400', async () => {
    const registry = new InMemoryStepSessionRegistry();
    registry.register('run-1', 'it1', makeControl().control);
    const app = buildApp(createDb(':memory:'), { control: registry });
    try {
      const unknown = await app.inject({
        method: 'POST',
        url: `${BASE}/it1/control`,
        payload: { command: { type: 'nope' } },
      });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json()).toEqual({ error: 'unknown command type' });

      const missing = await app.inject({
        method: 'POST',
        url: `${BASE}/it1/control`,
        payload: {},
      });
      expect(missing.statusCode).toBe(400);

      const badModel = await app.inject({
        method: 'POST',
        url: `${BASE}/it1/control`,
        payload: { command: { type: 'set_model', provider: 'p' } },
      });
      expect(badModel.statusCode).toBe(400);

      const badBash = await app.inject({
        method: 'POST',
        url: `${BASE}/it1/control`,
        payload: { command: { type: 'bash', command: '   ' } },
      });
      expect(badBash.statusCode).toBe(400);

      const badMode = await app.inject({
        method: 'POST',
        url: `${BASE}/it1/control`,
        payload: { command: { type: 'set_steering_mode', mode: 'x' } },
      });
      expect(badMode.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('маппит SessionCommand → pi-команды', async () => {
    const registry = new InMemoryStepSessionRegistry();
    const spy = makeControl();
    registry.register('run-1', 'it1', spy.control);
    const app = buildApp(createDb(':memory:'), { control: registry });
    try {
      const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
        [
          { type: 'set_model', provider: 'anthropic', modelId: 'm' },
          { type: 'set_model', provider: 'anthropic', modelId: 'm' },
        ],
        [{ type: 'cycle_model' }, { type: 'cycle_model' }],
        [
          { type: 'set_thinking_level', level: 'high' },
          { type: 'set_thinking_level', level: 'high' },
        ],
        [{ type: 'cycle_thinking_level' }, { type: 'cycle_thinking_level' }],
        [{ type: 'compact' }, { type: 'compact' }],
        [
          { type: 'compact', instructions: 'фокус' },
          { type: 'compact', customInstructions: 'фокус' },
        ],
        [{ type: 'clear_queue' }, { type: 'clear_queue' }],
        [
          { type: 'set_auto_compaction', enabled: false },
          { type: 'set_auto_compaction', enabled: false },
        ],
        [
          { type: 'set_auto_retry', enabled: true },
          { type: 'set_auto_retry', enabled: true },
        ],
        [{ type: 'abort_retry' }, { type: 'abort_retry' }],
        [
          { type: 'set_steering_mode', mode: 'one-at-a-time' },
          { type: 'set_steering_mode', mode: 'one-at-a-time' },
        ],
        [
          { type: 'set_follow_up_mode', mode: 'all' },
          { type: 'set_follow_up_mode', mode: 'all' },
        ],
        [{ type: 'bash', command: 'ls -la' }, { type: 'bash', command: 'ls -la' }],
        [{ type: 'abort_bash' }, { type: 'abort_bash' }],
      ];

      for (const [command] of cases) {
        const response = await app.inject({
          method: 'POST',
          url: `${BASE}/it1/control`,
          payload: { command },
        });
        expect(response.statusCode).toBe(200);
      }
      expect(spy.commands).toEqual(cases.map(([, expected]) => expected));
    } finally {
      await app.close();
    }
  });

  it('timeout от send → 504', async () => {
    const registry = new InMemoryStepSessionRegistry();
    registry.register(
      'run-1',
      'it1',
      makeControl({
        onSend: () => ({ ok: false, error: 'timeout' }),
      }).control,
    );
    const app = buildApp(createDb(':memory:'), { control: registry });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `${BASE}/it1/control`,
        payload: { command: { type: 'compact' } },
      });
      expect(response.statusCode).toBe(504);
      expect(response.json()).toEqual({ ok: false, error: 'timeout' });
    } finally {
      await app.close();
    }
  });
});

describe('POST /iterations/:id/prompt — встроенные slash-команды', () => {
  /** Control: get_available_models отдаёт модели, прочее — ok. */
  function slashControl(): ReturnType<typeof makeControl> {
    return makeControl({
      onSend: (command) =>
        command.type === 'get_available_models'
          ? {
              ok: true,
              data: {
                models: [
                  { provider: 'anthropic', id: 'claude-sonnet', name: 'Claude Sonnet' },
                ],
              },
            }
          : { ok: true },
    });
  }

  async function promptWith(
    message: string,
  ): Promise<{ status: number; body: unknown; spy: ReturnType<typeof makeControl> }> {
    const registry = new InMemoryStepSessionRegistry();
    const spy = slashControl();
    registry.register('run-1', 'it1', spy.control);
    const app = buildApp(createDb(':memory:'), { control: registry });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `${BASE}/it1/prompt`,
        payload: { message },
      });
      return { status: response.statusCode, body: response.json(), spy };
    } finally {
      await app.close();
    }
  }

  it('/compact → явная RPC-команда compact, в prompt не уходит', async () => {
    const { status, body, spy } = await promptWith('/compact');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, disposition: 'handled' });
    expect(spy.commands).toEqual([{ type: 'compact' }]);
    expect(spy.prompts).toEqual([]);
  });

  it('/compact <инструкции> → customInstructions', async () => {
    const { body, spy } = await promptWith('/compact фокус на тестах');
    expect(body).toEqual({ ok: true, disposition: 'handled' });
    expect(spy.commands).toEqual([
      { type: 'compact', customInstructions: 'фокус на тестах' },
    ]);
  });

  it('/thinking high → set_thinking_level; невалидный → перехват без RPC', async () => {
    const valid = await promptWith('/thinking high');
    expect(valid.body).toEqual({ ok: true, disposition: 'handled' });
    expect(valid.spy.commands).toEqual([
      { type: 'set_thinking_level', level: 'high' },
    ]);

    const invalid = await promptWith('/thinking nope');
    expect(invalid.body).toMatchObject({ ok: false, disposition: 'handled' });
    expect((invalid.body as { error?: string }).error).toContain('nope');
    expect(invalid.spy.commands).toEqual([]);
  });

  it('/model provider/id → set_model; /model <подстрока> → резолв', async () => {
    const exact = await promptWith('/model anthropic/claude-sonnet');
    expect(exact.spy.commands).toEqual([
      { type: 'set_model', provider: 'anthropic', modelId: 'claude-sonnet' },
    ]);

    const resolved = await promptWith('/model sonnet');
    expect(resolved.spy.commands).toEqual([
      { type: 'get_available_models' },
      { type: 'set_model', provider: 'anthropic', modelId: 'claude-sonnet' },
    ]);

    const unknown = await promptWith('/model unknownzzz');
    expect(unknown.body).toMatchObject({ ok: false, disposition: 'handled' });
    expect((unknown.body as { error?: string }).error).toContain('unknownzzz');
    expect(unknown.spy.commands).toEqual([{ type: 'get_available_models' }]);
  });

  it('/name → set_session_name или error; /help → noop ok:true', async () => {
    const named = await promptWith('/name Демо');
    expect(named.body).toEqual({ ok: true, disposition: 'handled' });
    expect(named.spy.commands).toEqual([
      { type: 'set_session_name', name: 'Демо' },
    ]);

    const noArg = await promptWith('/name');
    expect(noArg.body).toMatchObject({ ok: false, disposition: 'handled' });
    expect((noArg.body as { error?: string }).error).toBeTruthy();
    expect(noArg.spy.commands).toEqual([]);

    const help = await promptWith('/help');
    expect(help.body).toEqual({ ok: true, disposition: 'handled' });
    expect(help.spy.commands).toEqual([]);
    expect(help.spy.prompts).toEqual([]);
  });

  it('не-встроенная /mycmd уходит в prompt (раскрывает pi)', async () => {
    const { body, spy } = await promptWith('/mycmd аргумент');
    expect(body).toEqual({ ok: true, disposition: 'started' });
    expect(spy.prompts).toEqual([{ message: '/mycmd аргумент' }]);
    expect(spy.commands).toEqual([]);
  });

  it('встроенная команда без живой сессии → 409', async () => {
    const app = buildApp(createDb(':memory:'), {
      control: new InMemoryStepSessionRegistry(),
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `${BASE}/it1/prompt`,
        payload: { message: '/compact' },
      });
      expect(response.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });
});