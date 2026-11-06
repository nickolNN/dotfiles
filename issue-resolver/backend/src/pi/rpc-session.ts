import type { ChildProcess } from 'node:child_process';
import {
  PromptDisposition,
  StepAgentStatus,
  promptDisposition,
  type PipelineStep,
  type PromptResult,
  type StepExecutionResult,
} from '@issue-resolver/shared';
import { RpcSessionParser } from './rpc-parser';
import { RpcChannel } from './rpc-protocol';
import {
  agentStatusFor,
  questionAnswerText,
  resultFor,
  type RpcEvent,
} from './rpc-events';
import { asRecord } from '../util/records';
import type { PiRunOptions } from './runner';

const PROMPT_COMMAND_ID = 'step-1';

const STATS_TIMEOUT_MS = 2000;

const STATS_POLL_MS = 3000;

export interface RpcSessionRun {
  child: ChildProcess;
  step: PipelineStep;
  prompt: string;
  containerName: string;
  options: PiRunOptions;
}

export function runRpcSession(run: RpcSessionRun): Promise<StepExecutionResult> {
  const { child, step, containerName, options } = run;
  return new Promise<StepExecutionResult>((resolve, reject) => {
    const { registry, stepRunId, iterationId } = options;
    let statsHandler: (() => void) | undefined;
    const parser = new RpcSessionParser({
      onStdout: options.onStdout,
      onEvent: (event) => {
        options.onEvent?.(event);
        if (registry && stepRunId) registry.recordEvent(stepRunId, event);
      },
      onStats: () => statsHandler?.(),
    });

    let stderr = '';
    let settled = false;
    let committedAbort = false;
    let timer: NodeJS.Timeout | undefined;
    let statsTimer: NodeJS.Timeout | undefined;
    let statsPollTimer: NodeJS.Timeout | undefined;
    let pendingResult: StepExecutionResult | null = null;
    let statsRequested = false;

    const channel = new RpcChannel(child.stdin, {
      onEvent: (event) => handleEvent(event),
    });

    const cleanup = (status: StepAgentStatus = StepAgentStatus.finished) => {
      if (timer) clearTimeout(timer);
      if (statsTimer) clearTimeout(statsTimer);
      if (statsPollTimer) clearInterval(statsPollTimer);
      channel.settlePending('session closed');
      if (registry && stepRunId) registry.unregister(stepRunId, status);
    };

    const finish = (result: StepExecutionResult) => {
      if (settled) return;
      settled = true;
      parser.flush();
      const finalResult: StepExecutionResult = {
        ...result,
        stdout: parser.stdout(),
        events: parser.events(),
      };
      cleanup(agentStatusFor(result));
      try {
        if (child.stdin?.writable) {
          child.stdin.write(`${JSON.stringify({ type: 'exit' })}\n`);
        }
      } catch (error) {
        console.error('pi: exit command not delivered', error);
      }
      if (!child.killed) child.kill('SIGTERM');
      resolve(finalResult);
    };

    const finalizeWithStats = () => {
      if (settled || pendingResult === null) return;
      const result = pendingResult;
      pendingResult = null;
      if (statsTimer) {
        clearTimeout(statsTimer);
        statsTimer = undefined;
      }
      const stats = parser.stats() ?? null;
      finish({
        ...result,
        stats,
        modelReplied:
          parser.sawAssistantReply() || (stats?.assistantMessages ?? 0) > 0,
      });
    };

    const requestStatsThenFinish = (result: StepExecutionResult) => {
      if (statsRequested || settled) return;
      statsRequested = true;
      pendingResult = result;
      statsHandler = finalizeWithStats;
      channel.write({ type: 'get_state' });
      if (!channel.write({ type: 'get_session_stats' })) {
        finalizeWithStats();
        return;
      }
      statsTimer = setTimeout(finalizeWithStats, STATS_TIMEOUT_MS);
    };

    if (registry && stepRunId) {
      registry.register(stepRunId, iterationId ?? stepRunId, {
        steer: (text) => channel.write({ type: 'steer', message: text }),
        abort: () => {
          committedAbort = true;
          channel.write({ type: 'abort' });
          child.kill('SIGKILL');
        },
        respond: (payload) => {
          parser.recordQuestionAnswered(
            payload.id,
            questionAnswerText(payload),
          );
          return channel.write({ type: 'extension_ui_response', ...payload });
        },
        prompt: (message, mode) =>
          channel
            .send({
              type: 'prompt',
              message,
              ...(mode ? { streamingBehavior: mode } : {}),
            })
            .then(
              (result): PromptResult => ({
                ok: result.ok,
                disposition: promptDisposition(
                  asRecord(result.data)?.disposition,
                ),
              }),
            ),
        send: (command) => channel.send(command),
      }, options.agent);
    }

    statsPollTimer = setInterval(() => {
      if (settled) return;
      channel.write({ type: 'get_session_stats' });
    }, STATS_POLL_MS);

    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup(StepAgentStatus.failed);
        child.kill('SIGKILL');
        reject(
          new Error(
            `pi run timed out after ${options.timeoutMs}ms in ${containerName}`,
          ),
        );
      }, options.timeoutMs);
    }

    const handleEvent = (event: RpcEvent) => {
      if (event.type === 'agent_settled') {
        requestStatsThenFinish(resultFor(step, event.aborted === true, stderr));
        return;
      }

      if (
        event.type === 'response' &&
        event.command === 'prompt' &&
        asRecord(event.data)?.disposition === PromptDisposition.handled
      ) {
        requestStatsThenFinish(resultFor(step, false, stderr));
        return;
      }

      if (channel.resolvePending(event)) return;

      parser.handle(event);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      channel.feed(chunk.toString('utf8'));
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      options.onStderr?.(text);
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup(StepAgentStatus.failed);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      if (committedAbort) {
        requestStatsThenFinish(resultFor(step, true, stderr));
        return;
      }
      requestStatsThenFinish({
        step,
        exitCode: code ?? 1,
        report: null,
        stdout: '',
        stderr,
      });
    });

    child.on('end', () => channel.flushBuffer());

    channel.write({
      id: PROMPT_COMMAND_ID,
      type: 'prompt',
      message: run.prompt,
    });
    channel.write({ type: 'get_state' });
  });
}