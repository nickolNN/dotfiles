// @ts-nocheck -- runtime-only canary; pi loads via jiti, no typecheck
// r1-loadmarker.ts — canary for the extensions delivery path.
// Top-level side effect fires when pi imports this file; the receipt
// proves a host edit reached a fresh container AND pi loaded it.
// Keep: harmless, self-documenting. Delete to retire the canary.
import { appendFileSync } from "node:fs";

try {
  appendFileSync(
    `${process.env.HOME}/.pi/agent/extensions/.r1-load-receipt`,
    `imported ${new Date().toISOString()} pid=${process.pid}\n`,
  );
} catch {
  /* never break pi startup over a canary */
}

export default function (_pi: unknown): void {}
