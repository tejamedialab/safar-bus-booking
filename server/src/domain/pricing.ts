/**
 * Pure fare calculation (no I/O) so it can be unit-tested exhaustively.
 *
 * fare(seat, from -> to) = (cumulativeFare[to] - cumulativeFare[from]) × tripMultiplier × seatFactor
 * rounded to the nearest whole rupee and returned in paise.
 */
export interface StopFare {
  stopOrder: number;
  cumulativeFarePaise: number;
}

export function baseSegmentFarePaise(stops: StopFare[], fromStop: number, toStop: number): number {
  if (toStop <= fromStop) throw new RangeError('toStop must be after fromStop');
  const from = stops.find((s) => s.stopOrder === fromStop);
  const to = stops.find((s) => s.stopOrder === toStop);
  if (!from || !to) throw new RangeError('Unknown stop on this route');
  const base = to.cumulativeFarePaise - from.cumulativeFarePaise;
  if (base <= 0) throw new RangeError('Route fares must increase along the route');
  return base;
}

export function seatFarePaise(basePaise: number, tripMultiplier: number, seatFactor: number): number {
  const raw = basePaise * tripMultiplier * seatFactor;
  return Math.max(100, Math.round(raw / 100) * 100); // whole rupees, never below ₹1
}

export const formatInr = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
