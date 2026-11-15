import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { ErrorNotice, Skeleton } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { dateShort, inr, serviceDate, time } from '../../lib/format';

export function ConsoleLayout() {
  const { user } = useAuth();
  return (
    <div className="console">
      <nav className="sidenav" aria-label="Operations">
        <div className="group">Today</div>
        <NavLink to="/console" end>Dashboard</NavLink>
        <NavLink to="/console/trips">Trips & manifests</NavLink>
        <NavLink to="/console/bookings">Bookings</NavLink>
        <NavLink to="/console/refunds">Refunds</NavLink>
        <div className="group">Network</div>
        <NavLink to="/console/routes">Routes & schedules</NavLink>
        <NavLink to="/console/fleet">Buses & layouts</NavLink>
        <NavLink to="/console/policy">Cancellation policy</NavLink>
        {user?.role === 'ADMIN' && <NavLink to="/console/operators">Operators</NavLink>}
        <div className="group">Insight</div>
        <NavLink to="/console/reports">Reports</NavLink>
        <NavLink to="/console/audit">Audit trail</NavLink>
      </nav>
      <div className="console-main">
        <Outlet />
      </div>
    </div>
  );
}

export function DashboardPage() {
  const { operator, user } = useAuth();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: async () => (await api('/reports/dashboard')).data, refetchInterval: 30_000 });
  if (q.isLoading) return <Skeleton h={120} count={3} />;
  if (q.error) return <ErrorNotice error={q.error} onRetry={() => q.refetch()} />;
  const { kpis, trend, departures, topRoutes } = q.data;
  const max = Math.max(1, ...trend.map((d: any) => d.grossPaise));
  return (
    <div className="stack">
      <div>
        <h1 style={{ fontSize: '1.9rem' }}>{operator?.name ?? (user?.role === 'ADMIN' ? 'All operators' : 'Dashboard')}</h1>
        <p className="muted">Live view • refreshes every 30 seconds</p>
      </div>
      <div className="kpis">
        <div className="kpi"><div className="v">{kpis.bookingsToday}</div><div className="l">Bookings today</div></div>
        <div className="kpi"><div className="v">{inr(kpis.grossToday)}</div><div className="l">Booked value today</div></div>
        <div className="kpi"><div className="v">{kpis.upcomingTrips7d}</div><div className="l">Trips in next 7 days</div></div>
        <div className="kpi"><div className="v">{kpis.loadFactor7d}%</div><div className="l">Seats sold, next 7 days</div></div>
        <div className="kpi"><div className="v">{kpis.upcomingPassengers}</div><div className="l">Passengers booked ahead</div></div>
        <div className="kpi">
          <div className="v" style={{ color: kpis.pendingRefunds ? '#b07a00' : undefined }}>{kpis.pendingRefunds}</div>
          <div className="l">Refunds waiting • {inr(kpis.pendingRefundPaise)} • <Link to="/console/refunds">review</Link></div>
        </div>
      </div>

      <div className="grid-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <section className="panel stack" aria-label="Bookings over the last 14 days">
          <div className="spread">
            <h3>Last 14 days</h3>
            <span className="legend"><span><i style={{ background: 'var(--nh-green)' }} /> Booked</span><span><i style={{ background: 'var(--signal)', borderColor: 'var(--signal)' }} /> Refunded</span></span>
          </div>
          <div className="bars" role="img" aria-label={trend.map((d: any) => `${d.date}: ${inr(d.grossPaise)} booked`).join('; ')}>
            {trend.map((d: any) => (
              <div key={d.date} style={{ display: 'grid', alignItems: 'end', gap: 2, height: '100%' }} title={`${serviceDate(d.date)} • ${d.bookings} bookings • ${inr(d.grossPaise)} • refunds ${inr(d.refundPaise)}`}>
                <div style={{ display: 'flex', alignItems: 'end', gap: 2, height: '100%' }}>
                  <div className="b" style={{ height: `${(d.grossPaise / max) * 100}%`, flex: 2 }} />
                  <div className="b refund" style={{ height: `${(d.refundPaise / max) * 100}%`, flex: 1 }} />
                </div>
              </div>
            ))}
          </div>
          <div className="spread small muted"><span>{serviceDate(trend[0].date)}</span><span>Today</span></div>
        </section>

        <section className="panel stack">
          <h3>Top routes, last 30 days</h3>
          <table className="data">
            <thead><tr><th>Route</th><th className="r">Bookings</th><th className="r">Net</th></tr></thead>
            <tbody>
              {topRoutes.map((r: any) => (
                <tr key={r.routeCode}><td><strong>{r.routeCode}</strong><div className="small muted">{r.routeName}</div></td><td className="r num">{r.bookings}</td><td className="r num">{inr(r.netPaise)}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <section className="panel flush">
        <div className="panel-head"><h3>Departures in the next 36 hours</h3><Link to="/console/trips">All trips</Link></div>
        {departures.length === 0 ? <p className="empty">No departures in this window.</p> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Departs</th><th>Route</th><th>Bus</th><th>Seats sold</th><th className="r">Passengers</th><th /></tr></thead>
              <tbody>
                {departures.map((d: any) => (
                  <tr key={d.id}>
                    <td><strong>{time(d.departsAt)}</strong> <span className="muted small">{dateShort(d.departsAt)}</span></td>
                    <td>{d.routeCode}</td>
                    <td className="mono small">{d.registrationNo}</td>
                    <td style={{ minWidth: 160 }}>
                      <div className="leg" style={{ gridTemplateColumns: '1fr 60px' }}>
                        <span className="meter"><i style={{ width: `${(d.seatsSold / d.seatCount) * 100}%` }} /></span>
                        <span className="num small">{d.seatsSold}/{d.seatCount}</span>
                      </div>
                    </td>
                    <td className="r num">{d.passengers}</td>
                    <td><Link to={`/console/trips/${d.id}`}>Manifest</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
