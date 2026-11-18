import { describe, expect, it } from 'vitest';
import { linePath, spreadLabels, xFor, yFor } from './chart.ts';

describe('scales', () => {
  it('maps +100 to the top, −100 to the bottom, 0 to the middle', () => {
    expect(yFor(100, 10, 210)).toBe(10);
    expect(yFor(-100, 10, 210)).toBe(210);
    expect(yFor(0, 10, 210)).toBe(110);
    expect(yFor(250, 10, 210)).toBe(10);
  });

  it('spaces points evenly and centers a single point', () => {
    expect([0, 1, 2].map((i) => xFor(i, 3, 0, 100))).toEqual([0, 50, 100]);
    expect(xFor(0, 1, 0, 100)).toBe(50);
  });
});

describe('spreadLabels', () => {
  it('leaves well-separated labels alone', () => {
    expect(
      spreadLabels(
        [
          { key: 'a', y: 10 },
          { key: 'b', y: 50 },
        ],
        14,
        0,
        100,
      ),
    ).toEqual([
      { key: 'a', y: 10 },
      { key: 'b', y: 50 },
    ]);
  });

  it('pushes overlapping labels apart without reordering them', () => {
    const out = spreadLabels(
      [
        { key: 'b', y: 52 },
        { key: 'a', y: 50 },
        { key: 'c', y: 51 },
      ],
      14,
      0,
      200,
    );
    expect(out.map((l) => l.key)).toEqual(['a', 'c', 'b']);
    expect(out[1]!.y - out[0]!.y).toBeGreaterThanOrEqual(14);
    expect(out[2]!.y - out[1]!.y).toBeGreaterThanOrEqual(14);
  });

  it('keeps labels inside the plot when they pile up at the bottom', () => {
    const out = spreadLabels(
      [
        { key: 'a', y: 98 },
        { key: 'b', y: 99 },
        { key: 'c', y: 100 },
      ],
      14,
      0,
      100,
    );
    expect(out.at(-1)!.y).toBe(100);
    expect(out[0]!.y).toBe(72);
  });
});

describe('linePath', () => {
  it('breaks the line where a week has no data', () => {
    expect(linePath([{ x: 0, y: 0 }, { x: 10, y: 5 }, null, { x: 30, y: 2 }])).toBe(
      'M0.0,0.0L10.0,5.0M30.0,2.0',
    );
    expect(linePath([])).toBe('');
  });
});
