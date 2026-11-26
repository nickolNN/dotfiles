import { PipelineStep } from '@issue-resolver/shared';
import { describe, expect, it } from 'vitest';
import roundExtension, {
  roundOutcome,
  type RoundCtx,
  type RoundToolDefinition,
} from '../src/pi/round-extension';
import { roundExtensionPath, sessionArgs } from '../src/pi/rpc-spawn';
import { roundStep } from '../src/pi/tool-policy';

function ctx(answer: string | undefined, hasUI = true): RoundCtx {
  return { hasUI, ui: { editor: async () => answer } };
}

describe('round tool: один раунд за вызов', () => {
  it('returns the edited round text', async () => {
    const out = await roundOutcome({ body: 'Q1?' }, ctx('Q1? yes'));
    expect(out.content[0]?.text).toBe('Q1? yes');
    expect(out.details.answered).toBe(true);
    expect(out.isError).toBeFalsy();
  });

  it('passes title and body to the editor as prefill', async () => {
    let seen: { title: string; prefill?: string } | undefined;
    const capture: RoundCtx = {
      hasUI: true,
      ui: {
        editor: async (title, prefill) => {
          seen = { title, prefill };
          return 'answered';
        },
      },
    };
    await roundOutcome({ title: 'Round 1', body: 'Q1?\n➡️ yes' }, capture);
    expect(seen).toEqual({ title: 'Round 1', prefill: 'Q1?\n➡️ yes' });
  });

  it('defaults the title when omitted', async () => {
    let seen: string | undefined;
    const capture: RoundCtx = {
      hasUI: true,
      ui: {
        editor: async (title) => {
          seen = title;
          return 'a';
        },
      },
    };
    await roundOutcome({ body: 'Q1?' }, capture);
    expect(seen).toBe('Refine round');
  });

  it('marks cancellation when the editor resolves undefined', async () => {
    const out = await roundOutcome({ body: 'Q1?' }, ctx(undefined));
    expect(out.details.cancelled).toBe(true);
    expect(out.isError).toBeFalsy();
  });

  it('errors without dialog UI', async () => {
    const out = await roundOutcome({ body: 'Q1?' }, ctx('x', false));
    expect(out.isError).toBe(true);
    expect(out.details.error).toBe('no-ui');
  });

  it('registers a tool named round', () => {
    let registered: RoundToolDefinition | undefined;
    roundExtension({
      registerTool: (tool) => {
        registered = tool;
      },
    });
    expect(registered?.name).toBe('round');
    expect(registered?.parameters).toMatchObject({ required: ['body'] });
  });
});

describe('round step wiring', () => {
  it('is refine only', () => {
    expect(roundStep(PipelineStep.refine)).toBe(true);
    expect(roundStep(PipelineStep.resolve)).toBe(false);
    expect(roundStep(PipelineStep.review)).toBe(false);
    expect(roundStep(PipelineStep.test)).toBe(false);
  });

  it('resolves the extension file', () => {
    expect(roundExtensionPath()).not.toBeNull();
  });

  it('sessionArgs loads the extension for a round step', () => {
    const args = sessionArgs({ round: true });
    const flag = args.indexOf('--extension');
    expect(flag).toBeGreaterThanOrEqual(0);
    expect(args[flag + 1]).toContain('round-extension');
  });

  it('sessionArgs omits the extension otherwise', () => {
    expect(sessionArgs({})).not.toContain('--extension');
  });
});
