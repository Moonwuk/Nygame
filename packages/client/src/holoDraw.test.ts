import { describe, it, expect } from 'vitest';
import { rgba } from './holoDraw';

// The sprite/blit primitives need a canvas (verified end-to-end via the prototype render);
// rgba is pure, so it's covered here.
describe('holoDraw — rgba', () => {
  it('converts hex + alpha to an rgba() string', () => {
    expect(rgba('#35d6e6', 0.5)).toBe('rgba(53,214,230,0.5)');
    expect(rgba('#000000', 1)).toBe('rgba(0,0,0,1)');
    expect(rgba('#ffffff', 0)).toBe('rgba(255,255,255,0)');
  });

  it('tolerates a missing leading #', () => {
    expect(rgba('ff8800', 0.25)).toBe('rgba(255,136,0,0.25)');
  });
});
