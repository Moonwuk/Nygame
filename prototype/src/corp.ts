/**
 * AVA-C1/C2 — corporation cabinet: pure types + fail-secure parsers for the CORP-0 /
 * AVA-2..9 / MED-1 HTTP responses (`packages/server/src/corpApi.ts`,
 * `avaApi.ts`, `medalApi.ts`). No DOM, no fetch — main.ts feeds it fetched JSON and
 * renders. Mirrors the server's own types (`packages/server/src/store/types.ts`)
 * structurally; not imported directly since the server package isn't a client
 * dependency (same reasoning as `arsenal.ts`'s own `ArsenalItem` re-declaration
 * would need if that type weren't already shared via `@void/shared-core` — these
 * corp/AvA shapes are server-local, so the client keeps its own copy).
 *
 * Scope (per `docs/corporation-ui.md` §7's own degradation order — build what the
 * server actually backs first): Обзор/Участники/Войны/Казна are REAL, wired to the
 * live API. Владения (sector ownership) and Чат (persistent corp chat) have no
 * server counterpart at all yet (no meta-layer Контур 2) — those tabs stay honest
 * "скоро" stubs, per the doc's own instruction ("Пока подсистема не готова — таб
 * показывает заглушку, а не ломается"), not simulated.
 */

export type CorpRole = 'head' | 'officer' | 'member' | 'recruit';

export interface CorpRecord {
  corpId: string;
  name: string;
  influence: number;
}
export interface CorpSummary extends CorpRecord {
  members: number;
}
export interface CorpMembership {
  corpId: string;
  accountId: string;
  login: string;
  role: CorpRole;
}
export interface CorpAuditEntry {
  corpId: string;
  at: number;
  actor: string;
  action: string;
  target?: string;
  detail?: string;
}

export type AvaSide = 'challenger' | 'target';
export type AvaChallengeStatus =
  | 'pending'
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'locked'
  | 'cancelled'
  | 'ended';
export interface AvaChallenge {
  id: string;
  challengerCorp: string;
  targetCorp: string;
  cost: number;
  status: AvaChallengeStatus;
  createdAt: number;
  expiresAt: number;
  pauseEndsAt?: number;
}
export interface AvaRosterEntry {
  matchupId: string;
  accountId: string;
  side: AvaSide;
  source: 'flagged' | 'self';
  at: number;
}
export interface AvaRosterView {
  matchupId: string;
  side: AvaSide;
  status: AvaChallengeStatus;
  pauseEndsAt?: number;
  mine: AvaRosterEntry[];
  counts: Record<AvaSide, number>;
}
export interface AvaFeedEntry {
  id: string;
  at: number;
  kind: 'matchup' | 'result';
  challengerCorp: string;
  challengerName: string;
  targetCorp: string;
  targetName: string;
  winnerCorp?: string | null;
}
export interface Medal {
  accountId: string;
  medalId: string;
  corpId: string | null;
  at: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Fail-secure: a malformed/missing corp record parses to null rather than a crash
 *  (a network hiccup or an old cached response should never break the cabinet). */
export function parseCorpRecord(raw: unknown): CorpRecord | null {
  if (!isObj(raw) || !isStr(raw.corpId) || !isStr(raw.name) || !isNum(raw.influence)) return null;
  return { corpId: raw.corpId, name: raw.name, influence: raw.influence };
}

export function parseCorpSummaries(raw: unknown): CorpSummary[] {
  if (!Array.isArray(raw)) return [];
  const out: CorpSummary[] = [];
  for (const r of raw) {
    if (isObj(r) && isStr(r.corpId) && isStr(r.name) && isNum(r.influence) && isNum(r.members)) {
      out.push({ corpId: r.corpId, name: r.name, influence: r.influence, members: r.members });
    }
  }
  return out;
}

export function parseMembership(raw: unknown): CorpMembership | null {
  if (
    !isObj(raw) ||
    !isStr(raw.corpId) ||
    !isStr(raw.accountId) ||
    !isStr(raw.login) ||
    !isStr(raw.role)
  ) {
    return null;
  }
  const role = raw.role;
  if (role !== 'head' && role !== 'officer' && role !== 'member' && role !== 'recruit') return null;
  return { corpId: raw.corpId, accountId: raw.accountId, login: raw.login, role };
}

export function parseMemberships(raw: unknown): CorpMembership[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseMembership).filter((m): m is CorpMembership => m !== null);
}

export function parseAudit(raw: unknown): CorpAuditEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CorpAuditEntry[] = [];
  for (const r of raw) {
    if (!isObj(r) || !isStr(r.corpId) || !isNum(r.at) || !isStr(r.actor) || !isStr(r.action)) continue;
    out.push({
      corpId: r.corpId,
      at: r.at,
      actor: r.actor,
      action: r.action,
      ...(isStr(r.target) ? { target: r.target } : {}),
      ...(isStr(r.detail) ? { detail: r.detail } : {}),
    });
  }
  return out;
}

export function parseChallenges(raw: unknown): AvaChallenge[] {
  if (!Array.isArray(raw)) return [];
  const out: AvaChallenge[] = [];
  for (const r of raw) {
    if (
      isObj(r) &&
      isStr(r.id) &&
      isStr(r.challengerCorp) &&
      isStr(r.targetCorp) &&
      isNum(r.cost) &&
      isStr(r.status) &&
      isNum(r.createdAt) &&
      isNum(r.expiresAt)
    ) {
      out.push({
        id: r.id,
        challengerCorp: r.challengerCorp,
        targetCorp: r.targetCorp,
        cost: r.cost,
        status: r.status as AvaChallengeStatus,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        ...(isNum(r.pauseEndsAt) ? { pauseEndsAt: r.pauseEndsAt } : {}),
      });
    }
  }
  return out;
}

export function parseReadyPool(raw: unknown): Array<CorpSummary & { readySince: number }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<CorpSummary & { readySince: number }> = [];
  for (const r of raw) {
    if (
      isObj(r) &&
      isStr(r.corpId) &&
      isStr(r.name) &&
      isNum(r.influence) &&
      isNum(r.members) &&
      isNum(r.readySince)
    ) {
      out.push({ corpId: r.corpId, name: r.name, influence: r.influence, members: r.members, readySince: r.readySince });
    }
  }
  return out;
}

export function parseRosterView(raw: unknown): AvaRosterView | null {
  if (!isObj(raw) || !isStr(raw.matchupId) || !isStr(raw.side) || !isStr(raw.status) || !isObj(raw.counts)) {
    return null;
  }
  const mine = Array.isArray(raw.mine)
    ? raw.mine.filter(
        (e): e is AvaRosterEntry =>
          isObj(e) && isStr(e.matchupId) && isStr(e.accountId) && isStr(e.side) && isStr(e.source) && isNum(e.at),
      )
    : [];
  const counts = raw.counts;
  const challenger = isNum(counts.challenger) ? counts.challenger : 0;
  const target = isNum(counts.target) ? counts.target : 0;
  return {
    matchupId: raw.matchupId,
    side: raw.side as AvaSide,
    status: raw.status as AvaChallengeStatus,
    ...(isNum(raw.pauseEndsAt) ? { pauseEndsAt: raw.pauseEndsAt } : {}),
    mine,
    counts: { challenger, target },
  };
}

/** The `{accountIds}` shape of GET /corps/:id/ready-players (AVA-6 setRoster
 *  eligibility set) — a plain list of flagged account ids. */
export function parseAccountIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string');
}

export function parseFeed(raw: unknown): AvaFeedEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: AvaFeedEntry[] = [];
  for (const r of raw) {
    if (
      isObj(r) &&
      isStr(r.id) &&
      isNum(r.at) &&
      (r.kind === 'matchup' || r.kind === 'result') &&
      isStr(r.challengerCorp) &&
      isStr(r.challengerName) &&
      isStr(r.targetCorp) &&
      isStr(r.targetName)
    ) {
      out.push({
        id: r.id,
        at: r.at,
        kind: r.kind,
        challengerCorp: r.challengerCorp,
        challengerName: r.challengerName,
        targetCorp: r.targetCorp,
        targetName: r.targetName,
        ...(r.winnerCorp === null || isStr(r.winnerCorp) ? { winnerCorp: r.winnerCorp } : {}),
      });
    }
  }
  return out;
}

export function parseMedals(raw: unknown): Medal[] {
  if (!Array.isArray(raw)) return [];
  const out: Medal[] = [];
  for (const r of raw) {
    if (isObj(r) && isStr(r.accountId) && isStr(r.medalId) && isNum(r.at) && (r.corpId === null || isStr(r.corpId))) {
      out.push({ accountId: r.accountId, medalId: r.medalId, corpId: r.corpId, at: r.at });
    }
  }
  return out;
}

/** Rank for a stable head→officer→member→recruit sort (matches the server's own
 *  `detail()` ordering, `corpService.ts`). */
const ROLE_RANK: Record<CorpRole, number> = { head: 0, officer: 1, member: 2, recruit: 3 };
export function sortMembers(members: readonly CorpMembership[]): CorpMembership[] {
  return [...members].sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.login.localeCompare(b.login));
}

/** Head/officer can manage members and see the audit log; a plain member/recruit cannot. */
export function canManage(role: CorpRole | undefined): boolean {
  return role === 'head' || role === 'officer';
}
