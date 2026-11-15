import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Empty, ErrorNotice, Pager, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { BUS_TYPE, dateLong, dayDiff, duration, inr, istToday, time } from '../lib/format';

interface City { id: number; name: string; state: string; served: boolean }

const useCities = () => useQuery<City[]>({ queryKey: ['cities'], queryFn: async () => (await api('/cities')).data, staleTime: 3600_000 });

function SearchSign({ initial, compact }: { initial?: { from?: string; to?: string; date?: string }; compact?: boolean }) {
  const cities = useCities();
  const navigate = useNavigate();
  const [from, setFrom] = useState(initial?.from ?? '');
  const [to, setTo] = useState(initial?.to ?? '');
  const [date, setDate] = useState(initial?.date ?? istToday(1));
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!cities.data || from || to) return;
    const id = (n: string) => String(cities.data!.find((c) => c.name === n)?.id ?? '');
    setFrom(id('Hyderabad'));
    setTo(id('Vijayawada'));
  }, [cities.data, from, to]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!from || !to) return setErr('Choose where you are leaving from and going to.');
    if (from === to) return setErr('Origin and destination need to be different cities.');
    setErr('');
    navigate(`/search?from=${from}&to=${to}&date=${date}`);
  };
  const served = (cities.data ?? []).filter((c) => c.served);
  const quick = [0, 1, 2].map((d) => ({ d: istToday(d), label: d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : 'Day after' }));

  return (
    <form className="signboard" onSubmit={submit} aria-label="Search buses">
      <div className="signboard-inner">
        <div className="sign-grid">
          <label className="field">
            Leaving from
            <select value={from} onChange={(e) => setFrom(e.target.value)} required>
              <option value="">Select city</option>
              {served.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <button type="button" className="swap" aria-label="Swap origin and destination" onClick={() => { setFrom(to); setTo(from); }}>
            ⇄
          </button>
          <label className="field">
            Going to
            <select value={to} onChange={(e) => setTo(e.target.value)} required>
              <option value="">Select city</option>
              {served.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="field">
            Travel date
            <input type="date" value={date} min={istToday(0)} max={istToday(60)} onChange={(e) => setDate(e.target.value)} required />
          </label>
          <button className="btn signal" style={{ padding: '0.8rem 1.4rem', fontSize: '1.05rem' }}>Find buses</button>
        </div>
        {!compact && (
          <div className="sign-dates" role="group" aria-label="Quick dates">
            {quick.map((q) => (
              <button type="button" key={q.d} aria-pressed={date === q.d} onClick={() => setDate(q.d)}>{q.label}</button>
            ))}
          </div>
        )}
        {err && <div role="alert" style={{ color: '#fff', fontWeight: 700 }}>{err}</div>}
      </div>
    </form>
  );
}

export function HomePage() {
  const cities = useCities();
  const navigate = useNavigate();
  const id = (n: string) => cities.data?.find((c) => c.name === n)?.id;
  const popular = [
    ['Hyderabad', 'Visakhapatnam', 'Overnight AC sleeper via Vijayawada'],
    ['Hyderabad', 'Bengaluru', 'Volvo multi-axle on NH44'],
    ['Delhi', 'Phagwara', 'Drops at LPU main gate'],
    ['Chennai', 'Tirupati', 'Morning seater, under 4 hours'],
  ];
  return (
    <main className="page">
      <section className="hero">
        <h1>Board where you are. Get off where you need.</h1>
        <p className="lede">Book a seat for any stretch of a route — Ameerpet to Benz Circle, Ludhiana to Phagwara — and only pay for the distance you ride.</p>
        <SearchSign />
      </section>
      <section className="stack" style={{ marginTop: '2rem' }}>
        <h2>Popular this week</h2>
        <div className="popular">
          {popular.map(([a, b, note]) => (
            <button key={a + b} onClick={() => id(a) && navigate(`/search?from=${id(a)}&to=${id(b)}&date=${istToday(1)}`)}>
              <strong>{a} to {b}</strong>
              <span className="muted small">{note}</span>
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}

const WINDOWS = [
  ['NIGHT', 'Before 6 am'],
  ['MORNING', '6 am – noon'],
  ['AFTERNOON', 'Noon – 6 pm'],
  ['EVENING', 'After 6 pm'],
] as const;

export function SearchPage() {
  const [sp, setSp] = useSearchParams();
  const cities = useCities();
  const q = Object.fromEntries(sp.entries());
  const set = (k: string, v?: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v); else n.delete(k);
    if (k !== 'page') n.delete('page');
    setSp(n);
  };
  const results = useQuery({
    queryKey: ['search', q],
    queryFn: () => api('/search', { query: q }),
    enabled: Boolean(q.from && q.to && q.date),
  });
  const name = (id?: string) => cities.data?.find((c) => String(c.id) === id)?.name ?? '…';

  return (
    <main className="page stack" style={{ ['--gap' as any]: '1.25rem' }}>
      <SearchSign key={sp.toString()} initial={{ from: q.from, to: q.to, date: q.date }} compact />
      <div className="spread">
        <div>
          <h2>{name(q.from)} to {name(q.to)}</h2>
          <p className="muted">{q.date ? dateLong(q.date + 'T12:00:00+05:30') : ''}</p>
        </div>
        <label className="field" style={{ minWidth: 200 }}>
          Sort by
          <select value={q.sort ?? 'departure'} onChange={(e) => set('sort', e.target.value)}>
            <option value="departure">Earliest departure</option>
            <option value="price">Lowest fare</option>
            <option value="duration">Shortest journey</option>
            <option value="seats">Most seats free</option>
          </select>
        </label>
      </div>
      <div className="filters" role="group" aria-label="Filters">
        {WINDOWS.map(([k, label]) => (
          <button key={k} className="chip" aria-pressed={q.departureWindow === k} onClick={() => set('departureWindow', q.departureWindow === k ? undefined : k)}>
            {label}
          </button>
        ))}
        <select aria-label="Bus type" style={{ width: 'auto' }} value={q.busType ?? ''} onChange={(e) => set('busType', e.target.value || undefined)}>
          <option value="">Any bus type</option>
          {Object.entries(BUS_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      {results.isLoading && <Skeleton h={110} count={3} />}
      {results.error && <ErrorNotice error={results.error} onRetry={() => results.refetch()} />}
      {results.data && results.data.data.length === 0 && (
        <div className="panel">
          <Empty title="No buses match this search">
            <p>Try another date, remove a filter, or swap to a nearby city.</p>
          </Empty>
        </div>
      )}
      {results.data && results.data.data.length > 0 && (
        <div className="panel flush">
          {results.data.data.map((r: any) => {
            const next = dayDiff(r.boardAt, r.dropAt);
            return (
              <article className="result" key={r.tripId} aria-label={`${r.operatorName} at ${time(r.boardAt)}`}>
                <div>
                  <div className="op">{r.operatorName}</div>
                  <div className="muted small">{BUS_TYPE[r.busType]} • {r.amenities.slice(0, 3).join(', ')}</div>
                </div>
                <div className="routeline">
                  <div>
                    <div className="t">{time(r.boardAt)}</div>
                    <div className="p">{r.boardingPoints[0]?.pointName}{r.boardingPoints.length > 1 ? ` +${r.boardingPoints.length - 1}` : ''}</div>
                  </div>
                  <div className="track"><span className="dur">{duration(r.durationMin)}</span></div>
                  <div>
                    <div className="t">{time(r.dropAt)}{next > 0 && <span className="nextday">+{next}</span>}</div>
                    <div className="p">{r.dropPoints[0]?.pointName}{r.dropPoints.length > 1 ? ` +${r.dropPoints.length - 1}` : ''}</div>
                  </div>
                </div>
                <div className="fare stack" style={{ ['--gap' as any]: '0.35rem' }}>
                  <div className="small muted">from</div>
                  <div className="amt">{inr(r.fareFromPaise)}</div>
                  <div className="small" style={{ color: r.availableSeats < 6 ? 'var(--danger)' : 'var(--muted)', fontWeight: 600 }}>
                    {r.availableSeats === 0 ? 'Sold out' : `${r.availableSeats} of ${r.totalSeats} seats free`}
                  </div>
                  {r.availableSeats > 0 ? (
                    <Link className="btn" to={`/trips/${r.tripId}?from=${r.fromStop}&to=${r.toStop}&c1=${q.from}&c2=${q.to}`}>Choose seats</Link>
                  ) : (
                    <button className="btn" disabled>Choose seats</button>
                  )}
                </div>
              </article>
            );
          })}
          <Pager meta={results.data.meta} onPage={(p) => set('page', String(p))} />
        </div>
      )}
    </main>
  );
}
