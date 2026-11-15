import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Empty, ErrorNotice, Field, Modal, Pager, Pill, Skeleton, useToast } from '../../components/ui';
import { api, fieldErrors } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { BUS_TYPE, duration, inr, istToday, serviceDate } from '../../lib/format';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function OperatorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { user } = useAuth();
  const ops = useQuery({ queryKey: ['operators'], queryFn: async () => (await api('/operators')).data, enabled: user?.role === 'ADMIN' });
  if (user?.role !== 'ADMIN') return null;
  return (
    <Field label="Operator">
      <select value={value} onChange={(e) => onChange(e.target.value)} required>
        <option value="">Choose operator</option>
        {ops.data?.map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </Field>
  );
}

/* ---------------------------------------------------------------- routes */

interface StopRow { cityId: string; pointName: string; arrivalOffsetMin: string; departureOffsetMin: string; distanceKm: string; cumulativeFare: string }
const blankStop = (): StopRow => ({ cityId: '', pointName: '', arrivalOffsetMin: '', departureOffsetMin: '', distanceKm: '', cumulativeFare: '' });

function NewRouteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const cities = useQuery({ queryKey: ['cities'], queryFn: async () => (await api('/cities')).data });
  const [operatorId, setOperatorId] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [stops, setStops] = useState<StopRow[]>([{ ...blankStop(), arrivalOffsetMin: '0', departureOffsetMin: '0', distanceKm: '0', cumulativeFare: '0' }, blankStop()]);
  const create = useMutation({
    mutationFn: () =>
      api('/routes', {
        method: 'POST',
        body: {
          operatorId: operatorId || undefined, code, name,
          stops: stops.map((s) => ({ cityId: Number(s.cityId), pointName: s.pointName, arrivalOffsetMin: Number(s.arrivalOffsetMin), departureOffsetMin: Number(s.departureOffsetMin), distanceKm: Number(s.distanceKm), cumulativeFare: Number(s.cumulativeFare) })),
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['routes'] });
      qc.invalidateQueries({ queryKey: ['routes-all'] });
      toast(`Route ${code.toUpperCase()} created`);
      onClose();
    },
  });
  const errs = fieldErrors(create.error);
  const upd = (i: number, k: keyof StopRow, v: string) => setStops(stops.map((s, j) => (j === i ? { ...s, [k]: v } : s)));
  return (
    <Modal open={open} onClose={onClose} title="New route"
      footer={<><button className="btn secondary" onClick={onClose}>Discard</button><button className="btn" disabled={create.isPending} onClick={() => create.mutate()}>Create route</button></>}>
      <div className="stack">
        <OperatorPicker value={operatorId} onChange={setOperatorId} />
        <div className="grid-2">
          <Field label="Route code" error={errs.code} hint="e.g. HYD-WGL"><input value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          <Field label="Name" error={errs.name}><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Hyderabad → Warangal" /></Field>
        </div>
        <p className="small muted">Stops in travel order. Times are minutes after the first departure; distance and fare are counted from the first stop, so the fare between any two stops is the difference.</p>
        {stops.map((s, i) => (
          <fieldset key={i} className="panel" style={{ padding: '0.75rem' }}>
            <legend className="small" style={{ fontWeight: 700 }}>Stop {i + 1}{i === 0 ? ' (origin)' : ''}</legend>
            <div className="grid-2">
              <Field label="City"><select value={s.cityId} onChange={(e) => upd(i, 'cityId', e.target.value)}><option value="">Choose</option>{cities.data?.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
              <Field label="Boarding / drop point"><input value={s.pointName} onChange={(e) => upd(i, 'pointName', e.target.value)} /></Field>
            </div>
            <div className="grid-3" style={{ marginTop: '0.5rem' }}>
              <Field label="Arrives (min)"><input type="number" min={0} value={s.arrivalOffsetMin} onChange={(e) => upd(i, 'arrivalOffsetMin', e.target.value)} disabled={i === 0} /></Field>
              <Field label="Leaves (min)"><input type="number" min={0} value={s.departureOffsetMin} onChange={(e) => upd(i, 'departureOffsetMin', e.target.value)} /></Field>
              <Field label="Km from origin"><input type="number" min={0} value={s.distanceKm} onChange={(e) => upd(i, 'distanceKm', e.target.value)} disabled={i === 0} /></Field>
              <Field label="₹ from origin"><input type="number" min={0} value={s.cumulativeFare} onChange={(e) => upd(i, 'cumulativeFare', e.target.value)} disabled={i === 0} /></Field>
            </div>
            {errs[`stops.${i}`] && <p className="err small" style={{ color: 'var(--danger)', marginTop: '0.4rem' }}>{errs[`stops.${i}`]}</p>}
          </fieldset>
        ))}
        <div className="row">
          <button className="btn secondary small" onClick={() => setStops([...stops, blankStop()])} disabled={stops.length >= 20}>Add stop</button>
          {stops.length > 2 && <button className="btn ghost small" onClick={() => setStops(stops.slice(0, -1))}>Remove last stop</button>}
        </div>
        {create.error && <ErrorNotice error={create.error} />}
      </div>
    </Modal>
  );
}

export function RoutesPage() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const routes = useQuery({ queryKey: ['routes', q, page], queryFn: () => api('/routes', { query: { q, page } }) });
  const schedules = useQuery({ queryKey: ['schedules'], queryFn: async () => (await api('/schedules')).data });
  return (
    <div className="stack">
      <div className="spread"><h1 style={{ fontSize: '1.9rem' }}>Routes & schedules</h1><button className="btn" onClick={() => setOpen(true)}>New route</button></div>
      <div className="panel"><Field label="Find a route"><input type="search" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Code or name" /></Field></div>
      {routes.error && <ErrorNotice error={routes.error} />}
      {routes.isLoading && <Skeleton h={200} />}
      {routes.data && (
        <div className="panel flush">
          {routes.data.data.length === 0 ? <Empty title="No routes yet"><p>Create your first route to start scheduling trips.</p></Empty> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Code</th><th>Name</th><th>Operator</th><th className="r">Stops</th><th className="r">Distance</th><th className="r">Duration</th><th className="r">Schedules</th><th>Status</th></tr></thead>
                <tbody>
                  {routes.data.data.map((r: any) => (
                    <tr key={r.id}>
                      <td><Link to={`/console/routes/${r.id}`}><strong>{r.code}</strong></Link></td>
                      <td>{r.name}</td><td className="small">{r.operatorName}</td>
                      <td className="r num">{r.stopCount}</td><td className="r num">{r.distanceKm} km</td><td className="r num">{duration(r.durationMin)}</td><td className="r num">{r.activeSchedules}</td>
                      <td><Pill s={r.isActive ? 'SCHEDULED' : 'CANCELLED'} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager meta={routes.data.meta} onPage={setPage} />
        </div>
      )}
      <section className="panel flush">
        <div className="panel-head"><h3>All schedules</h3></div>
        {schedules.data && (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Route</th><th>Departs</th><th>Runs on</th><th>Bus</th><th className="r">Fare ×</th><th>Trips until</th><th className="r">Upcoming</th></tr></thead>
              <tbody>
                {schedules.data.map((s: any) => (
                  <tr key={s.id}>
                    <td><Link to={`/console/routes/${s.routeId}`}>{s.routeCode}</Link></td><td><strong>{s.departureTime}</strong></td>
                    <td className="small">{s.daysOfWeek.length === 7 ? 'Daily' : s.daysOfWeek.map((d: number) => DAYS[d]).join(', ')}</td>
                    <td className="mono small">{s.registrationNo}</td><td className="r num">{s.fareMultiplier.toFixed(2)}</td>
                    <td className="small">{s.generatedUntil ? serviceDate(s.generatedUntil) : 'Not generated'}</td><td className="r num">{s.upcomingTrips}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <NewRouteDialog open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

export function RouteDetailPage() {
  const { routeId } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const route = useQuery({ queryKey: ['route', routeId], queryFn: async () => (await api(`/routes/${routeId}`)).data });
  const buses = useQuery({ queryKey: ['buses-for', route.data?.operatorId], queryFn: () => api('/buses', { query: { operatorId: route.data.operatorId, active: 'true', pageSize: 100 } }), enabled: Boolean(route.data) });
  const [sc, setSc] = useState({ busId: '', departureTime: '21:00', days: [0, 1, 2, 3, 4, 5, 6], fareMultiplier: '1.00' });
  const [gen, setGen] = useState<{ id: string; fromDate: string; toDate: string } | null>(null);
  const [genResult, setGenResult] = useState<any>(null);
  const createSc = useMutation({
    mutationFn: () => api('/schedules', { method: 'POST', body: { routeId, busId: sc.busId, departureTime: sc.departureTime, daysOfWeek: sc.days, fareMultiplier: Number(sc.fareMultiplier) } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['route', routeId] }); toast('Schedule added. Generate trips to open it for booking.'); },
  });
  const generate = useMutation({
    mutationFn: () => api(`/schedules/${gen!.id}/generate-trips`, { method: 'POST', body: { fromDate: gen!.fromDate, toDate: gen!.toDate } }),
    onSuccess: (r) => { setGenResult(r.data); qc.invalidateQueries(); },
  });
  const toggle = useMutation({
    mutationFn: (s: any) => api(`/schedules/${s.id}`, { method: 'PATCH', body: { isActive: !s.isActive } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['route', routeId] }),
  });
  if (route.error) return <ErrorNotice error={route.error} />;
  if (!route.data) return <Skeleton h={300} />;
  const r = route.data;
  const submit = (e: FormEvent) => { e.preventDefault(); createSc.mutate(); };
  return (
    <div className="stack">
      <Link to="/console/routes" className="small">All routes</Link>
      <div className="spread"><div><h1 style={{ fontSize: '1.7rem' }}>{r.code}</h1><p className="muted">{r.name} • {r.operatorName}</p></div><Pill s={r.isActive ? 'SCHEDULED' : 'CANCELLED'} /></div>
      <section className="panel flush">
        <div className="panel-head"><h3>Stops</h3><span className="small muted">Fixed once trips exist, because tickets refer to them</span></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>#</th><th>City</th><th>Point</th><th className="r">Arrives</th><th className="r">Leaves</th><th className="r">Km</th><th className="r">Fare from origin</th></tr></thead>
            <tbody>{r.stops.map((s: any) => (
              <tr key={s.stopOrder}><td className="num">{s.stopOrder + 1}</td><td>{s.cityName}</td><td>{s.pointName}</td><td className="r num">+{duration(s.arrivalOffsetMin)}</td><td className="r num">+{duration(s.departureOffsetMin)}</td><td className="r num">{s.distanceKm}</td><td className="r num">{inr(s.cumulativeFarePaise)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </section>
      <section className="panel flush">
        <div className="panel-head"><h3>Schedules</h3></div>
        {r.schedules.length === 0 ? <Empty title="No schedules yet" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Departs</th><th>Runs on</th><th>Bus</th><th className="r">Fare ×</th><th>Trips until</th><th /></tr></thead>
              <tbody>{r.schedules.map((s: any) => (
                <tr key={s.id}>
                  <td><strong>{s.departureTime}</strong> {!s.isActive && <Pill s="CANCELLED" />}</td>
                  <td className="small">{s.daysOfWeek.length === 7 ? 'Daily' : s.daysOfWeek.map((d: number) => DAYS[d]).join(', ')}</td>
                  <td className="mono small">{s.registrationNo}</td>
                  <td className="r num">{s.fareMultiplier.toFixed(2)}</td>
                  <td className="small">{s.generatedUntil ? serviceDate(s.generatedUntil) : 'Not generated'}</td>
                  <td><div className="row" style={{ flexWrap: 'nowrap' }}>
                    <button className="btn small" disabled={!s.isActive} onClick={() => { setGenResult(null); setGen({ id: s.id, fromDate: istToday(0), toDate: istToday(30) }); }}>Generate trips</button>
                    <button className="btn small secondary" onClick={() => toggle.mutate(s)}>{s.isActive ? 'Pause' : 'Resume'}</button>
                  </div></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <form className="modal-body stack" onSubmit={submit} style={{ borderTop: '1px solid var(--line)' }}>
          <h3>Add a schedule</h3>
          <div className="grid-3">
            <Field label="Bus"><select value={sc.busId} onChange={(e) => setSc({ ...sc, busId: e.target.value })} required><option value="">Choose bus</option>{buses.data?.data.map((b: any) => <option key={b.id} value={b.id}>{b.registrationNo} • {BUS_TYPE[b.busType]}</option>)}</select></Field>
            <Field label="Departure time (IST)"><input type="time" value={sc.departureTime} onChange={(e) => setSc({ ...sc, departureTime: e.target.value })} required /></Field>
            <Field label="Fare multiplier" hint="1.00 = base fare"><input type="number" step="0.05" min="0.5" max="3" value={sc.fareMultiplier} onChange={(e) => setSc({ ...sc, fareMultiplier: e.target.value })} /></Field>
          </div>
          <fieldset style={{ border: 0, padding: 0 }}>
            <legend className="small" style={{ fontWeight: 600 }}>Runs on</legend>
            <div className="filters">{DAYS.map((d, i) => (
              <button type="button" key={d} className="chip" aria-pressed={sc.days.includes(i)} onClick={() => setSc({ ...sc, days: sc.days.includes(i) ? sc.days.filter((x) => x !== i) : [...sc.days, i] })}>{d}</button>
            ))}</div>
          </fieldset>
          {createSc.error && <ErrorNotice error={createSc.error} />}
          <div><button className="btn" disabled={createSc.isPending || !sc.days.length}>Add schedule</button></div>
        </form>
      </section>
      <Modal open={Boolean(gen)} onClose={() => setGen(null)} title="Generate trips"
        footer={<><button className="btn secondary" onClick={() => setGen(null)}>Close</button>{!genResult && <button className="btn" disabled={generate.isPending} onClick={() => generate.mutate()}>Generate</button>}</>}>
        {gen && (
          <div className="stack">
            <div className="grid-2">
              <Field label="From"><input type="date" value={gen.fromDate} onChange={(e) => setGen({ ...gen, fromDate: e.target.value })} /></Field>
              <Field label="To" hint="Up to 62 days at once"><input type="date" value={gen.toDate} onChange={(e) => setGen({ ...gen, toDate: e.target.value })} /></Field>
            </div>
            <p className="small muted">Dates that already have a trip, or where this bus is already running another trip, are skipped.</p>
            {generate.error && <ErrorNotice error={generate.error} />}
            {genResult && (
              <div className="notice ok">
                <strong>{genResult.created} trips created.</strong>
                {genResult.skipped.length > 0 && <p className="small">Skipped {genResult.skipped.length}: {Object.entries(genResult.skipped.reduce((a: any, s: any) => ({ ...a, [s.reason]: (a[s.reason] ?? 0) + 1 }), {})).map(([k, v]) => `${v} ${String(k).toLowerCase().replace(/_/g, ' ')}`).join(', ')}</p>}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

/* ---------------------------------------------------------------- fleet */

export function FleetPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const buses = useQuery({ queryKey: ['buses', q, page], queryFn: () => api('/buses', { query: { q, page } }) });
  const layouts = useQuery({ queryKey: ['layouts'], queryFn: async () => (await api('/seat-layouts')).data });
  const [busOpen, setBusOpen] = useState(false);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [bus, setBus] = useState({ operatorId: '', registrationNo: '', busType: 'AC_SLEEPER', seatLayoutId: '', amenities: 'AC, Charging point' });
  const [lay, setLay] = useState({ name: '', seatType: 'SLEEPER', configuration: '2+1', rows: '6', decks: '2', lowerDeckFareFactor: '1.10' });
  const addBus = useMutation({
    mutationFn: () => api('/buses', { method: 'POST', body: { ...bus, operatorId: bus.operatorId || undefined, amenities: bus.amenities.split(',').map((a) => a.trim()).filter(Boolean) } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['buses'] }); setBusOpen(false); toast('Bus added'); },
  });
  const addLayout = useMutation({
    mutationFn: () => api('/seat-layouts', { method: 'POST', body: { name: lay.name, seatType: lay.seatType, configuration: lay.configuration, rows: Number(lay.rows), decks: Number(lay.decks), lowerDeckFareFactor: lay.seatType === 'SLEEPER' ? Number(lay.lowerDeckFareFactor) : undefined } }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['layouts'] }); setLayoutOpen(false); toast(`Layout created with ${r.data.seatCount} seats`); },
  });
  const toggle = useMutation({
    mutationFn: (b: any) => api(`/buses/${b.id}`, { method: 'PATCH', body: { isActive: !b.isActive } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['buses'] }),
  });
  const be = fieldErrors(addBus.error);
  return (
    <div className="stack">
      <div className="spread"><h1 style={{ fontSize: '1.9rem' }}>Buses & seat layouts</h1><div className="row"><button className="btn secondary" onClick={() => setLayoutOpen(true)}>New layout</button><button className="btn" onClick={() => setBusOpen(true)}>Add bus</button></div></div>
      <div className="panel"><Field label="Find a bus"><input type="search" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Registration number" /></Field></div>
      {buses.error && <ErrorNotice error={buses.error} />}
      {toggle.error && <ErrorNotice error={toggle.error} />}
      {buses.data && (
        <div className="panel flush">
          {buses.data.data.length === 0 ? <Empty title="No buses found" /> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Registration</th><th>Type</th><th>Layout</th><th className="r">Seats</th>{user?.role === 'ADMIN' && <th>Operator</th>}<th>Amenities</th><th>Status</th><th /></tr></thead>
              <tbody>{buses.data.data.map((b: any) => (
                <tr key={b.id}>
                  <td className="mono"><strong>{b.registrationNo}</strong></td><td>{BUS_TYPE[b.busType]}</td><td className="small">{b.layoutName}</td><td className="r num">{b.seatCount}</td>
                  {user?.role === 'ADMIN' && <td className="small">{b.operatorName}</td>}
                  <td className="small muted">{b.amenities.join(', ')}</td>
                  <td>{b.isActive ? <Pill s="SCHEDULED" /> : <Pill s="CANCELLED" />}</td>
                  <td><button className="btn small secondary" onClick={() => toggle.mutate(b)}>{b.isActive ? 'Retire' : 'Reactivate'}</button></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          <Pager meta={buses.data.meta} onPage={setPage} />
        </div>
      )}
      <section className="panel flush">
        <div className="panel-head"><h3>Seat layouts</h3><span className="small muted">Shared templates plus your own</span></div>
        <div className="table-wrap"><table className="data">
          <thead><tr><th>Name</th><th className="r">Seats</th><th className="r">Sleepers</th><th className="r">Decks</th><th>Owner</th></tr></thead>
          <tbody>{layouts.data?.map((l: any) => (
            <tr key={l.id}><td>{l.name}</td><td className="r num">{l.seatCount}</td><td className="r num">{l.sleeperCount}</td><td className="r num">{l.decks}</td><td className="small muted">{l.operatorId ? 'Operator' : 'Shared template'}</td></tr>
          ))}</tbody>
        </table></div>
      </section>

      <Modal open={busOpen} onClose={() => setBusOpen(false)} title="Add bus"
        footer={<><button className="btn secondary" onClick={() => setBusOpen(false)}>Discard</button><button className="btn" disabled={addBus.isPending} onClick={() => addBus.mutate()}>Add bus</button></>}>
        <div className="stack">
          <OperatorPicker value={bus.operatorId} onChange={(v) => setBus({ ...bus, operatorId: v })} />
          <Field label="Registration number" error={be.registrationNo} hint="e.g. TS09AB1234"><input value={bus.registrationNo} onChange={(e) => setBus({ ...bus, registrationNo: e.target.value })} /></Field>
          <div className="grid-2">
            <Field label="Bus type"><select value={bus.busType} onChange={(e) => setBus({ ...bus, busType: e.target.value })}>{Object.entries(BUS_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Seat layout" error={be.seatLayoutId}><select value={bus.seatLayoutId} onChange={(e) => setBus({ ...bus, seatLayoutId: e.target.value })}><option value="">Choose</option>{layouts.data?.map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
          </div>
          <Field label="Amenities" hint="Comma separated"><input value={bus.amenities} onChange={(e) => setBus({ ...bus, amenities: e.target.value })} /></Field>
          {addBus.error && !Object.keys(be).length && <ErrorNotice error={addBus.error} />}
        </div>
      </Modal>
      <Modal open={layoutOpen} onClose={() => setLayoutOpen(false)} title="New seat layout"
        footer={<><button className="btn secondary" onClick={() => setLayoutOpen(false)}>Discard</button><button className="btn" disabled={addLayout.isPending} onClick={() => addLayout.mutate()}>Create layout</button></>}>
        <div className="stack">
          <Field label="Name"><input value={lay.name} onChange={(e) => setLay({ ...lay, name: e.target.value })} placeholder="Sleeper 2+1 • 36 berths" /></Field>
          <div className="grid-2">
            <Field label="Seat type"><select value={lay.seatType} onChange={(e) => setLay({ ...lay, seatType: e.target.value, decks: e.target.value === 'SEATER' ? '1' : lay.decks })}><option value="SLEEPER">Sleeper berths</option><option value="SEATER">Seats</option></select></Field>
            <Field label="Arrangement"><select value={lay.configuration} onChange={(e) => setLay({ ...lay, configuration: e.target.value })}><option>1+1</option><option>2+1</option><option>2+2</option></select></Field>
            <Field label="Rows"><input type="number" min={2} max={15} value={lay.rows} onChange={(e) => setLay({ ...lay, rows: e.target.value })} /></Field>
            <Field label="Decks"><select value={lay.decks} disabled={lay.seatType === 'SEATER'} onChange={(e) => setLay({ ...lay, decks: e.target.value })}><option value="1">1</option><option value="2">2 (lower + upper)</option></select></Field>
            {lay.seatType === 'SLEEPER' && <Field label="Lower berth price factor" hint="1.10 = 10% more"><input type="number" step="0.05" value={lay.lowerDeckFareFactor} onChange={(e) => setLay({ ...lay, lowerDeckFareFactor: e.target.value })} /></Field>}
          </div>
          <p className="small muted">Creates {Number(lay.rows) * lay.configuration.split('+').map(Number).reduce((a, b) => a + b, 0) * Number(lay.decks)} seats.</p>
          {addLayout.error && <ErrorNotice error={addLayout.error} />}
        </div>
      </Modal>
    </div>
  );
}

/* ---------------------------------------------------------------- policy */

export function PolicyPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [operatorId, setOperatorId] = useState(user?.operatorId ?? '');
  const policy = useQuery({ queryKey: ['policy', operatorId], queryFn: async () => (await api(`/operators/${operatorId}/cancellation-policy`)).data, enabled: Boolean(operatorId) });
  const [rules, setRules] = useState<{ minHoursBeforeDeparture: number; refundPercent: number }[]>([]);
  useEffect(() => { if (policy.data) setRules(policy.data.rules); }, [policy.data]);
  const save = useMutation({
    mutationFn: () => api(`/operators/${operatorId}/cancellation-policy`, { method: 'PUT', body: { rules } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['policy', operatorId] }); toast('Policy saved. It applies to bookings made from now on.'); },
  });
  const sorted = [...rules].sort((a, b) => b.minHoursBeforeDeparture - a.minHoursBeforeDeparture);
  const lowest = sorted.length ? sorted[sorted.length - 1].minHoursBeforeDeparture : 0;
  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <h1 style={{ fontSize: '1.9rem' }}>Cancellation policy</h1>
      <p className="muted">Each tier sets the refund for cancelling at least that many hours before the passenger boards. Every booking keeps a copy of the policy in force when it was made, so edits here never change existing tickets.</p>
      {user?.role === 'ADMIN' && <div className="panel"><OperatorPicker value={operatorId} onChange={setOperatorId} /></div>}
      {policy.isLoading && <Skeleton h={200} />}
      {policy.error && <ErrorNotice error={policy.error} />}
      {policy.data && (
        <div className="panel stack">
          {rules.map((r, i) => (
            <div className="row" key={i}>
              <Field label="At least (hours)"><input type="number" min={0} value={r.minHoursBeforeDeparture} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, minHoursBeforeDeparture: Number(e.target.value) } : x)))} /></Field>
              <Field label="Refund %"><input type="number" min={0} max={100} value={r.refundPercent} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, refundPercent: Number(e.target.value) } : x)))} /></Field>
              <button className="btn ghost small" style={{ marginTop: '1.4rem' }} disabled={rules.length <= 1} onClick={() => setRules(rules.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          <div><button className="btn secondary small" onClick={() => setRules([...rules, { minHoursBeforeDeparture: 0, refundPercent: 0 }])} disabled={rules.length >= 10}>Add tier</button></div>
          <div className="notice info small">
            <strong>Passengers will see:</strong>
            <ul style={{ margin: '0.3rem 0 0', paddingLeft: '1.1rem' }}>
              {sorted.map((r, i) => <li key={i}>{r.minHoursBeforeDeparture}+ hours before boarding: {r.refundPercent}% back</li>)}
              {lowest > 0 && <li>Under {lowest} hours: no cancellation</li>}
            </ul>
          </div>
          {save.error && <ErrorNotice error={save.error} />}
          <div><button className="btn" disabled={save.isPending} onClick={() => save.mutate()}>Save policy</button></div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- operators (admin) */

export function OperatorsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const ops = useQuery({ queryKey: ['operators'], queryFn: async () => (await api('/operators')).data });
  const [open, setOpen] = useState(false);
  const [staffFor, setStaffFor] = useState<any>(null);
  const [f, setF] = useState({ name: '', code: '', contactEmail: '', contactPhone: '' });
  const [s, setS] = useState({ fullName: '', email: '', password: '' });
  const create = useMutation({ mutationFn: () => api('/operators', { method: 'POST', body: f }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['operators'] }); setOpen(false); toast('Operator created with the default cancellation policy'); } });
  const addStaff = useMutation({ mutationFn: () => api(`/operators/${staffFor.id}/staff`, { method: 'POST', body: s }), onSuccess: () => { setStaffFor(null); toast('Staff login created'); } });
  const toggle = useMutation({ mutationFn: (o: any) => api(`/operators/${o.id}`, { method: 'PATCH', body: { isActive: !o.isActive } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['operators'] }) });
  const fe = fieldErrors(create.error);
  return (
    <div className="stack">
      <div className="spread"><h1 style={{ fontSize: '1.9rem' }}>Operators</h1><button className="btn" onClick={() => setOpen(true)}>New operator</button></div>
      {ops.error && <ErrorNotice error={ops.error} />}
      <div className="panel flush"><div className="table-wrap"><table className="data">
        <thead><tr><th>Name</th><th>Code</th><th>Contact</th><th className="r">Buses</th><th className="r">Routes</th><th>Status</th><th /></tr></thead>
        <tbody>{ops.data?.map((o: any) => (
          <tr key={o.id}><td><strong>{o.name}</strong></td><td className="mono">{o.code}</td><td className="small">{o.contactEmail}<div className="muted">{o.contactPhone}</div></td><td className="r num">{o.busCount}</td><td className="r num">{o.routeCount}</td>
            <td>{o.isActive ? <Pill s="SCHEDULED" /> : <Pill s="CANCELLED" />}</td>
            <td><div className="row" style={{ flexWrap: 'nowrap' }}><button className="btn small secondary" onClick={() => setStaffFor(o)}>Add staff</button><button className="btn small ghost" onClick={() => toggle.mutate(o)}>{o.isActive ? 'Suspend' : 'Reinstate'}</button></div></td></tr>
        ))}</tbody>
      </table></div></div>
      <Modal open={open} onClose={() => setOpen(false)} title="New operator" footer={<><button className="btn secondary" onClick={() => setOpen(false)}>Discard</button><button className="btn" onClick={() => create.mutate()} disabled={create.isPending}>Create</button></>}>
        <div className="stack">
          <Field label="Name" error={fe.name}><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Code" error={fe.code} hint="2–5 letters, used as the PNR prefix"><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} maxLength={5} /></Field>
          <Field label="Contact email" error={fe.contactEmail}><input type="email" value={f.contactEmail} onChange={(e) => setF({ ...f, contactEmail: e.target.value })} /></Field>
          <Field label="Contact phone" error={fe.contactPhone}><input value={f.contactPhone} onChange={(e) => setF({ ...f, contactPhone: e.target.value })} /></Field>
          {create.error && !Object.keys(fe).length && <ErrorNotice error={create.error} />}
        </div>
      </Modal>
      <Modal open={Boolean(staffFor)} onClose={() => setStaffFor(null)} title={`Staff login for ${staffFor?.name ?? ''}`} footer={<><button className="btn secondary" onClick={() => setStaffFor(null)}>Discard</button><button className="btn" onClick={() => addStaff.mutate()} disabled={addStaff.isPending}>Create login</button></>}>
        <div className="stack">
          <Field label="Full name"><input value={s.fullName} onChange={(e) => setS({ ...s, fullName: e.target.value })} /></Field>
          <Field label="Email"><input type="email" value={s.email} onChange={(e) => setS({ ...s, email: e.target.value })} /></Field>
          <Field label="Temporary password" hint="8+ characters"><input type="password" value={s.password} onChange={(e) => setS({ ...s, password: e.target.value })} /></Field>
          {addStaff.error && <ErrorNotice error={addStaff.error} />}
        </div>
      </Modal>
    </div>
  );
}
