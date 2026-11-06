import { PipelineStep } from '@issue-resolver/shared';
import type { StepExecutionResult } from '@issue-resolver/shared';
import { runRpcSession } from './rpc-session';
import { spawnRpcSession } from './rpc-spawn';
import type { PiRunOptions, PiRunner } from './runner';

export { RpcSessionParser, type RpcParseHandlers } from './rpc-parser';
export { stepAgentEnv } from './rpc-spawn';
export type { RpcEvent } from './rpc-events';

export interface RpcPiRunnerConfig {
  piCommand?: string;
  piArgs?: string[];
}

export class RpcPiRunner implements PiRunner {
  private readonly piCommand: string;
  private readonly piArgs: string[];

  constructor(
    private readonly step: PipelineStep = PipelineStep.resolve,
    private readonly transport: 'docker' | 'local' = 'docker',
    config: RpcPiRunnerConfig = {},
  ) {
    this.piCommand = config.piCommand ?? process.env.PI_BIN ?? 'pi';
    this.piArgs = config.piArgs ?? [];
  }

  run(
    containerName: string,
    prompt: string,
    options: PiRunOptions = {},
  ): Promise<StepExecutionResult> {
    const child = spawnRpcSession({
      transport: this.transport,
      piCommand: this.piCommand,
      piArgs: this.piArgs,
      containerName,
      options,
    });
    return runRpcSession({
      child,
      step: this.step,
      prompt,
      containerName,
      options,
    });
  }
}