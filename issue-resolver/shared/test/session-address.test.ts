import { describe, expect, it } from 'vitest';

import {
  PI_SESSION_ID_PATTERN,
  SessionAddress,
  isValidPiSessionId,
} from '../src/session-address';

const STEP_RUN = '3b0989cb-9818-4377-97b0-f3e818d26558';
const ISSUE = '359dd92c-4c43-48b0-83fc-e4375b53b958';

describe('SessionAddress', () => {
  it('builds a Pi-valid id for a step run', () => {
    const address = SessionAddress.forStepRun(STEP_RUN);
    expect(address.toString()).toBe(`run.${STEP_RUN}`);
    expect(isValidPiSessionId(address.toString())).toBe(true);
  });

  it('builds a Pi-valid id for an issue-level run', () => {
    for (const kind of ['report', 'devops'] as const) {
      const address = SessionAddress.forIssueRun(ISSUE, kind);
      expect(address.toString()).toBe(`issue.${ISSUE}.${kind}`);
      expect(isValidPiSessionId(address.toString())).toBe(true);
    }
  });

  it('nests workers and stage agents under the step run address', () => {
    const step = SessionAddress.forStepRun(STEP_RUN);
    expect(step.worker(2).toString()).toBe(`run.${STEP_RUN}.w2`);
    expect(step.stageCoordinator(1).toString()).toBe(`run.${STEP_RUN}.s1.lead`);
    expect(step.stageWorker(1, 0).toString()).toBe(`run.${STEP_RUN}.s1.w0`);
    for (const address of [step.worker(0), step.stageCoordinator(2), step.stageWorker(2, 3)]) {
      expect(isValidPiSessionId(address.toString())).toBe(true);
    }
  });

  it('walks up to the enclosing address and stops at the root', () => {
    const leaf = SessionAddress.forStepRun(STEP_RUN).stageWorker(2, 3);
    expect(leaf.parent()?.toString()).toBe(`run.${STEP_RUN}.s2`);
    expect(leaf.parent()?.parent()?.toString()).toBe(`run.${STEP_RUN}`);
    const root = leaf.parent()?.parent();
    expect(root?.isRoot()).toBe(true);
    expect(root?.parent()).toBeNull();
  });

  it('round-trips through parse and compares by value', () => {
    const address = SessionAddress.forStepRun(STEP_RUN).worker(1);
    expect(SessionAddress.parse(address.toString()).equals(address)).toBe(true);
    expect(SessionAddress.parse(address.toString()).equals(address.worker(1))).toBe(false);
  });

  it('rejects ids Pi itself would reject', () => {
    expect(PI_SESSION_ID_PATTERN.test(`${ISSUE}/report`)).toBe(false);
    expect(() => SessionAddress.parse(`${ISSUE}/report`)).toThrow(/invalid Pi session id/);
    expect(() => SessionAddress.parse('')).toThrow(/invalid Pi session id/);
    expect(() => SessionAddress.parse('-leading-dash')).toThrow(/invalid Pi session id/);
  });

  it('rejects negative and fractional worker indexes', () => {
    const step = SessionAddress.forStepRun(STEP_RUN);
    expect(() => step.worker(-1)).toThrow(/non-negative integer/);
    expect(() => step.stageWorker(1.5, 0)).toThrow(/non-negative integer/);
  });
});
