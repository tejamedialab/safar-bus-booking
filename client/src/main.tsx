import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { RequireAuth, Shell } from './components/Layout';
import { Empty, ToastProvider } from './components/ui';
import { ApiError } from './lib/api';
import { AuthProvider } from './lib/auth';
import { LoginPage, RegisterPage } from './pages/Auth';
import { CheckoutPage, TripSeatsPage } from './pages/Booking';
import { ConsoleLayout, DashboardPage } from './pages/console/Dashboard';
import { AuditPage, BookingsPage, RefundsPage, ReportsPage } from './pages/console/Ledger';
import { FleetPage, OperatorsPage, PolicyPage, RouteDetailPage, RoutesPage } from './pages/console/Network';
import { TripDetailPage, TripsPage } from './pages/console/Trips';
import { HomePage, SearchPage } from './pages/Search';
import { MyTripsPage, TicketPage } from './pages/Ticket';
import './styles.css';

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      // never retry client errors (403/404/409…); retry network/server errors once
      retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 1,
      refetchOnWindowFocus: false,
    },
  },
});

function NotFound() {
  return <main className="page"><Empty title="This page does not exist"><p><Link to="/">Go to search</Link></p></Empty></main>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <ToastProvider>
          <BrowserRouter>
            <Routes>
              <Route element={<Shell />}>
                <Route index element={<HomePage />} />
                <Route path="search" element={<SearchPage />} />
                <Route path="trips/:tripId" element={<TripSeatsPage />} />
                <Route path="login" element={<LoginPage />} />
                <Route path="register" element={<RegisterPage />} />
                <Route path="checkout/:holdToken" element={<RequireAuth><CheckoutPage /></RequireAuth>} />
                <Route path="bookings/:pnr" element={<RequireAuth><TicketPage /></RequireAuth>} />
                <Route path="my-trips" element={<RequireAuth><MyTripsPage /></RequireAuth>} />
                <Route path="console" element={<RequireAuth staff><ConsoleLayout /></RequireAuth>}>
                  <Route index element={<DashboardPage />} />
                  <Route path="trips" element={<TripsPage />} />
                  <Route path="trips/:tripId" element={<TripDetailPage />} />
                  <Route path="bookings" element={<BookingsPage />} />
                  <Route path="refunds" element={<RefundsPage />} />
                  <Route path="routes" element={<RoutesPage />} />
                  <Route path="routes/:routeId" element={<RouteDetailPage />} />
                  <Route path="fleet" element={<FleetPage />} />
                  <Route path="policy" element={<PolicyPage />} />
                  <Route path="operators" element={<OperatorsPage />} />
                  <Route path="reports" element={<ReportsPage />} />
                  <Route path="audit" element={<AuditPage />} />
                </Route>
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
