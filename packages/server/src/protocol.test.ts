import { describe, it, expect } from 'vitest';
import { parseClientMessage } from './protocol';

// parseClientMessage is the validation boundary: a malformed field must be REJECTED
// (→ E_BAD_MESSAGE at the caller), never silently coerced into a different, broader op.
const parse = (obj: unknown): unknown => parseClientMessage(JSON.stringify(obj));

describe('parseClientMessage — the validation boundary', () => {
  it('ping.clear: absent pingId = clear-all; a string = clear-one; a wrong-typed one is rejected (NETA2-9 L2)', () => {
    expect(parse({ type: 'ping.clear' })).toEqual({ type: 'ping.clear' }); // clear ALL — a legit form
    expect(parse({ type: 'ping.clear', pingId: 'ping-7' })).toEqual({
      type: 'ping.clear',
      pingId: 'ping-7',
    });
    // a NUMBER (or null) pingId must NOT silently escalate to the destructive clear-all
    expect(parse({ type: 'ping.clear', pingId: 42 })).toBeNull();
    expect(parse({ type: 'ping.clear', pingId: null })).toBeNull();
  });

  it('ping: a number clientTime is kept, a non-number is dropped', () => {
    expect(parse({ type: 'ping', clientTime: 1234 })).toEqual({ type: 'ping', clientTime: 1234 });
    expect(parse({ type: 'ping', clientTime: 'soon' })).toEqual({ type: 'ping' });
    expect(parse({ type: 'ping' })).toEqual({ type: 'ping' });
  });

  it('rejects malformed JSON, a non-object body, and unknown types', () => {
    expect(parseClientMessage('not json{')).toBeNull();
    expect(parseClientMessage('"a string, not an object"')).toBeNull();
    expect(parse({ type: 'no-such-type' })).toBeNull();
    expect(parse({ noType: true })).toBeNull();
  });
});
