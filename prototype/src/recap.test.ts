import { describe, expect, it } from 'vitest';
import { buildRecap, isHighEvent, type RecapEvent } from './recap';

const EVENTS: RecapEvent[] = [
  { at: 10, text: '🏗️ Metal Mine: построено на HOME', anchor: 'HOME' },
  { at: 20, text: '↗ флот вышел к CRIMSON' },
  { at: 30, text: '⚔ RED объявил вам войну!' },
  { at: 40, text: '🚩 RED захватил VEGA', anchor: 'VEGA' },
  { at: 50, text: '⚛ изучено: Ходовые школы' },
  { at: 60, text: '☠️ флот RED уничтожен' },
];

describe('isHighEvent', () => {
  it('flags war / capture / loss / destruction by their marker', () => {
    expect(isHighEvent('⚔ RED объявил вам войну!')).toBe(true);
    expect(isHighEvent('🚩 RED захватил VEGA')).toBe(true);
    expect(isHighEvent('☠️ флот RED уничтожен')).toBe(true);
    expect(isHighEvent('💥 Radar: разрушено на HOME')).toBe(true);
    expect(isHighEvent('🏗️ Metal Mine: построено')).toBe(false);
    expect(isHighEvent('⚛ изучено: Ходовые школы')).toBe(false);
  });
});

describe('buildRecap', () => {
  it('aggregates only the offline window (events at/after `since`)', () => {
    const r = buildRecap(EVENTS, 30);
    expect(r.count).toBe(4); // events at 30,40,50,60
    expect(r.items.every((i) => i.at >= 30)).toBe(true);
    expect(r.from).toBe(30);
    expect(r.to).toBe(60);
  });

  it('counts attention items and lists them first, newest-first', () => {
    const r = buildRecap(EVENTS, 0);
    expect(r.attention).toBe(3); // war (30), capture (40), loss (60)
    // high items lead, sorted newest-first: loss(60), capture(40), war(30)
    expect(r.items.slice(0, 3).map((i) => i.at)).toEqual([60, 40, 30]);
    expect(r.items.slice(0, 3).every((i) => i.high)).toBe(true);
    // then the normal items, newest-first: research(50), move(20), build(10)
    expect(r.items.slice(3).map((i) => i.at)).toEqual([50, 20, 10]);
    expect(r.items.slice(3).every((i) => !i.high)).toBe(true);
  });

  it('preserves anchors for tap-to-jump', () => {
    const capture = buildRecap(EVENTS, 0).items.find((i) => i.at === 40);
    expect(capture?.anchor).toBe('VEGA');
  });

  it('an empty window yields a zero recap', () => {
    const r = buildRecap(EVENTS, 999);
    expect(r).toMatchObject({ count: 0, attention: 0, from: 999, to: 999 });
    expect(r.items).toEqual([]);
  });
});
