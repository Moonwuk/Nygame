import { describe, it, expect } from 'vitest';
import {
  parseCorpRecord,
  parseCorpSummaries,
  parseMembership,
  parseMemberships,
  parseAudit,
  parseChallenges,
  parseReadyPool,
  parseRosterView,
  parseAccountIds,
  parseFeed,
  parseMedals,
  sortMembers,
  canManage,
  type CorpMembership,
} from './corp';

describe('corp cabinet — fail-secure parsing (AVA-C1/C2)', () => {
  it('parseCorpRecord accepts a well-formed record, rejects garbage', () => {
    expect(parseCorpRecord({ corpId: 'c1', name: 'Vanguard', influence: 500 })).toEqual({
      corpId: 'c1',
      name: 'Vanguard',
      influence: 500,
    });
    expect(parseCorpRecord(null)).toBeNull();
    expect(parseCorpRecord({ corpId: 'c1' })).toBeNull();
    expect(parseCorpRecord({ corpId: 'c1', name: 'x', influence: 'not-a-number' })).toBeNull();
  });

  it('parseCorpSummaries drops malformed rows instead of throwing', () => {
    const raw = [
      { corpId: 'a', name: 'A', influence: 1, members: 2 },
      { corpId: 'b', name: 'B' }, // missing fields
      'garbage',
    ];
    expect(parseCorpSummaries(raw)).toEqual([{ corpId: 'a', name: 'A', influence: 1, members: 2 }]);
    expect(parseCorpSummaries(null)).toEqual([]);
  });

  it('parseMembership only accepts a known role', () => {
    expect(parseMembership({ corpId: 'c', accountId: 'a', login: 'l', role: 'officer' })).toEqual({
      corpId: 'c',
      accountId: 'a',
      login: 'l',
      role: 'officer',
    });
    expect(parseMembership({ corpId: 'c', accountId: 'a', login: 'l', role: 'emperor' })).toBeNull();
  });

  it('parseMemberships filters the array', () => {
    expect(
      parseMemberships([
        { corpId: 'c', accountId: 'a', login: 'l', role: 'head' },
        { bad: true },
      ]),
    ).toEqual([{ corpId: 'c', accountId: 'a', login: 'l', role: 'head' }]);
  });

  it('parseAudit keeps optional target/detail only when present', () => {
    const raw = [
      { corpId: 'c', at: 1, actor: 'a', action: 'kick', target: 'b', detail: 'reason' },
      { corpId: 'c', at: 2, actor: 'a', action: 'create' },
      { corpId: 'c', at: 'nope', actor: 'a', action: 'x' },
    ];
    expect(parseAudit(raw)).toEqual([
      { corpId: 'c', at: 1, actor: 'a', action: 'kick', target: 'b', detail: 'reason' },
      { corpId: 'c', at: 2, actor: 'a', action: 'create' },
    ]);
  });

  it('parseChallenges round-trips a well-formed list, drops malformed entries', () => {
    const raw = [
      { id: 'm1', challengerCorp: 'a', targetCorp: 'b', cost: 100, status: 'pending', createdAt: 1, expiresAt: 2 },
      { id: 'm2', challengerCorp: 'a', targetCorp: 'b', cost: 100, status: 'accepted', createdAt: 1, expiresAt: 2, pauseEndsAt: 9 },
      { id: 'bad' },
    ];
    expect(parseChallenges(raw)).toEqual([
      { id: 'm1', challengerCorp: 'a', targetCorp: 'b', cost: 100, status: 'pending', createdAt: 1, expiresAt: 2 },
      { id: 'm2', challengerCorp: 'a', targetCorp: 'b', cost: 100, status: 'accepted', createdAt: 1, expiresAt: 2, pauseEndsAt: 9 },
    ]);
  });

  it('parseReadyPool requires readySince alongside the summary fields', () => {
    expect(parseReadyPool([{ corpId: 'a', name: 'A', influence: 1, members: 2, readySince: 5 }])).toEqual([
      { corpId: 'a', name: 'A', influence: 1, members: 2, readySince: 5 },
    ]);
    expect(parseReadyPool([{ corpId: 'a', name: 'A', influence: 1, members: 2 }])).toEqual([]);
  });

  it('parseRosterView degrades missing counts to zero, filters bad roster rows', () => {
    const view = parseRosterView({
      matchupId: 'mu1',
      side: 'challenger',
      status: 'locked',
      counts: { challenger: 3 }, // target missing
      mine: [
        { matchupId: 'mu1', accountId: 'a', side: 'challenger', source: 'flagged', at: 1 },
        { garbage: true },
      ],
    });
    expect(view).toEqual({
      matchupId: 'mu1',
      side: 'challenger',
      status: 'locked',
      mine: [{ matchupId: 'mu1', accountId: 'a', side: 'challenger', source: 'flagged', at: 1 }],
      counts: { challenger: 3, target: 0 },
    });
    expect(parseRosterView(null)).toBeNull();
  });

  it('parseAccountIds keeps only strings, degrades garbage to []', () => {
    expect(parseAccountIds(['a', 'b', 42, null])).toEqual(['a', 'b']);
    expect(parseAccountIds(null)).toEqual([]);
    expect(parseAccountIds('a')).toEqual([]);
  });

  it('parseFeed keeps winnerCorp only when present (including an explicit draw null)', () => {
    const raw = [
      { id: 'f1', at: 1, kind: 'result', challengerCorp: 'a', challengerName: 'A', targetCorp: 'b', targetName: 'B', winnerCorp: 'a' },
      { id: 'f2', at: 2, kind: 'result', challengerCorp: 'a', challengerName: 'A', targetCorp: 'b', targetName: 'B', winnerCorp: null },
      { id: 'f3', at: 3, kind: 'matchup', challengerCorp: 'a', challengerName: 'A', targetCorp: 'b', targetName: 'B' },
    ];
    const parsed = parseFeed(raw);
    expect(parsed[0]?.winnerCorp).toBe('a');
    expect(parsed[1]?.winnerCorp).toBeNull();
    expect('winnerCorp' in parsed[2]!).toBe(false);
  });

  it('parseMedals accepts a null corpId (account-scope medal)', () => {
    expect(parseMedals([{ accountId: 'a', medalId: 'first_win', corpId: null, at: 1 }])).toEqual([
      { accountId: 'a', medalId: 'first_win', corpId: null, at: 1 },
    ]);
  });
});

describe('corp cabinet — sort/RBAC helpers', () => {
  const m = (role: CorpMembership['role'], login: string): CorpMembership => ({
    corpId: 'c',
    accountId: login,
    login,
    role,
  });

  it('sortMembers ranks head → officer → member → recruit, then by login', () => {
    const sorted = sortMembers([m('recruit', 'z'), m('member', 'b'), m('head', 'x'), m('officer', 'a')]);
    expect(sorted.map((x) => x.role)).toEqual(['head', 'officer', 'member', 'recruit']);
  });

  it('canManage is true only for head/officer', () => {
    expect(canManage('head')).toBe(true);
    expect(canManage('officer')).toBe(true);
    expect(canManage('member')).toBe(false);
    expect(canManage('recruit')).toBe(false);
    expect(canManage(undefined)).toBe(false);
  });
});
