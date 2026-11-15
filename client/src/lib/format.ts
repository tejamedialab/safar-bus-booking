const TZ = 'Asia/Kolkata';

export const inr = (paise: number) => {
  const p = Number(paise);
  const fractional = p % 100 !== 0;
  return '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: fractional ? 2 : 0, maximumFractionDigits: 2 });
};

export const time = (iso: string | Date) =>
  new Date(iso).toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

export const dateShort = (iso: string | Date) =>
  new Date(iso).toLocaleDateString('en-IN', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });

export const dateLong = (iso: string | Date) =>
  new Date(iso).toLocaleDateString('en-IN', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

export const dateTime = (iso: string | Date) =>
  new Date(iso).toLocaleString('en-IN', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/** A plain YYYY-MM-DD date string (service date) shown without timezone shifting. */
export const serviceDate = (d: string) => {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
};

export const duration = (min: number) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;

export const istToday = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString('en-CA', { timeZone: TZ });

/** "Next day" marker when the arrival date differs from boarding date. */
export const dayDiff = (a: string, b: string) => {
  const d = (x: string) => new Date(x).toLocaleDateString('en-CA', { timeZone: TZ });
  return Math.round((Date.parse(d(b)) - Date.parse(d(a))) / 86_400_000);
};

export const BUS_TYPE: Record<string, string> = {
  AC_SLEEPER: 'AC Sleeper',
  NON_AC_SLEEPER: 'Non-AC Sleeper',
  AC_SEATER: 'AC Seater',
  NON_AC_SEATER: 'Non-AC Seater',
  VOLVO_MULTI_AXLE: 'Volvo Multi-Axle',
};

export const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
