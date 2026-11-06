import {
  chmodSync,
  copyFileSync,
  existsSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE_HELPERS = ['pw-browsers.sh'];

export function installWorkspaceHelpers(workspaceDir: string): void {
  if (!existsSync(workspaceDir)) return;
  const binDir = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'bin',
  );
  for (const name of WORKSPACE_HELPERS) {
    const source = join(binDir, name);
    if (!existsSync(source)) continue;
    const target = join(workspaceDir, name);
    copyFileSync(source, target);
    chmodSync(target, 0o755);
  }
}
