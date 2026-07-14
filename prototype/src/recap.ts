/**
 * ONB-5 · Return digest ("пока тебя не было") — aggregate the events that piled up
 * during an offline/away window into a briefing, grouped by importance, so a
 * returning player lands on a meaningful summary instead of a silently-changed map.
 *
 * Pure module: no DOM, no i18n, no clock — the caller feeds a flat event stream
 * (already-localised text + a `since` game-time) and gets back a sorted digest.
 * This is the reusable "дайджест-хук" both the client (on return) and a future
 * server push can call. Importance is read from the event's own emoji marker
 * (present in every locale — see prototype/src/locale/*), so it needs no schema
 * change to the note() call sites.
 */

export interface RecapEvent {
  at: number; // game-time of the event
  text: string; // already-localised line (as shown in the log)
  anchor?: string; // optional map node id to jump to
}

export interface RecapItem {
  text: string;
  anchor?: string;
  high: boolean; // needs attention (war / capture / loss / destruction)
  at: number;
}

export interface Recap {
  items: RecapItem[]; // high-importance first, newest-first within each group
  attention: number; // how many items need attention
  count: number; // total events in the window
  from: number; // the `since` bound
  to: number; // game-time of the latest event (or `from` if none)
}

/** Emoji markers that flag an event as attention-worthy (war, capture, loss, wreck). */
const HIGH_MARKERS = ['⚔', '🚩', '☠', '💥'];

export function isHighEvent(text: string): boolean {
  return HIGH_MARKERS.some((m) => text.includes(m));
}

/**
 * Build the return briefing from every event at/after `since`: attention-worthy
 * items first (newest-first), then the rest (newest-first), plus a count of how
 * many need attention. An empty window yields an empty, zero-attention recap.
 */
export function buildRecap(events: readonly RecapEvent[], since: number): Recap {
  const win = events.filter((e) => e.at >= since);
  const items: RecapItem[] = win
    .map((e) => ({ text: e.text, anchor: e.anchor, high: isHighEvent(e.text), at: e.at }))
    .sort((a, b) => (a.high === b.high ? b.at - a.at : a.high ? -1 : 1));
  const attention = items.reduce((n, i) => n + (i.high ? 1 : 0), 0);
  const to = win.reduce((m, e) => Math.max(m, e.at), since);
  return { items, attention, count: win.length, from: since, to };
}
