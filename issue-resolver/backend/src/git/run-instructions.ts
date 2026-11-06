import { spawn } from 'node:child_process';
import type { DevServerStartResult } from './types';
import type { InstallCommand } from './install';
import { messageOf } from '../util/errors';

export function parseRunCommand(
  instructions: string | null,
): InstallCommand | null {
  if (!instructions) return null;
  const heading = /^##[ \t]*(?:run|запуск)(?=[\s:(]|$)/im.exec(instructions);
  if (!heading) return null;

  const rest = instructions.slice(heading.index + heading[0].length);
  const nextHeading = /^##\s/m.exec(rest);
  const section = nextHeading ? rest.slice(0, nextHeading.index) : rest;

  const fences = [...section.matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
  const raw =
    fences.length > 0
      ? fences.map((match) => match[1]).join('\n')
      : section;

  const command = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith('#'))
    .map((line) => line.replace(/^cd\s+[^&]*&&\s*/, '').trim())
    .filter((line) => line.length > 0 && !/^cd(\s|$)/.test(line))
    .join(' && ');

  return command.length > 0 ? { file: 'sh', args: ['-c', command] } : null;
}

export function extractPort(text: string): number | null {
  const patterns = [
    /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/i,
    /--port[=\s]+(\d{2,5})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
    }
  }
  return null;
}

export function startDevServer(
  repoPath: string,
  instructions: string | null,
  timeoutMs: number,
): Promise<DevServerStartResult> {
  const command = parseRunCommand(instructions);
  if (!command) {
    return Promise.resolve({
      port: null,
      message: 'команда запуска не найдена в RUN_INSTRUCTIONS.md',
    });
  }

  return new Promise<DevServerStartResult>((resolve) => {
    let settled = false;
    let output = '';
    const finish = (result: DevServerStartResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(
      () =>
        finish({
          port: null,
          message: 'таймаут ожидания порта dev-сервера',
        }),
      timeoutMs,
    );
    timer.unref?.();

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command.file, command.args, {
        cwd: repoPath,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({
        port: null,
        message: messageOf(error),
      });
      return;
    }

    const preset = extractPort([command.file, ...command.args].join(' '));
    if (preset !== null) {
      child.unref();
      finish({ port: preset });
      return;
    }

    const onData = (chunk: Buffer | string): void => {
      output = `${output}${String(chunk)}`.slice(-4096);
      const port = extractPort(output);
      if (port !== null) {
        child.unref();
        finish({ port });
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (error) => finish({ port: null, message: error.message }));
    child.on('exit', (code) =>
      finish({
        port: null,
        message: `dev-сервер завершился с кодом ${code}`,
      }),
    );
  });
}