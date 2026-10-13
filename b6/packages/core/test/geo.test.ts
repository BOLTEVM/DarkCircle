import { describe, expect, it } from 'vitest';
import { formatArea, parcelAreaSqm, parseParcelGeoJson, toViewBox } from '../src/geo.js';

const square = (half = 0.0005) =>
  JSON.stringify({
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-half, half],
          [half, half],
          [half, -half],
          [-half, -half],
          [-half, half],
        ],
      ],
    },
  });

describe('parseParcelGeoJson', () => {
  it('accepts a closed polygon, bare or as a Feature', () => {
    expect(parseParcelGeoJson(square()).ok).toBe(true);
    expect(parseParcelGeoJson(JSON.stringify(JSON.parse(square()).geometry)).ok).toBe(true);
  });

  it('rejects an unclosed ring', () => {
    const g = JSON.parse(square());
    g.geometry.coordinates[0].pop();
    g.geometry.coordinates[0].push([9, 9]);
    expect(parseParcelGeoJson(JSON.stringify(g)).error).toMatch(/not closed/);
  });

  it('rejects out-of-range and non-numeric coordinates', () => {
    const g = JSON.parse(square());
    g.geometry.coordinates[0][1] = [-195, 0];
    expect(parseParcelGeoJson(JSON.stringify(g)).error).toMatch(/Longitude -195/);
    g.geometry.coordinates[0][1] = ['a', 0];
    expect(parseParcelGeoJson(JSON.stringify(g)).error).toMatch(/not numeric/);
  });

  it('rejects other geometry types, junk and degenerate rings', () => {
    expect(parseParcelGeoJson('{"type":"Point","coordinates":[0,0]}').ok).toBe(false);
    expect(parseParcelGeoJson('not json').ok).toBe(false);
    expect(parseParcelGeoJson('').ok).toBe(false);
    const flat = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [2, 0], [0, 0]]] };
    expect(parseParcelGeoJson(JSON.stringify(flat)).error).toMatch(/no area/);
  });

  it('caps the size of what goes on chain', () => {
    const ring = Array.from({ length: 600 }, (_, i) => [Math.cos(i) * 0.001, Math.sin(i) * 0.001]);
    ring.push(ring[0]!);
    expect(parseParcelGeoJson(JSON.stringify({ type: 'Polygon', coordinates: [ring] })).ok).toBe(false);
  });
});

describe('area and projection', () => {
  it('measures a ~111 m square at the equator as ~12,390 m²', () => {
    const area = parcelAreaSqm(parseParcelGeoJson(square()).polygon!);
    expect(area).toBeGreaterThan(12_300);
    expect(area).toBeLessThan(12_450);
    expect(formatArea(area)).toMatch(/^1\.2\d ha$/);
    expect(formatArea(950)).toBe('950 m²');
  });

  it('subtracts holes', () => {
    const p = parseParcelGeoJson(square()).polygon!;
    const hole = parseParcelGeoJson(square(0.0001)).polygon!.coordinates[0]!;
    const withHole = { ...p, coordinates: [p.coordinates[0]!, hole] };
    expect(parcelAreaSqm(withHole)).toBeLessThan(parcelAreaSqm(p));
  });

  it('projects into the view box with north up', () => {
    const pts = toViewBox(parseParcelGeoJson(square()).polygon!, 400, 300);
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(400);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(300);
    }
    // first vertex is the north-west corner: top-left
    expect(pts[0]![1]).toBeLessThan(pts[2]![1]);
  });
});
