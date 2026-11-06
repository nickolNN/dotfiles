import { spawn, type ChildProcess } from 'node:child_process';
import { isValidPiSessionId } from '@issue-resolver/shared';
import type { PiRunOptions } from './runner';

const LAUNCHER_ENV_KEYS = [
  'PI_SESSION_FILE',
  'PI_SESSION_ID',
  'PI_SESSION_NAME',
  'PI_MODEL',
  'PI_PROVIDER',
  'PI_AGENT_ROOM',
] as const;

export function stepAgentEnv(
  base: NodeJS.ProcessEnv,
  room?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of LAUNCHER_ENV_KEYS) delete env[key];
  if (room) env.PI_AGENT_ROOM = room;
  env.PI_OFFLINE = '1';
  env.PI_SKIP_VERSION_CHECK = '1';
  env.PI_TELEMETRY = '0';
  return env;
}

function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes(value?.trim().toLowerCase() ?? '');
}

export interface RpcLaunchOptions {
  transport: 'docker' | 'local';
  piCommand: string;
  piArgs: string[];
  containerName: string;
  options: PiRunOptions;
}

export function sessionArgs(options: PiRunOptions): string[] {
  const sessionId = options.sessionId ?? options.stepRunId;
  if (sessionId !== undefined && !isValidPiSessionId(sessionId)) {
    throw new Error(`invalid Pi session id: ${JSON.stringify(sessionId)}`);
  }
  const verboseFlags = isTruthy(process.env.ISSUE_RESOLVER_AGENT_VERBOSE)
    ? ['--verbose']
    : [];
  return [
    ...(sessionId ? ['--session-id', sessionId] : []),
    ...(options.sessionDir ? ['--session-dir', options.sessionDir] : []),
    ...(options.sessionName ? ['--name', options.sessionName] : []),
    ...(options.systemAppend
      ? ['--append-system-prompt', options.systemAppend]
      : []),
    ...(options.tools?.length ? ['--tools', options.tools.join(',')] : []),
    ...(options.excludeTools?.length
      ? ['--exclude-tools', options.excludeTools.join(',')]
      : []),
    ...verboseFlags,
  ];
}

export function spawnRpcSession(launch: RpcLaunchOptions): ChildProcess {
  const { options } = launch;
  const modelArgs = options.model ? ['--model', options.model] : [];
  const thinkingArgs = options.thinkingLevel
    ? ['--thinking', options.thinkingLevel]
    : [];
  const sessionFlags = sessionArgs(options);
  const room = options.issueId ? `issue-${options.issueId}` : undefined;

  if (launch.transport === 'local') {
    return spawn(
      launch.piCommand,
      [
        ...launch.piArgs,
        '--mode',
        'rpc',
        ...sessionFlags,
        ...modelArgs,
        ...thinkingArgs,
      ],
      {
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: stepAgentEnv(process.env, room),
      },
    );
  }

  return spawn(
    'docker',
    [
      'exec',
      '-i',
      ...(options.cwd ? ['-w', options.cwd] : []),
      ...(room ? ['-e', `PI_AGENT_ROOM=${room}`] : []),
      launch.containerName,
      launch.piCommand,
      ...launch.piArgs,
      '--mode',
      'rpc',
      ...sessionFlags,
      ...modelArgs,
      ...thinkingArgs,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
}