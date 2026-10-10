import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SLASH_COMMANDS,
  handleBuiltinSlash,
  parseSlash,
} from '../src/pi/slash-commands';

const noResolve = async (): Promise<{ provider: string; id: string } | null> =>
  null;

describe('parseSlash', () => {
  it('разбирает /команда и аргументы (пробелы, provider/id)', () => {
    expect(parseSlash('/compact')).toEqual({ name: 'compact', args: '' });
    expect(parseSlash('  /thinking high ')).toEqual({
      name: 'thinking',
      args: 'high',
    });
    expect(parseSlash('/model anthropic/claude-sonnet')).toEqual({
      name: 'model',
      args: 'anthropic/claude-sonnet',
    });
    expect(parseSlash('/name Моя сессия')).toEqual({
      name: 'name',
      args: 'Моя сессия',
    });
  });

  it('не-slash текст и голый слеш → null', () => {
    expect(parseSlash('привет')).toBeNull();
    expect(parseSlash('/')).toBeNull();
    expect(parseSlash('   ')).toBeNull();
    expect(parseSlash('')).toBeNull();
  });
});

describe('handleBuiltinSlash', () => {
  it('неизвестное имя → not-builtin (уходит в prompt)', async () => {
    expect(await handleBuiltinSlash('mycmd', 'x', { resolveModel: noResolve })).toEqual(
      { kind: 'not-builtin' },
    );
  });

  it('/compact и /compact <инструкции> → compact', async () => {
    expect(await handleBuiltinSlash('compact', '', { resolveModel: noResolve })).toEqual({
      kind: 'handled',
      ok: true,
      command: { type: 'compact' },
    });
    expect(
      await handleBuiltinSlash('compact', 'фокус на коде', {
        resolveModel: noResolve,
      }),
    ).toEqual({
      kind: 'handled',
      ok: true,
      command: { type: 'compact', customInstructions: 'фокус на коде' },
    });
  });

  it('/thinking: без аргумента цикл, валидный → set, невалидный → ok:false', async () => {
    expect(await handleBuiltinSlash('thinking', '', { resolveModel: noResolve })).toEqual({
      kind: 'handled',
      ok: true,
      command: { type: 'cycle_thinking_level' },
    });
    expect(
      await handleBuiltinSlash('thinking', 'HIGH', { resolveModel: noResolve }),
    ).toEqual({
      kind: 'handled',
      ok: true,
      command: { type: 'set_thinking_level', level: 'high' },
    });
    const invalid = await handleBuiltinSlash('thinking', 'nope', {
      resolveModel: noResolve,
    });
    expect(invalid).toMatchObject({ kind: 'handled', ok: false, command: null });
    if (invalid.kind !== 'handled') throw new Error('expected handled');
    expect(invalid.error).toContain('nope');
  });

  it('/name: без аргумента ok:false+error, с аргументом → set_session_name', async () => {
    const missing = await handleBuiltinSlash('name', '  ', {
      resolveModel: noResolve,
    });
    expect(missing).toMatchObject({ kind: 'handled', ok: false, command: null });
    if (missing.kind !== 'handled') throw new Error('expected handled');
    expect(typeof missing.error).toBe('string');
    expect(await handleBuiltinSlash('name', ' Демо ', { resolveModel: noResolve })).toEqual(
      { kind: 'handled', ok: true, command: { type: 'set_session_name', name: 'Демо' } },
    );
  });

  it('/model: без аргумента цикл, provider/id — точный set_model', async () => {
    expect(await handleBuiltinSlash('model', '', { resolveModel: noResolve })).toEqual({
      kind: 'handled',
      ok: true,
      command: { type: 'cycle_model' },
    });
    expect(
      await handleBuiltinSlash('model', 'anthropic/claude', {
        resolveModel: noResolve,
      }),
    ).toEqual({
      kind: 'handled',
      ok: true,
      command: { type: 'set_model', provider: 'anthropic', modelId: 'claude' },
    });
  });

  it('/model <подстрока>: резолв через resolveModel; не найдено → ok:false', async () => {
    const resolveModel = async (
      query: string,
    ): Promise<{ provider: string; id: string } | null> =>
      query === 'sonnet' ? { provider: 'anthropic', id: 'claude-sonnet' } : null;

    expect(await handleBuiltinSlash('model', 'sonnet', { resolveModel })).toEqual({
      kind: 'handled',
      ok: true,
      command: {
        type: 'set_model',
        provider: 'anthropic',
        modelId: 'claude-sonnet',
      },
    });
    const missing = await handleBuiltinSlash('model', 'нетакой', { resolveModel });
    expect(missing).toMatchObject({ kind: 'handled', ok: false, command: null });
    if (missing.kind !== 'handled') throw new Error('expected handled');
    expect(missing.error).toContain('нетакой');
  });

  it('/new → new_session', async () => {
    expect(await handleBuiltinSlash('new', '', { resolveModel: noResolve })).toEqual({
      kind: 'handled',
      ok: true,
      command: { type: 'new_session' },
    });
  });

  it('cwd/resume/reload/help/copy → перехват без RPC (ok:true, не ошибка)', async () => {
    for (const name of ['cwd', 'resume', 'reload', 'help', 'copy']) {
      expect(await handleBuiltinSlash(name, '', { resolveModel: noResolve })).toEqual({
        kind: 'handled',
        ok: true,
        command: null,
      });
    }
  });

  it('каждое имя BUILTIN_SLASH_COMMANDS обрабатывается (handled)', async () => {
    for (const spec of BUILTIN_SLASH_COMMANDS) {
      const outcome = await handleBuiltinSlash(spec.name, '', {
        resolveModel: noResolve,
      });
      expect(outcome.kind).toBe('handled');
    }
  });
});