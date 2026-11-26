export interface RoundParams {
  title?: string;
  body: string;
}

export interface RoundUi {
  editor(title: string, prefill?: string): Promise<string | undefined>;
}

export interface RoundCtx {
  hasUI: boolean;
  ui: RoundUi;
}

export interface RoundOutcome {
  content: { type: 'text'; text: string }[];
  details: { answered?: boolean; cancelled?: boolean; error?: string };
  isError?: boolean;
}

export interface RoundToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: RoundParams,
    signal: unknown,
    onUpdate: unknown,
    ctx: RoundCtx,
  ): Promise<RoundOutcome>;
}

export interface RoundPi {
  registerTool(tool: RoundToolDefinition): void;
}

export async function roundOutcome(
  params: RoundParams,
  ctx: RoundCtx,
): Promise<RoundOutcome> {
  if (!ctx.hasUI) {
    return {
      content: [{ type: 'text', text: 'round: this session has no dialog UI' }],
      details: { error: 'no-ui' },
      isError: true,
    };
  }
  const answer = await ctx.ui.editor(params.title ?? 'Refine round', params.body);
  if (answer === undefined) {
    return {
      content: [
        { type: 'text', text: 'The user cancelled the round without answering.' },
      ],
      details: { cancelled: true },
    };
  }
  return {
    content: [{ type: 'text', text: answer }],
    details: { answered: true },
  };
}

export default function roundExtension(pi: RoundPi): void {
  pi.registerTool({
    name: 'round',
    label: 'Round',
    description:
      'Ask a whole round of questions at once, formatted as the grilling skill ' +
      'formats it: pass the numbered questions with their recommended answers as ' +
      '`body`. The user sees one editable dialog pre-filled with the round, edits ' +
      'in answers (or submits unchanged to accept every recommendation), and the ' +
      'tool returns their text. One call per round, not one per question.',
    promptSnippet: 'Ask a whole frontier round of questions in one editable dialog',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Dialog heading' },
        body: {
          type: 'string',
          description: 'The formatted round: numbered questions with recommended answers',
        },
      },
      required: ['body'],
    },
    execute: (_toolCallId, params, _signal, _onUpdate, ctx) =>
      roundOutcome(params, ctx),
  });
}
