import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, ErrorNotice, Field, Modal, Pager, Pill, Skeleton, useToast } from '../../components/ui';
import { api } from '../../lib/api';
import { dateTime, inr, istToday, serviceDate, time, titleCase } from '../../lib/format';

function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export function BookingsPage() {
  const [text, setText] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const qtext = useDebounced(text);
  useEffect(() => setPage(1), [qtext, status]);
  const q = useQuery({ queryKey: ['bookings', 'staff', qtext, status, page], queryFn: () => api('/bookings', { query: { q: qtext, status, page, pageSize: 20 } }) });
  return (
    <div className="stack">
      <h1 style={{ fontSize: '1.9rem' }}>Bookings</h1>
      <div className="panel grid-2">
        <Field label="Search" hint="PNR, passenger name, phone or email"><input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. DS7K or Meera" /></Field>
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any</option>
            {['CONFIRMED', 'PARTIALLY_CANCELLED', 'CANCELLED'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </select>
        </Field>
      </div>
      {q.isLoading && <Skeleton h={300} />}
      {q.error && <ErrorNotice error={q.error} />}
      {q.data && (
        <div className="panel flush">
          {q.data.data.length === 0 ? <Empty title="No bookings match"><p>Try a shorter search or clear the status filter.</p></Empty> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>PNR</th><th>Lead passenger</th><th>Journey</th><th>Boards</th><th>Seats</th><th>Status</th><th className="r">Fare</th></tr></thead>
                <tbody>
                  {q.data.data.map((b: any) => (
                    <tr key={b.pnr}>
                      <td><Link className="mono" to={`/bookings/${b.pnr}`}>{b.pnr}</Link></td>
                      <td>{b.leadPassenger}<div className="small muted num">{b.contactPhone}</div></td>
                      <td>{b.fromCity} to {b.toCity}<div className="small muted">{b.operatorName}</div></td>
                      <td className="small">{serviceDate(b.serviceDate)} • {time(b.boardAt)}</td>
                      <td className="mono small">{b.seats}</td>
                      <td><Pill s={b.status} /></td>
                      <td className="r num">{inr(b.totalFarePaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager meta={q.data.meta} onPage={setPage} />
        </div>
      )}
    </div>
  );
}

export function RefundsPage() {
  const [status, setStatus] = useState('PENDING');
  const [page, setPage] = useState(1);
  const [failing, setFailing] = useState<any>(null);
  const [note, setNote] = useState('');
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['refunds', status, page], queryFn: () => api('/refunds', { query: { status, page } }) });
  const move = useMutation({
    mutationFn: ({ id, to, note }: { id: string; to: string; note?: string }) => api(`/refunds/${id}/transition`, { method: 'POST', body: { status: to, note } }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['refunds'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      setFailing(null);
      setNote('');
      toast(r.data.status === 'PROCESSED' ? `Refund paid • ${r.data.reference}` : `Refund marked ${r.data.status.toLowerCase()}`);
    },
  });
  return (
    <div className="stack">
      <h1 style={{ fontSize: '1.9rem' }}>Refunds</h1>
      <p className="muted" style={{ maxWidth: '65ch' }}>Payouts are simulated. Mark a refund paid to issue a gateway reference, or failed with a note — a failed refund can be retried.</p>
      <div className="tabs" role="tablist">
        {['PENDING', 'FAILED', 'PROCESSED', ''].map((s) => (
          <button key={s || 'all'} role="tab" aria-selected={status === s} onClick={() => { setStatus(s); setPage(1); }}>{s ? titleCase(s) : 'All'}</button>
        ))}
      </div>
      {move.error && <ErrorNotice error={move.error} />}
      {q.isLoading && <Skeleton h={200} />}
      {q.error && <ErrorNotice error={q.error} />}
      {q.data && (
        <div className="panel flush">
          {q.data.data.length === 0 ? <Empty title={status === 'PENDING' ? 'Nothing waiting' : 'No refunds here'} /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>PNR</th><th>Route • travel date</th><th>Reason</th><th className="r">Amount</th><th>Status</th><th>Raised</th><th /></tr></thead>
                <tbody>
                  {q.data.data.map((r: any) => (
                    <tr key={r.id}>
                      <td><Link className="mono" to={`/bookings/${r.pnr}`}>{r.pnr}</Link></td>
                      <td className="small">{r.routeName}<div className="muted">{serviceDate(r.serviceDate)}</div></td>
                      <td className="small">{r.reason === 'TRIP_CANCELLED' ? 'Trip cancelled' : 'Passenger'} • {r.percent}%</td>
                      <td className="r num"><strong>{inr(r.amountPaise)}</strong></td>
                      <td><Pill s={r.status} />{r.reference && <div className="mono small muted">{r.reference}</div>}{r.failureNote && <div className="small muted">{r.failureNote}</div>}</td>
                      <td className="small">{dateTime(r.createdAt)}</td>
                      <td>
                        <div className="row" style={{ flexWrap: 'nowrap' }}>
                          {r.status === 'PENDING' && (
                            <>
                              <button className="btn small" disabled={move.isPending} onClick={() => move.mutate({ id: r.id, to: 'PROCESSED' })}>Mark paid</button>
                              <button className="btn small secondary" onClick={() => setFailing(r)}>Mark failed</button>
                            </>
                          )}
                          {r.status === 'FAILED' && <button className="btn small secondary" onClick={() => move.mutate({ id: r.id, to: 'PENDING' })}>Retry</button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager meta={q.data.meta} onPage={setPage} />
        </div>
      )}
      <Modal open={Boolean(failing)} onClose={() => setFailing(null)} title="Mark refund failed"
        footer={<><button className="btn secondary" onClick={() => setFailing(null)}>Go back</button><button className="btn danger" disabled={!note.trim()} onClick={() => move.mutate({ id: failing.id, to: 'FAILED', note })}>Mark failed</button></>}>
        <Field label="What went wrong?"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Bank account closed" /></Field>
      </Modal>
    </div>
  );
}

export function ReportsPage() {
  const [from, setFrom] = useState(istToday(0));
  const [to, setTo] = useState(istToday(14));
  const [groupBy, setGroupBy] = useState<'day' | 'route'>('day');
  const summary = useQuery({ queryKey: ['summary', from, to, groupBy], queryFn: async () => (await api('/reports/booking-summary', { query: { from, to, groupBy } })).data });
  const plus2 = new Date(Date.parse(from + 'T00:00:00Z') + 2 * 86_400_000).toISOString().slice(0, 10);
  const schedTo = plus2 < to ? plus2 : to;
  const sched = useQuery({ queryKey: ['route-schedules', from, schedTo], queryFn: async () => (await api('/reports/route-schedules', { query: { from, to: schedTo } })).data });
  const tot = summary.data?.totals ?? {};
  return (
    <div className="stack">
      <h1 style={{ fontSize: '1.9rem' }}>Reports</h1>
      <div className="panel grid-3">
        <Field label="Travel date from"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Travel date to"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Group by">
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as any)}><option value="day">Travel date</option><option value="route">Route</option></select>
        </Field>
      </div>
      <section className="panel flush">
        <div className="panel-head"><h3>Booking summary</h3></div>
        {summary.isLoading && <div className="modal-body"><Skeleton h={160} /></div>}
        {summary.error && <div className="modal-body"><ErrorNotice error={summary.error} /></div>}
        {summary.data && (summary.data.data.length === 0 ? <Empty title="No bookings for these dates" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>{groupBy === 'day' ? 'Travel date' : 'Route'}</th><th className="r">Bookings</th><th className="r">Tickets sold</th><th className="r">Active</th><th className="r">Cancelled</th><th className="r">Gross</th><th className="r">Refunds</th><th className="r">Net</th></tr></thead>
              <tbody>
                {summary.data.data.map((r: any) => (
                  <tr key={r.group}>
                    <td>{groupBy === 'day' ? serviceDate(r.group) : r.group}</td>
                    <td className="r num">{r.bookings}</td><td className="r num">{r.ticketsSold}</td><td className="r num">{r.ticketsActive}</td><td className="r num">{r.ticketsCancelled}</td>
                    <td className="r num">{inr(r.grossPaise)}</td><td className="r num">{inr(r.refundPaise)}</td><td className="r num"><strong>{inr(r.netPaise)}</strong></td>
                  </tr>
                ))}
                <tr style={{ fontWeight: 800 }}>
                  <td>Total</td><td className="r num">{tot.bookings}</td><td className="r num">{tot.ticketsSold}</td><td className="r num">{tot.ticketsActive}</td><td className="r num">{tot.ticketsCancelled}</td>
                  <td className="r num">{inr(tot.grossPaise ?? 0)}</td><td className="r num">{inr(tot.refundPaise ?? 0)}</td><td className="r num">{inr(tot.netPaise ?? 0)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ))}
      </section>
      <section className="panel flush">
        <div className="panel-head"><h3>Route timetable • next 3 days from start date</h3></div>
        {sched.data?.map((r: any) => (
          <div key={r.routeId} style={{ borderBottom: '1px solid var(--line)' }}>
            <div className="modal-body" style={{ paddingBottom: 0 }}><strong>{r.routeCode}</strong> <span className="muted">{r.routeName}</span></div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Date</th><th>Departs</th><th>Arrives</th><th>Bus</th><th className="r">Sold</th><th>Status</th></tr></thead>
                <tbody>
                  {r.trips.map((t: any) => (
                    <tr key={t.tripId}><td>{serviceDate(t.serviceDate)}</td><td><Link to={`/console/trips/${t.tripId}`}>{time(t.departsAt)}</Link></td><td>{time(t.arrivesAt)}</td><td className="mono small">{t.registrationNo}</td><td className="r num">{t.seatsSold}/{t.seatCount}</td><td><Pill s={t.status} /></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

export function AuditPage() {
  const [action, setAction] = useState('');
  const [entityId, setEntityId] = useState('');
  const [page, setPage] = useState(1);
  const eid = useDebounced(entityId);
  const q = useQuery({ queryKey: ['audit', action, eid, page], queryFn: () => api('/audit-logs', { query: { action, entityId: eid, page, pageSize: 25 } }) });
  const ACTIONS = ['BOOKING_CONFIRMED', 'BOOKING_CANCELLED', 'BOOKING_CANCELLED_BY_OPERATOR', 'SEATS_HELD', 'TRIP_CANCELLED', 'TRIP_DEPARTED', 'REFUND_PROCESSED', 'REFUND_FAILED', 'CANCELLATION_POLICY_UPDATED', 'TRIPS_GENERATED', 'ROUTE_CREATED', 'BUS_CREATED', 'SCHEDULE_CREATED'];
  return (
    <div className="stack">
      <h1 style={{ fontSize: '1.9rem' }}>Audit trail</h1>
      <p className="muted" style={{ maxWidth: '65ch' }}>Every material action, written in the same database transaction as the change itself. Entries cannot be edited or deleted.</p>
      <div className="panel grid-2">
        <Field label="Action"><select value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}><option value="">All actions</option>{ACTIONS.map((a) => <option key={a} value={a}>{titleCase(a)}</option>)}</select></Field>
        <Field label="Entity" hint="PNR, trip id, refund id…"><input value={entityId} onChange={(e) => { setEntityId(e.target.value.trim()); setPage(1); }} /></Field>
      </div>
      {q.error && <ErrorNotice error={q.error} />}
      {q.isLoading && <Skeleton h={300} />}
      {q.data && (
        <div className="panel flush">
          {q.data.data.length === 0 ? <Empty title="No entries" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>When</th><th>Action</th><th>Entity</th><th>By</th><th>Details</th></tr></thead>
                <tbody>
                  {q.data.data.map((a: any) => (
                    <tr key={a.id}>
                      <td className="small" style={{ whiteSpace: 'nowrap' }}>{dateTime(a.createdAt)}</td>
                      <td><strong className="small">{titleCase(a.action)}</strong></td>
                      <td className="small">{a.entityType}<div className="mono muted">{String(a.entityId).slice(0, 12)}</div></td>
                      <td className="small">{a.actorName ?? 'System'}<div className="muted">{a.actorRole && titleCase(a.actorRole)}</div></td>
                      <td><code className="small" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', display: 'block', maxWidth: 420 }}>{JSON.stringify(a.details)}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager meta={q.data.meta} onPage={setPage} />
        </div>
      )}
    </div>
  );
}
