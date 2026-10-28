
const ROOT_PATTERN = /^(?:run\.[^.]*|issue\.[^.]*\.(?:report|devops))$/;

export const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function isValidPiSessionId(id: string): boolean {
  return PI_SESSION_ID_PATTERN.test(id);
}

export type IssueRunKind = 'report' | 'devops';

export class SessionAddress {
  private constructor(private readonly value: string) {}

  static forStepRun(stepRunId: string): SessionAddress {
    return new SessionAddress(checked(`run.${stepRunId}`));
  }

  static forIssueRun(issueId: string, kind: IssueRunKind): SessionAddress {
    return new SessionAddress(checked(`issue.${issueId}.${kind}`));
  }

  static parse(id: string): SessionAddress {
    return new SessionAddress(checked(id));
  }

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

  parent(): SessionAddress | null {
    if (ROOT_PATTERN.test(this.value)) return null;
    const cut = this.value.lastIndexOf('.');
    return cut <= 0 ? null : new SessionAddress(checked(this.value.slice(0, cut)));
  }

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