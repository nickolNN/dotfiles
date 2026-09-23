// @ts-nocheck -- runtime-only canary; pi loads via jiti, no typecheck
// Subdirectory-package canary: proves pi/extensions/<name>/index.ts
// delivery+load (the vendored-package path). Safe to delete.
import { appendFileSync } from "node:fs";
try {
  appendFileSync(
    `${process.env.HOME}/.pi/agent/extensions/.r1-pkg-receipt`,
    `pkg imported ${new Date().toISOString()}\n`,
  );
} catch {
  /* ignore */
}
export default function (_pi: unknown): void {}
