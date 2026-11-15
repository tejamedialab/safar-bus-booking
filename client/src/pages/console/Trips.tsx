import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Empty, ErrorNotice, Field, Modal, Pager, Pill, Skeleton, useToast } from '../../components/ui';
import { api } from '../../lib/api';
import { BUS_TYPE, dateShort, inr, istToday, serviceDate, time, titleCase } from '../../lib/format';

export function TripsPage() {
  const [sp, setSp] = useSearchParams();
  const q = { from: sp.get('from') ?? istToday(0), to: sp.get('to') ?? istToday(7), status: sp.get('status') ?? '', routeId: sp.get('routeId') ?? '', page: sp.get('page') ?? '1' };
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    n.set(k, v);
    if (k !== 'page') n.set('page', '1');
    setSp(n);
  };
  const routes = useQuery({ queryKey: ['routes-all'], queryFn: () => api('/routes', { query: { pageSize: 100 } }) });
  const trips = useQuery({ queryKey: ['staff-trips', q], queryFn: () => api('/staff/trips', { query: { ...q, pageSize: 25 } }) });
  return (
    <div className="stack">
      <h1 style={{ fontSize: '1.9rem' }}>Trips & manifests</h1>
      <div className="panel grid-3">
        <Field label="From date"><input type="date" value={q.from} onChange={(e) => set('from', e.target.value)} /></Field>
        <Field label="To date"><input type="date" value={q.to} onChange={(e) => set('to', e.target.value)} /></Field>
        <Field label="Route">
          <select value={q.routeId} onChange={(e) => set('routeId', e.target.value)}>
            <option value="">All routes</option>
            {routes.data?.data.map((r: any) => <option key={r.id} value={r.id}>{r.code}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <select value={q.status} onChange={(e) => set('status', e.target.value)}>
            <option value="">Any status</option>
            {['SCHEDULED', 'DEPARTED', 'COMPLETED', 'CANCELLED'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </select>
        </Field>
      </div>
      {trips.isLoading && <Skeleton h={300} />}
      {trips.error && <ErrorNotice error={trips.error} onRetry={() => trips.refetch()} />}
      {trips.data && (
        <div className="panel flush">
          {trips.data.data.length === 0 ? (
            <Empty title="No trips in this range"><p>Widen the dates, or generate trips from a schedule under <Link to="/console/routes">Routes & schedules</Link>.</p></Empty>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Date</th><th>Departs</th><th>Route</th><th>Operator</th><th>Bus</th><th className="r">Seats sold</th><th className="r">Tickets</th><th>Status</th></tr></thead>
                <tbody>
                  {trips.data.data.map((t: any) => (
                    <tr key={t.id}>
                      <td>{serviceDate(t.serviceDate)}</td>
                      <td><Link to={`/console/trips/${t.id}`}><strong>{time(t.departsAt)}</strong></Link></td>
                      <td>{t.routeCode}</td>
                      <td className="small">{t.operatorName}</td>
                      <td className="mono small">{t.registrationNo}</td>
                      <td className="r num">{t.seatsSold}/{t.seatCount}</td>
                      <td className="r num">{t.confirmedTickets}</td>
                      <td><Pill s={t.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager meta={trips.data.meta} onPage={(p) => set('page', String(p))} />
        </div>
      )}
    </div>
  );
}

const NEXT: Record<string, string[]> = { SCHEDULED: ['DEPARTED', 'CANCELLED'], DEPARTED: ['COMPLETED'], COMPLETED: [], CANCELLED: [] };

export function TripDetailPage() {
  const { tripId } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<'manifest' | 'occupancy' | 'reconcile'>('manifest');
  const [confirm, setConfirm] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const trip = useQuery({ queryKey: ['trip', tripId], queryFn: async () => (await api(`/trips/${tripId}`)).data });
  const manifest = useQuery({ queryKey: ['manifest', tripId], queryFn: async () => (await api(`/reports/trips/${tripId}/manifest`)).data });
  const occ = useQuery({ queryKey: ['occupancy', tripId], queryFn: async () => (await api(`/reports/trips/${tripId}/occupancy`)).data });
  const recon = useQuery({ queryKey: ['recon', tripId], queryFn: async () => (await api(`/reports/trips/${tripId}/reconciliation`)).data });
  const change = useMutation({
    mutationFn: (status: string) => api(`/trips/${tripId}/status`, { method: 'PATCH', body: { status, reason: reason || undefined } }),
    onSuccess: (r) => {
      setConfirm(null);
      setReason('');
      qc.invalidateQueries();
      const a = r.data.affected;
      toast(r.data.status === 'CANCELLED' ? `Trip cancelled. ${a.tickets} tickets refunded in full (${inr(a.refundPaise)}).` : `Trip marked ${r.data.status.toLowerCase()}.`);
    },
  });

  if (trip.error) return <ErrorNotice error={trip.error} />;
  if (!trip.data) return <Skeleton h={300} />;
  const t = trip.data;
  const r = recon.data;

  return (
    <div className="stack">
      <Link to="/console/trips" className="small">All trips</Link>
      <div className="spread">
        <div>
          <h1 style={{ fontSize: '1.7rem' }}>{t.routeCode} • {dateShort(t.departsAt)} {time(t.departsAt)}</h1>
          <p className="muted">{t.routeName} • {BUS_TYPE[t.busType]} {t.registrationNo}</p>
        </div>
        <div className="row">
          <Pill s={t.status} />
          {r && <span className={`recon-badge ${r.reconciled ? 'ok' : 'bad'}`}>{r.reconciled ? '✓ Reconciled' : '✕ Mismatch found'}</span>}
          {NEXT[t.status].map((s) => (
            <button key={s} className={`btn small ${s === 'CANCELLED' ? 'danger' : 'secondary'}`} onClick={() => setConfirm(s)}>
              {s === 'DEPARTED' ? 'Mark departed' : s === 'COMPLETED' ? 'Mark completed' : 'Cancel trip'}
            </button>
          ))}
        </div>
      </div>

      {occ.data && (
        <div className="kpis">
          <div className="kpi"><div className="v">{manifest.data?.totalPassengers ?? '–'}</div><div className="l">Passengers on manifest</div></div>
          <div className="kpi"><div className="v">{occ.data.peakOccupiedSeats}/{occ.data.seatCount}</div><div className="l">Peak seats occupied</div></div>
          <div className="kpi"><div className="v">{occ.data.seatKmUtilisationPercent}%</div><div className="l">Seat-km utilisation</div></div>
          {r && <div className="kpi"><div className="v">{inr(r.money.netRevenuePaise)}</div><div className="l">Net revenue (after refunds)</div></div>}
        </div>
      )}

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'manifest'} onClick={() => setTab('manifest')}>Passenger manifest</button>
        <button role="tab" aria-selected={tab === 'occupancy'} onClick={() => setTab('occupancy')}>Occupancy by leg</button>
        <button role="tab" aria-selected={tab === 'reconcile'} onClick={() => setTab('reconcile')}>Reconciliation</button>
      </div>

      {tab === 'manifest' && (
        <section className="panel flush">
          <div className="panel-head">
            <h3>Manifest • confirmed tickets only</h3>
            <div className="row no-print">
              <a className="btn secondary small" href={`/api/v1/reports/trips/${tripId}/manifest?format=csv`}>Download CSV</a>
              <button className="btn secondary small" onClick={() => window.print()}>Print</button>
            </div>
          </div>
          {manifest.isLoading && <div className="modal-body"><Skeleton h={160} /></div>}
          {manifest.data?.passengers.length === 0 && <Empty title="No passengers yet" />}
          {manifest.data && manifest.data.passengers.length > 0 && (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Seat</th><th>Passenger</th><th>Age</th><th>Boards at</th><th>Gets off at</th><th>PNR</th><th>Phone</th><th className="r">Fare</th></tr></thead>
                <tbody>
                  {manifest.data.passengers.map((p: any) => (
                    <tr key={p.pnr + p.seatLabel + p.fromStop}>
                      <td className="mono"><strong>{p.seatLabel}</strong></td>
                      <td>{p.passengerName} <span className="muted small">{p.passengerGender[0]}</span></td>
                      <td className="num">{p.passengerAge}</td>
                      <td className="small"><strong>{time(p.boardingTime)}</strong> {p.boardingPoint}</td>
                      <td className="small">{p.dropPoint}</td>
                      <td className="mono small">{p.pnr}</td>
                      <td className="small num">{p.contactPhone}</td>
                      <td className="r num">{inr(p.farePaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === 'occupancy' && occ.data && (
        <section className="panel stack">
          <h3>Seats occupied on each leg</h3>
          <p className="small muted">A seat counts on every leg its ticket covers. Seats freed mid-route are resold for the remaining legs.</p>
          <div className="legs">
            {occ.data.legs.map((l: any) => (
              <div className="leg" key={l.leg}>
                <span className="small"><strong>{l.fromPoint}</strong> to {l.toPoint}<span className="muted" style={{ display: 'block' }}>{l.from === l.to ? l.from : `${l.from} to ${l.to}`}, {l.distanceKm} km</span></span>
                <span className="meter" role="img" aria-label={`${l.occupancyPercent}% occupied`}><i style={{ width: `${l.occupancyPercent}%` }} /></span>
                <span className="num small">{l.occupiedSeats}/{occ.data.seatCount}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === 'reconcile' && r && (
        <section className="panel stack">
          <div className="spread">
            <h3>Do the numbers agree?</h3>
            <span className="small muted">Each figure is derived independently from a different query</span>
          </div>
          <div>
            {r.checks.map((c: any) => (
              <div className="check" key={c.key}>
                <span className={`mark ${c.pass ? 'ok' : 'bad'}`} aria-label={c.pass ? 'Passed' : 'Failed'}>{c.pass ? '✓' : '✕'}</span>
                <span>{c.label}</span>
                <span className="num small muted">expected {String(c.expected)} • actual {String(c.actual)}</span>
              </div>
            ))}
          </div>
          <div className="kv">
            <div><span>Booked</span><strong>{inr(r.money.grossBookedPaise)}</strong></div>
            <div><span>Cancelled fares</span><strong>{inr(r.money.cancelledFarePaise)}</strong></div>
            <div><span>Refunded</span><strong>{inr(r.money.refundedPaise)}</strong></div>
            <div><span>Net revenue</span><strong>{inr(r.money.netRevenuePaise)}</strong></div>
          </div>
        </section>
      )}

      <Modal
        open={Boolean(confirm)}
        onClose={() => setConfirm(null)}
        title={confirm === 'CANCELLED' ? 'Cancel this trip?' : `Mark trip ${confirm?.toLowerCase()}?`}
        footer={
          <>
            <button className="btn secondary" onClick={() => setConfirm(null)}>Go back</button>
            <button className={`btn ${confirm === 'CANCELLED' ? 'danger' : ''}`} disabled={change.isPending || (confirm === 'CANCELLED' && !reason.trim())} onClick={() => change.mutate(confirm!)}>
              {confirm === 'CANCELLED' ? 'Cancel trip and refund everyone' : 'Confirm'}
            </button>
          </>
        }
      >
        <div className="stack">
          {confirm === 'CANCELLED' && (
            <>
              <div className="notice warn">All {manifest.data?.totalPassengers ?? 0} passengers get a 100% refund and the trip closes for booking. This cannot be undone.</div>
              <Field label="Reason shown in the audit trail"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Bus breakdown at depot" /></Field>
            </>
          )}
          {confirm === 'DEPARTED' && <p>Booking and cancellation close for this trip.</p>}
          {change.error && <ErrorNotice error={change.error} />}
        </div>
      </Modal>
    </div>
  );
}
