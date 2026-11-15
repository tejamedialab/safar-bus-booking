import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ErrorNotice, Field, Skeleton } from '../components/ui';
import { api, ApiError, fieldErrors } from '../lib/api';
import { useAuth } from '../lib/auth';
import { BUS_TYPE, dateLong, duration, inr, time } from '../lib/format';

/* =====================================================================
 * Seat selection
 * ===================================================================== */

interface Seat { label: string; deck: number; gridRow: number; gridCol: number; seatType: 'SEATER' | 'SLEEPER'; isWindow: boolean; farePaise: number; status: string }

function SeatDeck({ title, seats, cols, selected, onToggle, steering }: { title: string; seats: Seat[]; cols: number; selected: string[]; onToggle: (s: Seat) => void; steering?: boolean }) {
  const rows = Math.max(...seats.map((s) => s.gridRow)) + 1;
  const sleeper = seats[0]?.seatType === 'SLEEPER';
  return (
    <section className="deck" aria-label={title}>
      <div className="deck-title">
        <span>{title}</span>
        {steering ? <span className="wheel" title="Driver" aria-hidden="true" /> : <span style={{ width: 26 }} />}
      </div>
      <div className="seatgrid" style={{ gridTemplateColumns: `repeat(${cols}, 44px)`, gridTemplateRows: `repeat(${rows}, ${sleeper ? 84 : 44}px)` }}>
        {seats.map((s) => {
          const isSel = selected.includes(s.label);
          const takeable = s.status === 'AVAILABLE' || s.status === 'HELD_BY_YOU';
          return (
            <button
              key={s.label}
              type="button"
              className={`seat ${s.seatType} ${s.status} ${isSel ? 'selected' : ''}`}
              style={{ gridColumn: s.gridCol + 1, gridRow: s.gridRow + 1 }}
              disabled={!takeable}
              aria-pressed={isSel}
              aria-label={`Seat ${s.label}, ${s.seatType.toLowerCase()}${s.isWindow ? ', window' : ''}, ${inr(s.farePaise)}, ${takeable ? (isSel ? 'selected' : 'available') : 'not available'}`}
              onClick={() => onToggle(s)}
            >
              <span>{s.label}</span>
              {takeable && <span className="f">{inr(s.farePaise).replace('₹', '')}</span>}
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function TripSeatsPage() {
  const { tripId } = useParams();
  const [sp, setSp] = useSearchParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const from = Number(sp.get('from') ?? 0);
  const to = Number(sp.get('to') ?? 1);
  const [selected, setSelected] = useState<string[]>([]);
  const [limitMsg, setLimitMsg] = useState('');

  const trip = useQuery({ queryKey: ['trip', tripId], queryFn: async () => (await api(`/trips/${tripId}`)).data });
  const map = useQuery({
    queryKey: ['seats', tripId, from, to, user?.id],
    queryFn: async () => (await api(`/trips/${tripId}/seats`, { query: { from, to } })).data,
    refetchInterval: 15_000, // keep availability fresh while the passenger decides
  });

  // drop selections that became unavailable on refresh
  useEffect(() => {
    if (!map.data) return;
    const ok = new Set(map.data.seats.filter((s: Seat) => s.status === 'AVAILABLE' || s.status === 'HELD_BY_YOU').map((s: Seat) => s.label));
    setSelected((cur) => cur.filter((l) => ok.has(l)));
  }, [map.data]);

  const hold = useMutation({
    mutationFn: () => api(`/trips/${tripId}/holds`, { method: 'POST', body: { fromStop: from, toStop: to, seats: selected } }),
    onSuccess: (r) => navigate(`/checkout/${r.data.holdToken}`),
    onError: () => map.refetch(),
  });

  const c1 = sp.get('c1');
  const c2 = sp.get('c2');
  const stops = trip.data?.stops ?? [];
  const boardOpts = stops.filter((s: any) => s.stopOrder < to && (!c1 || String(s.cityId) === c1));
  const dropOpts = stops.filter((s: any) => s.stopOrder > from && (!c2 || String(s.cityId) === c2));
  const setSeg = (k: 'from' | 'to', v: number) => {
    const n = new URLSearchParams(sp);
    n.set(k, String(v));
    setSp(n, { replace: true });
    setSelected([]);
  };

  const seats: Seat[] = map.data?.seats ?? [];
  const max = map.data?.maxSeatsPerBooking ?? 6;
  const total = seats.filter((s) => selected.includes(s.label)).reduce((a, s) => a + s.farePaise, 0);
  const toggle = (s: Seat) => {
    setLimitMsg('');
    setSelected((cur) => {
      if (cur.includes(s.label)) return cur.filter((x) => x !== s.label);
      if (cur.length >= max) {
        setLimitMsg(`You can book up to ${max} seats at a time.`);
        return cur;
      }
      return [...cur, s.label];
    });
  };
  const decks = [1, 2].map((d) => seats.filter((s) => s.deck === d)).filter((d) => d.length);
  const board = stops.find((s: any) => s.stopOrder === from);
  const drop = stops.find((s: any) => s.stopOrder === to);

  if (trip.error) return <main className="page"><ErrorNotice error={trip.error} /></main>;
  if (!trip.data) return <main className="page"><Skeleton h={300} /></main>;
  const t = trip.data;

  return (
    <main className="page stack">
      <Link to={-1 as any} className="small">Back to results</Link>
      <div className="spread">
        <div>
          <h2>{t.operatorName}</h2>
          <p className="muted">{BUS_TYPE[t.busType]} • {t.registrationNo} • {t.amenities.join(', ')}</p>
        </div>
        {t.status !== 'SCHEDULED' && <span className={`pill ${t.status}`}>This trip is {t.status.toLowerCase()}</span>}
      </div>

      <div className="booking-layout">
        <div className="stack">
          <div className="panel grid-2">
            <Field label="Boarding point">
              <select value={from} onChange={(e) => setSeg('from', Number(e.target.value))}>
                {boardOpts.map((s: any) => <option key={s.stopOrder} value={s.stopOrder}>{time(s.departsAt)} • {s.cityName}, {s.pointName}</option>)}
              </select>
            </Field>
            <Field label="Drop point">
              <select value={to} onChange={(e) => setSeg('to', Number(e.target.value))}>
                {dropOpts.map((s: any) => <option key={s.stopOrder} value={s.stopOrder}>{time(s.arrivesAt)} • {s.cityName}, {s.pointName}</option>)}
              </select>
            </Field>
          </div>

          <div className="panel stack">
            <div className="spread">
              <h3>Pick your seats</h3>
              <div className="legend" aria-hidden="true">
                <span><i /> Free</span>
                <span><i className="s" /> Yours</span>
                <span><i className="h" /> On hold</span>
                <span><i className="b" /> Booked</span>
              </div>
            </div>
            {map.isLoading && <Skeleton h={320} />}
            {map.error && <ErrorNotice error={map.error} onRetry={() => map.refetch()} />}
            {map.data && (
              <div className="decks">
                {decks.map((d, i) => (
                  <SeatDeck key={i} title={decks.length > 1 ? (i === 0 ? 'Lower deck' : 'Upper deck') : 'Seats'} seats={d} cols={map.data.layout.gridCols} selected={selected} onToggle={toggle} steering={i === 0} />
                ))}
              </div>
            )}
            <p className="small muted">Seat availability is for your stretch only: a seat booked Hyderabad → Vijayawada can still be free for Vijayawada → Vizag. Refreshes every 15 seconds.</p>
          </div>
        </div>

        <aside className="panel stack sticky" aria-label="Your journey">
          <h3>Your journey</h3>
          <ol className="stopline">
            {stops.map((s: any) => {
              const on = s.stopOrder >= from && s.stopOrder <= to;
              const end = s.stopOrder === from || s.stopOrder === to;
              return (
                <li key={s.stopOrder} className={`${on && s.stopOrder < to ? 'on' : ''} ${end ? 'end' : ''}`}>
                  <span className="num small" style={{ fontWeight: 700, color: on ? 'var(--ink)' : 'var(--muted)' }}>{time(s.stopOrder === 0 ? s.departsAt : s.arrivesAt)}</span>
                  <span className="dot" />
                  <span className="small" style={{ color: on ? 'var(--ink)' : 'var(--muted)', fontWeight: end ? 800 : 500 }}>
                    {s.cityName} • {s.pointName}
                  </span>
                </li>
              );
            })}
          </ol>
          {board && drop && (
            <p className="small muted">
              {dateLong(board.departsAt)} • {duration((new Date(drop.arrivesAt).getTime() - new Date(board.departsAt).getTime()) / 60000)} on board
            </p>
          )}
          <div className="spread" style={{ borderTop: '1px solid var(--line)', paddingTop: '0.9rem' }}>
            <span>{selected.length ? `Seats ${selected.join(', ')}` : 'No seats selected'}</span>
            <strong style={{ fontSize: '1.3rem' }}>{inr(total)}</strong>
          </div>
          {limitMsg && <div className="notice warn small">{limitMsg}</div>}
          {hold.error && <ErrorNotice error={hold.error} />}
          {user ? (
            <button className="btn block signal" disabled={!selected.length || hold.isPending || t.status !== 'SCHEDULED'} onClick={() => hold.mutate()}>
              {hold.isPending ? 'Holding seats…' : `Hold ${selected.length || ''} seat${selected.length === 1 ? '' : 's'} for 10 minutes`}
            </button>
          ) : (
            <Link className="btn block" to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}>Log in to hold seats</Link>
          )}
        </aside>
      </div>
    </main>
  );
}

/* =====================================================================
 * Checkout
 * ===================================================================== */

function useCountdown(until?: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return until ? Math.max(0, Math.floor((new Date(until).getTime() - now) / 1000)) : 0;
}

export function CheckoutPage() {
  const { holdToken } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const hold = useQuery({ queryKey: ['hold', holdToken], queryFn: async () => (await api(`/holds/${holdToken}`)).data, retry: false });
  const trip = useQuery({ queryKey: ['trip', hold.data?.tripId], queryFn: async () => (await api(`/trips/${hold.data.tripId}`)).data, enabled: Boolean(hold.data) });
  const left = useCountdown(hold.data?.expiresAt);

  // One idempotency key per checkout, kept across refreshes: retries can never double-book.
  const idemKey = useMemo(() => {
    const k = `idem:${holdToken}`;
    try {
      const existing = sessionStorage.getItem(k);
      if (existing) return existing;
      const fresh = crypto.randomUUID();
      sessionStorage.setItem(k, fresh);
      return fresh;
    } catch {
      return crypto.randomUUID();
    }
  }, [holdToken]);

  const [pax, setPax] = useState<Record<string, { name: string; age: string; gender: string }>>({});
  const [contact, setContact] = useState({ email: '', phone: '' });
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (user && !contact.email) setContact((c) => ({ ...c, email: user.email }));
  }, [user, contact.email]);

  const book = useMutation({
    mutationFn: () =>
      api('/bookings', {
        method: 'POST',
        headers: { 'Idempotency-Key': idemKey },
        body: {
          holdToken,
          contactEmail: contact.email,
          contactPhone: contact.phone,
          passengers: hold.data.seats.map((s: any) => ({
            seatLabel: s.label,
            name: pax[s.label]?.name ?? '',
            age: Number(pax[s.label]?.age),
            gender: pax[s.label]?.gender ?? '',
          })),
        },
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['bookings'] });
      navigate(`/bookings/${r.data.pnr}?new=1`, { replace: true });
    },
  });
  const release = useMutation({
    mutationFn: () => api(`/holds/${holdToken}`, { method: 'DELETE' }),
    onSuccess: () => navigate(-1),
  });

  if (hold.error) {
    const e = hold.error as ApiError;
    return (
      <main className="page" style={{ maxWidth: 640 }}>
        <div className="notice warn stack">
          <strong>{e.code === 'HOLD_EXPIRED' ? 'Your seat hold has ended' : e.message}</strong>
          <p>Seats are held for 10 minutes so others can book them if you change your mind. Pick your seats again to continue.</p>
          <Link to="/" className="btn">Search again</Link>
        </div>
      </main>
    );
  }
  if (!hold.data || !trip.data) return <main className="page"><Skeleton h={320} /></main>;

  const errs = fieldErrors(book.error);
  const board = trip.data.stops.find((s: any) => s.stopOrder === hold.data.fromStop);
  const drop = trip.data.stops.find((s: any) => s.stopOrder === hold.data.toStop);
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  const bookErr = book.error as ApiError | null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    book.mutate();
  };

  return (
    <main className="page">
      <div className="booking-layout">
        <form ref={formRef} className="stack" onSubmit={submit} noValidate>
          <div className="spread">
            <h2>Passenger details</h2>
            <span className={`timer ${left < 120 ? 'low' : ''}`} role="timer" aria-live="off" aria-label={`Hold ends in ${mm} minutes ${ss} seconds`}>
              Seats held for {mm}:{ss}
            </span>
          </div>
          {left === 0 && <div className="notice warn">The hold has run out. You can still try — if the seats are free you will get them, otherwise pick again.</div>}
          {hold.data.seats.map((s: any, i: number) => (
            <fieldset key={s.label} className="panel" style={{ border: '1px solid var(--line)' }}>
              <legend style={{ fontWeight: 800, padding: '0 0.4rem' }}>Seat {s.label} • {inr(s.farePaise)}</legend>
              <div className="grid-3">
                <Field label="Full name" error={errs[`passengers.${i}.name`]}>
                  <input required autoComplete={i === 0 ? 'name' : 'off'} value={pax[s.label]?.name ?? ''} aria-invalid={Boolean(errs[`passengers.${i}.name`])}
                    onChange={(e) => setPax({ ...pax, [s.label]: { ...pax[s.label], name: e.target.value } })} />
                </Field>
                <Field label="Age" error={errs[`passengers.${i}.age`] ? 'Enter an age between 1 and 120' : undefined}>
                  <input required type="number" min={1} max={120} inputMode="numeric" value={pax[s.label]?.age ?? ''} aria-invalid={Boolean(errs[`passengers.${i}.age`])}
                    onChange={(e) => setPax({ ...pax, [s.label]: { ...pax[s.label], age: e.target.value } })} />
                </Field>
                <Field label="Gender" error={errs[`passengers.${i}.gender`] ? 'Choose an option' : undefined}>
                  <select required value={pax[s.label]?.gender ?? ''} aria-invalid={Boolean(errs[`passengers.${i}.gender`])}
                    onChange={(e) => setPax({ ...pax, [s.label]: { ...pax[s.label], gender: e.target.value } })}>
                    <option value="">Select</option>
                    <option value="FEMALE">Female</option>
                    <option value="MALE">Male</option>
                    <option value="OTHER">Other</option>
                  </select>
                </Field>
              </div>
            </fieldset>
          ))}
          <div className="panel grid-2">
            <Field label="Email for the e-ticket" error={errs.contactEmail}>
              <input type="email" required autoComplete="email" value={contact.email} aria-invalid={Boolean(errs.contactEmail)} onChange={(e) => setContact({ ...contact, email: e.target.value })} />
            </Field>
            <Field label="Mobile number" error={errs.contactPhone} hint="10 digits, used by the crew to reach you">
              <input type="tel" required autoComplete="tel-national" inputMode="numeric" maxLength={10} value={contact.phone} aria-invalid={Boolean(errs.contactPhone)} onChange={(e) => setContact({ ...contact, phone: e.target.value.replace(/\D/g, '') })} />
            </Field>
          </div>
          {bookErr && bookErr.code !== 'VALIDATION_ERROR' && (
            <div className="notice error" role="alert">
              <strong>{bookErr.message}</strong>
              {['SEAT_UNAVAILABLE', 'HOLD_EXPIRED'].includes(bookErr.code) && (
                <p style={{ marginTop: '0.4rem' }}><Link to={`/trips/${hold.data.tripId}?from=${hold.data.fromStop}&to=${hold.data.toStop}`}>Choose different seats</Link></p>
              )}
              {bookErr.code === 'HOLD_ALREADY_USED' && bookErr.details?.pnr && (
                <p style={{ marginTop: '0.4rem' }}><Link to={`/bookings/${bookErr.details.pnr}`}>Open ticket {bookErr.details.pnr}</Link></p>
              )}
            </div>
          )}
          {bookErr?.code === 'VALIDATION_ERROR' && <div className="notice error" role="alert">Check the highlighted fields.</div>}
          <div className="row">
            <button className="btn signal" disabled={book.isPending}>{book.isPending ? 'Confirming…' : `Pay ${inr(hold.data.totalFarePaise)} and confirm`}</button>
            <button type="button" className="btn secondary" onClick={() => release.mutate()} disabled={release.isPending}>Release seats</button>
          </div>
          <p className="small muted">Payment is simulated in this demo. Pressing confirm twice, or retrying after a network drop, will never create two bookings.</p>
        </form>

        <aside className="panel stack sticky">
          <h3>{trip.data.operatorName}</h3>
          <div className="routeline">
            <div><div className="t">{time(board.departsAt)}</div><div className="p">{board.cityName}</div></div>
            <div className="track"><span className="dur">{duration((new Date(drop.arrivesAt).getTime() - new Date(board.departsAt).getTime()) / 60000)}</span></div>
            <div><div className="t">{time(drop.arrivesAt)}</div><div className="p">{drop.cityName}</div></div>
          </div>
          <p className="small"><strong>Board:</strong> {board.pointName} • {dateLong(board.departsAt)}</p>
          <p className="small"><strong>Drop:</strong> {drop.pointName}</p>
          <div className="spread" style={{ borderTop: '1px solid var(--line)', paddingTop: '0.75rem' }}>
            <span>Seats {hold.data.seats.map((s: any) => s.label).join(', ')}</span>
            <strong style={{ fontSize: '1.3rem' }}>{inr(hold.data.totalFarePaise)}</strong>
          </div>
        </aside>
      </div>
    </main>
  );
}
