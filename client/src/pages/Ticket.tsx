import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Empty, ErrorNotice, Modal, Pager, Pill, Skeleton, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { BUS_TYPE, dateLong, dateShort, dateTime, duration, inr, time, titleCase } from '../lib/format';

function Qr({ text }: { text: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    QRCode.toDataURL(text, { margin: 0, width: 268, color: { dark: '#0e5a3a', light: '#ffffff' } }).then(setSrc).catch(() => setSrc(''));
  }, [text]);
  return src ? <img className="qr" src={src} alt="QR code with PNR for boarding" /> : <div className="qr" />;
}

function CancelDialog({ b, open, onClose }: { b: any; open: boolean; onClose: () => void }) {
  const active = b.tickets.filter((t: any) => t.status === 'CONFIRMED');
  const [ids, setIds] = useState<string[]>(active.map((t: any) => t.id));
  const qc = useQueryClient();
  const toast = useToast();
  useEffect(() => {
    if (open) setIds(active.map((t: any) => t.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const quote = useQuery({
    queryKey: ['quote', b.pnr, ids],
    queryFn: async () => (await api(`/bookings/${b.pnr}/cancellation-quote`, { query: { ticketIds: ids.join(',') } })).data,
    enabled: open && ids.length > 0,
    retry: false,
  });
  const cancel = useMutation({
    mutationFn: () => api(`/bookings/${b.pnr}/cancel`, { method: 'POST', body: { ticketIds: ids } }),
    onSuccess: (r) => {
      qc.setQueryData(['booking', b.pnr], r.data);
      qc.invalidateQueries({ queryKey: ['bookings'] });
      toast(`Cancelled. Refund of ${inr(r.data.refunds.at(-1).amountPaise)} is on its way.`);
      onClose();
    },
  });
  const q = quote.data;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Cancel tickets"
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>Keep my tickets</button>
          <button className="btn danger" disabled={!ids.length || !q?.allowed || cancel.isPending} onClick={() => cancel.mutate()}>
            {cancel.isPending ? 'Cancelling…' : `Cancel ${ids.length} ticket${ids.length === 1 ? '' : 's'}`}
          </button>
        </>
      }
    >
      <div className="stack">
        <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack">
          <legend className="small muted">Choose who is not travelling</legend>
          {active.map((t: any) => (
            <label key={t.id} className="row" style={{ fontWeight: 600 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={ids.includes(t.id)} onChange={(e) => setIds(e.target.checked ? [...ids, t.id] : ids.filter((x) => x !== t.id))} />
              Seat {t.seatLabel} • {t.passengerName} • {inr(t.farePaise)}
            </label>
          ))}
        </fieldset>
        {quote.isLoading && ids.length > 0 && <Skeleton h={60} />}
        {quote.error && <ErrorNotice error={quote.error} />}
        {q && (q.allowed ? (
          <div className="notice info">
            You are cancelling {q.hoursBeforeDeparture.toFixed(1)} hours before boarding, so <strong>{q.refundPercent}%</strong> of the fare comes back:
            <strong> {inr(q.totalRefundPaise)}</strong> of {inr(q.totalFarePaise)}.
          </div>
        ) : (
          <div className="notice error">Cancellation closed {q.hoursBeforeDeparture < 0 ? 'after departure' : `with ${q.hoursBeforeDeparture.toFixed(1)} hours to go`}. The policy on this ticket does not allow it.</div>
        ))}
        {cancel.error && <ErrorNotice error={cancel.error} />}
      </div>
    </Modal>
  );
}

export function TicketPage() {
  const { pnr } = useParams();
  const [sp] = useSearchParams();
  const { user } = useAuth();
  const [cancelOpen, setCancelOpen] = useState(false);
  const q = useQuery({ queryKey: ['booking', pnr], queryFn: async () => (await api(`/bookings/${pnr}`)).data });
  if (q.isLoading) return <main className="page"><Skeleton h={420} /></main>;
  if (q.error) return <main className="page"><ErrorNotice error={q.error} /></main>;
  const b = q.data;
  const active = b.tickets.filter((t: any) => t.status === 'CONFIRMED');
  const canCancel = active.length > 0 && b.tripStatus === 'SCHEDULED';
  const minutes = (new Date(b.drop.time).getTime() - new Date(b.boarding.time).getTime()) / 60000;

  return (
    <main className="page stack">
      {sp.get('new') && <div className="notice ok no-print" role="status"><strong>Booked.</strong> Your PNR is {b.pnr}. Show the QR code or PNR to the crew when boarding.</div>}
      <article className="ticket" aria-label={`Ticket ${b.pnr}`}>
        <div style={{ display: 'grid' }}>
          <div className="ticket-band">
            <div>
              <div className="small" style={{ opacity: 0.85 }}>PNR</div>
              <div className="pnr">{b.pnr}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontWeight: 800 }}>{b.operatorName}</div>
              <div className="small" style={{ opacity: 0.85 }}>{BUS_TYPE[b.busType]} • {b.registrationNo}</div>
            </div>
          </div>
          <div className="ticket-main">
            <div className="spread">
              <h2 style={{ fontSize: '1.25rem' }}>{b.boarding.city} to {b.drop.city}</h2>
              <Pill s={b.status} />
            </div>
            <div className="routeline">
              <div><div className="t">{time(b.boarding.time)}</div><div className="p">{dateShort(b.boarding.time)}</div></div>
              <div className="track"><span className="dur">{duration(minutes)} • {b.distanceKm} km</span></div>
              <div><div className="t">{time(b.drop.time)}</div><div className="p">{dateShort(b.drop.time)}</div></div>
            </div>
            <div className="kv">
              <div><span>Boarding point</span><strong>{b.boarding.pointName}</strong></div>
              <div><span>Drop point</span><strong>{b.drop.pointName}</strong></div>
              <div><span>Journey date</span><strong>{dateLong(b.boarding.time)}</strong></div>
              <div><span>Route</span><strong>{b.routeName}</strong></div>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Seat</th><th>Passenger</th><th>Age • gender</th><th className="r">Fare</th><th>Status</th></tr></thead>
                <tbody>
                  {b.tickets.map((t: any) => (
                    <tr key={t.id}>
                      <td><strong className="mono">{t.seatLabel}</strong> <span className="muted small">{t.seatType === 'SLEEPER' ? (t.deck === 1 ? 'lower berth' : 'upper berth') : 'seat'}</span></td>
                      <td>{t.passengerName}</td>
                      <td>{t.passengerAge} • {titleCase(t.passengerGender)}</td>
                      <td className="r num">{inr(t.farePaise)}</td>
                      <td><Pill s={t.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {b.refunds.length > 0 && (
              <div className="stack" style={{ ['--gap' as any]: '0.5rem' }}>
                <h3>Refunds</h3>
                {b.refunds.map((r: any) => (
                  <div key={r.id} className="spread small">
                    <span>{r.reason === 'TRIP_CANCELLED' ? 'Operator cancelled the trip' : 'You cancelled'} • {r.percent}% • {dateTime(r.createdAt)}</span>
                    <span className="row"><strong>{inr(r.amountPaise)}</strong> <Pill s={r.status} /></span>
                  </div>
                ))}
              </div>
            )}
            <details className="small">
              <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Cancellation policy on this ticket</summary>
              <p className="muted" style={{ margin: '0.5rem 0' }}>Fixed when you booked. Later policy changes by the operator do not affect it.</p>
              <ul>
                {b.policySnapshot.map((r: any) => (
                  <li key={r.minHoursBeforeDeparture}>{r.minHoursBeforeDeparture}+ hours before boarding: {r.refundPercent}% refund</li>
                ))}
                <li>Less than {Math.min(...b.policySnapshot.map((r: any) => r.minHoursBeforeDeparture))} hours: cannot be cancelled</li>
              </ul>
            </details>
          </div>
        </div>
        <aside className="ticket-stub">
          <Qr text={`SAFAR|${b.pnr}|${b.tripId}|${active.map((t: any) => t.seatLabel).join(',')}`} />
          <div><span className="small muted">Total paid</span><div style={{ fontSize: '1.4rem', fontWeight: 800 }}>{inr(b.totalFarePaise)}</div></div>
          <div className="small"><span className="muted">Payment ref</span><br /><span className="mono">{b.paymentReference}</span></div>
          <div className="small"><span className="muted">Booked</span><br />{dateTime(b.createdAt)}</div>
          <div className="small"><span className="muted">Operator helpline</span><br />{b.operatorPhone}</div>
        </aside>
      </article>
      <div className="row no-print">
        <button className="btn secondary" onClick={() => window.print()}>Print ticket</button>
        {canCancel && <button className="btn secondary" style={{ color: 'var(--danger)' }} onClick={() => setCancelOpen(true)}>Cancel tickets</button>}
        {user?.role === 'PASSENGER' && <Link className="btn ghost" to="/my-trips">All my trips</Link>}
      </div>
      {canCancel && <CancelDialog b={b} open={cancelOpen} onClose={() => setCancelOpen(false)} />}
    </main>
  );
}

export function MyTripsPage() {
  const [upcoming, setUpcoming] = useState<'true' | 'false'>('true');
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['bookings', 'mine', upcoming, page], queryFn: () => api('/bookings', { query: { upcoming, page, pageSize: 10 } }) });
  return (
    <main className="page stack">
      <h1 style={{ fontSize: '2rem' }}>My trips</h1>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={upcoming === 'true'} onClick={() => { setUpcoming('true'); setPage(1); }}>Upcoming</button>
        <button role="tab" aria-selected={upcoming === 'false'} onClick={() => { setUpcoming('false'); setPage(1); }}>Past</button>
      </div>
      {q.isLoading && <Skeleton h={90} count={3} />}
      {q.error && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {q.data?.data.length === 0 && (
        <div className="panel"><Empty title={upcoming === 'true' ? 'No upcoming trips' : 'No past trips yet'}><p><Link to="/">Find a bus</Link></p></Empty></div>
      )}
      {q.data && q.data.data.length > 0 && (
        <div className="panel flush">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Journey</th><th>Boarding</th><th>Seats</th><th>PNR</th><th>Status</th><th className="r">Fare</th></tr></thead>
              <tbody>
                {q.data.data.map((b: any) => (
                  <tr key={b.pnr}>
                    <td><strong>{b.fromCity} to {b.toCity}</strong><div className="small muted">{b.operatorName}</div></td>
                    <td>{dateShort(b.boardAt)}, {time(b.boardAt)}</td>
                    <td className="mono">{b.seats}</td>
                    <td><Link className="mono" to={`/bookings/${b.pnr}`}>{b.pnr}</Link></td>
                    <td><Pill s={b.status} /></td>
                    <td className="r num">{inr(b.totalFarePaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager meta={q.data.meta} onPage={setPage} />
        </div>
      )}
    </main>
  );
}
