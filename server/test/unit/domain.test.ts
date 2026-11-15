import { describe, expect, it } from 'vitest';
import {
  CancellationRulesSchema,
  DEFAULT_CANCELLATION_RULES,
  evaluateCancellation,
  refundAmountPaise,
} from '../../src/domain/cancellation.js';
import { generateLayout } from '../../src/domain/layout.js';
import { generatePnr, PNR_PATTERN } from '../../src/domain/pnr.js';
import { baseSegmentFarePaise, seatFarePaise } from '../../src/domain/pricing.js';
import { canTransitionRefund, canTransitionTrip } from '../../src/domain/state-machines.js';

const hoursFrom = (now: Date, h: number) => new Date(now.getTime() + h * 3_600_000);

describe('pricing', () => {
  const stops = [
    { stopOrder: 0, cumulativeFarePaise: 0 },
    { stopOrder: 1, cumulativeFarePaise: 38_000 },
    { stopOrder: 2, cumulativeFarePaise: 65_000 },
  ];
  it('charges the difference of cumulative fares for a segment', () => {
    expect(baseSegmentFarePaise(stops, 0, 2)).toBe(65_000);
    expect(baseSegmentFarePaise(stops, 1, 2)).toBe(27_000);
  });
  it('rejects reversed or unknown segments', () => {
    expect(() => baseSegmentFarePaise(stops, 2, 1)).toThrow(RangeError);
    expect(() => baseSegmentFarePaise(stops, 0, 9)).toThrow(RangeError);
  });
  it('applies trip multiplier and seat factor, rounded to whole rupees', () => {
    expect(seatFarePaise(65_000, 1.15, 1.1)).toBe(82_200); // 822.25 → ₹822
    expect(seatFarePaise(65_000, 1, 1)).toBe(65_000);
    expect(seatFarePaise(10, 1, 1)).toBe(100); // never below ₹1
  });
});

describe('cancellation policy', () => {
  const now = new Date('2026-01-10T10:00:00Z');
  it.each([
    [72, true, 90],
    [48, true, 90],
    [47.9, true, 75],
    [24, true, 75],
    [13, true, 50],
    [3, true, 25],
    [2.99, false, 0],
    [-1, false, 0],
  ])('%s hours before departure → allowed=%s, refund=%s%%', (h, allowed, pct) => {
    const d = evaluateCancellation(DEFAULT_CANCELLATION_RULES, hoursFrom(now, h), now);
    expect(d.allowed).toBe(allowed);
    expect(d.refundPercent).toBe(pct);
  });
  it('rounds refunds down so we never over-refund', () => {
    expect(refundAmountPaise(99_999, 75)).toBe(74_999);
    expect(refundAmountPaise(100_000, 0)).toBe(0);
  });
  it('validates rule sets: unique thresholds and non-increasing refunds', () => {
    expect(CancellationRulesSchema.safeParse(DEFAULT_CANCELLATION_RULES).success).toBe(true);
    expect(
      CancellationRulesSchema.safeParse([
        { minHoursBeforeDeparture: 24, refundPercent: 50 },
        { minHoursBeforeDeparture: 24, refundPercent: 40 },
      ]).success,
    ).toBe(false);
    expect(
      CancellationRulesSchema.safeParse([
        { minHoursBeforeDeparture: 48, refundPercent: 50 },
        { minHoursBeforeDeparture: 6, refundPercent: 80 },
      ]).success,
    ).toBe(false);
    expect(CancellationRulesSchema.safeParse([]).success).toBe(false);
  });
});

describe('state machines', () => {
  it('allows only the documented trip transitions', () => {
    expect(canTransitionTrip('SCHEDULED', 'DEPARTED')).toBe(true);
    expect(canTransitionTrip('SCHEDULED', 'CANCELLED')).toBe(true);
    expect(canTransitionTrip('DEPARTED', 'COMPLETED')).toBe(true);
    expect(canTransitionTrip('SCHEDULED', 'COMPLETED')).toBe(false);
    expect(canTransitionTrip('CANCELLED', 'SCHEDULED')).toBe(false);
    expect(canTransitionTrip('DEPARTED', 'CANCELLED')).toBe(false);
  });
  it('allows only the documented refund transitions', () => {
    expect(canTransitionRefund('PENDING', 'PROCESSED')).toBe(true);
    expect(canTransitionRefund('FAILED', 'PENDING')).toBe(true);
    expect(canTransitionRefund('PROCESSED', 'FAILED')).toBe(false);
    expect(canTransitionRefund('PROCESSED', 'PENDING')).toBe(false);
  });
});

describe('PNR', () => {
  it('has operator prefix + 8 unambiguous characters', () => {
    const pnrs = Array.from({ length: 2000 }, () => generatePnr('DS'));
    for (const p of pnrs) {
      expect(p).toMatch(PNR_PATTERN);
      expect(p.startsWith('DS')).toBe(true);
      expect(p.slice(2)).not.toMatch(/[01OIL]/);
    }
    expect(new Set(pnrs).size).toBe(pnrs.length);
  });
});

describe('seat layout generator', () => {
  it('builds a 2+1 double-deck sleeper with L/U labels and an empty aisle', () => {
    const { gridCols, seats } = generateLayout({ seatType: 'SLEEPER', configuration: '2+1', rows: 5, decks: 2, lowerDeckFareFactor: 1.1 });
    expect(gridCols).toBe(4);
    expect(seats).toHaveLength(30);
    expect(seats.filter((s) => s.label.startsWith('L'))).toHaveLength(15);
    expect(seats.some((s) => s.gridCol === 2)).toBe(false); // aisle
    expect(seats.find((s) => s.label === 'L1')!.fareFactor).toBe(1.1);
    expect(seats.find((s) => s.label === 'U1')!.fareFactor).toBe(1);
    expect(new Set(seats.map((s) => s.label)).size).toBe(30);
  });
  it('numbers seater seats 1..N', () => {
    const { seats } = generateLayout({ seatType: 'SEATER', configuration: '2+2', rows: 10, decks: 1 });
    expect(seats.map((s) => s.label)).toEqual(Array.from({ length: 40 }, (_, i) => String(i + 1)));
  });
});
