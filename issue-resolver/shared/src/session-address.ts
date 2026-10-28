/**
 * Session identity, shared by every tier.
 *
 * Pi creates a session per agent run and stores it as
 * `<session dir>/<timestamp>_<id>.jsonl`; the id can also be supplied by the
 * caller (`--session-id`), which is what makes one identifier possible end to
 * end: the address we route logs and control commands by IS the id of the file
 * the agent writes.
 *
 * Pi validates ids as `^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$`, so
 * hierarchy is expressed with dots — `run.<stepRunId>.s2.w1` — never slashes.
 */

const ROOT_PATTERN = /^(?:run\.[^.]*|issue\.[^.]*\.(?:report|devops))$/;

/** Same rule Pi applies before accepting `--session-id`. */
export const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function isValidPiSessionId(id: string): boolean {
  return PI_SESSION_ID_PATTERN.test(id);
}

export type IssueRunKind = 'report' | 'devops';

/**
 * Address of one live agent session.
 *
 * ```ts
 * SessionAddress.forStepRun(id)              // run.<stepRunId>
 *   .worker(2)                               // run.<stepRunId>.w2
 *   .stageCoordinator(1)                     // run.<stepRunId>.s1.lead
 *   .stageWorker(1, 0)                       // run.<stepRunId>.s1.w0
 * SessionAddress.forIssueRun(issueId, 'report') // issue.<issueId>.report
 * ```
 *
 * The value is opaque to callers: pass it to `pi --session-id`, use it as the
 * registry key, put it on the wire. Only this module knows the grammar.
 */
export class SessionAddress {
  private constructor(private readonly value: string) {}

  static forStepRun(stepRunId: string): SessionAddress {
    return new SessionAddress(checked(`run.${stepRunId}`));
  }

  static forIssueRun(issueId: string, kind: IssueRunKind): SessionAddress {
    return new SessionAddress(checked(`issue.${issueId}.${kind}`));
  }

  /** Adopts an already-built id (a stored row, an incoming request). */
  static parse(id: string): SessionAddress {
    return new SessionAddress(checked(id));
  }

  /** Agent of a room/stage worker; `index` is 0-based, as the agents are. */
  worker(index: number): SessionAddress {
    return new SessionAddress(checked(`${this.value}.w${segment(index)}`));
  }

  stageCoordinator(stage: number): SessionAddress {
    return new SessionAddress(
      checked(`${this.value}.s${segment(stage)}.lead`),
    );
  }

  stageWorker(stage: number, index: number): SessionAddress {
    return new SessionAddress(
      checked(`${this.value}.s${segment(stage)}.w${segment(index)}`),
    );
  }

  /** Enclosing address, or `null` for a root (`run.<id>`, `issue.<id>.report`). */
  parent(): SessionAddress | null {
    if (ROOT_PATTERN.test(this.value)) return null;
    const cut = this.value.lastIndexOf('.');
    return cut <= 0 ? null : new SessionAddress(checked(this.value.slice(0, cut)));
  }

  /** True for addresses built by `forStepRun`/`forIssueRun` and their parses. */
  isRoot(): boolean {
    return ROOT_PATTERN.test(this.value);
  }

  equals(other: SessionAddress): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}

function segment(index: number): number {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`session address segment must be a non-negative integer: ${index}`);
  }
  return index;
}

function checked(id: string): string {
  if (!isValidPiSessionId(id)) {
    throw new Error(
      `invalid Pi session id ${JSON.stringify(id)}: letters, digits, '.', '_' and '-' only, must start and end alphanumeric`,
    );
  }
  return id;
}