import { describe, expect, it } from 'vitest';

import { messageOf } from '../src/errors';

describe('messageOf', () => {
  it('returns the message of an Error', () => {
    expect(messageOf(new Error('boom'))).toBe('boom');
  });

  it('returns a string as is', () => {
    expect(messageOf('boom')).toBe('boom');
  });

  it('stringifies a non-Error object', () => {
    expect(messageOf({ code: 1 })).toBe('[object Object]');
  });

  it('stringifies null', () => {
    expect(messageOf(null)).toBe('null');
  });

  it('uses the fallback for non-Errors', () => {
    expect(messageOf({ code: 1 }, 'fallback text')).toBe('fallback text');
    expect(messageOf(null, 'fallback text')).toBe('fallback text');
  });

  it('lets the Error message win over the fallback', () => {
    expect(messageOf(new Error('boom'), 'fallback text')).toBe('boom');
  });
});