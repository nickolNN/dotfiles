import type { FastifyInstance } from 'fastify';
import { PromptDisposition, PromptMode } from '@issue-resolver/shared';
import {
  SlashOutcomeKind,
  handleBuiltinSlash,
  parseSlash,
} from '../pi/slash-commands';
import {
  iterationTarget,
  type StepSessionRegistry,
} from '../pi/session-registry';
import { asRecord } from '../util/records';
import {
  buildSnapshot,
  mapCommand,
  resolveModelByQuery,
} from './control/mapping';
import { badRequest, conflict } from './params';

const CONTROL_PATH = '/issue-resolver/api/v1/iterations';

const NO_SESSION = 'no active step session';

const modeOf = (value: unknown): PromptMode | undefined =>
  value === PromptMode.steer || value === PromptMode.followUp
    ? value
    : undefined;

export async function controlRoutes(
  app: FastifyInstance,
  control: StepSessionRegistry,
): Promise<void> {
  app.post<{
    Params: { id: string };
    Body: { message?: unknown; mode?: unknown };
  }>(`${CONTROL_PATH}/:id/prompt`, async (request, reply) => {
    const message = request.body?.message;
    if (typeof message !== 'string' || message.trim().length === 0) {
      return badRequest(reply, 'message is required');
    }

    const modeRaw = request.body?.mode;
    if (modeRaw !== undefined && modeOf(modeRaw) === undefined) {
      return badRequest(reply, 'invalid mode');
    }
    const mode = modeOf(modeRaw);
    const { id } = request.params;

    if (!control.hasByIteration(id)) {
      return conflict(reply, NO_SESSION);
    }

    const slash = parseSlash(message);
    if (slash) {
      const outcome = await handleBuiltinSlash(slash.name, slash.args, {
        resolveModel: (query) => resolveModelByQuery(control, id, query),
      });
      if (outcome.kind === SlashOutcomeKind.handled) {
        if (outcome.command === null) {
          return {
            ok: outcome.ok,
            disposition: PromptDisposition.handled,
            ...(outcome.error ? { error: outcome.error } : {}),
          };
        }
        const sent = await control.send(iterationTarget(id), outcome.command);
        if (sent === null) {
          return conflict(reply, NO_SESSION);
        }
        if (!sent.ok) {
          return {
            ok: false,
            disposition: PromptDisposition.handled,
            ...(sent.error ? { error: sent.error } : {}),
          };
        }
        return { ok: true, disposition: PromptDisposition.handled };
      }
    }

    const result = control.prompt(iterationTarget(id), message, mode);
    if (result === null) {
      return conflict(reply, NO_SESSION);
    }
    return await result;
  });

  app.get<{ Params: { id: string } }>(
    `${CONTROL_PATH}/:id/control`,
    async (request, reply) => {
      const { id } = request.params;
      const statePromise = control.send(iterationTarget(id), { type: 'get_state' });
      if (statePromise === null) {
        return conflict(reply, NO_SESSION);
      }

      const [stateResult, modelsResult, levelsResult, commandsResult] =
        await Promise.all([
          statePromise,
          control.send(iterationTarget(id), { type: 'get_available_models' }),
          control.send(iterationTarget(id), { type: 'get_available_thinking_levels' }),
          control.send(iterationTarget(id), { type: 'get_commands' }),
        ]);

      return buildSnapshot(
        stateResult,
        modelsResult,
        levelsResult,
        commandsResult,
      );
    },
  );

  app.post<{ Params: { id: string }; Body: { command?: unknown } }>(
    `${CONTROL_PATH}/:id/control`,
    async (request, reply) => {
      const rawCommand = asRecord(request.body?.command);
      if (!rawCommand) {
        return badRequest(reply, 'command is required');
      }

      const piCommand = mapCommand(rawCommand);
      if (!piCommand) {
        return badRequest(reply, 'unknown command type');
      }

      const result = await control.send(
        iterationTarget(request.params.id),
        piCommand,
      );
      if (result === null) {
        return conflict(reply, NO_SESSION);
      }
      if (!result.ok && result.error === 'timeout') {
        return reply.status(504).send(result);
      }
      return result;
    },
  );
}