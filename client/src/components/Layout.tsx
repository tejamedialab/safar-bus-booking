import type { ReactNode } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { isStaff, useAuth } from '../lib/auth';
import { Skeleton } from './ui';

export function BusMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="16" height="12" rx="2" />
      <path d="M4 11h16M8 16v3M16 16v3" />
    </svg>
  );
}

export function Shell() {
  const { user, operator, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand" aria-label="Safar home">
            <span className="brand-mark">
              <BusMark />
            </span>
            Safar
          </Link>
          <nav className="topnav" aria-label="Main">
            <NavLink to="/" end>
              Book
            </NavLink>
            {user?.role === 'PASSENGER' && <NavLink to="/my-trips">My trips</NavLink>}
            {isStaff(user) && <NavLink to="/console">Operations</NavLink>}
            {user ? (
              <>
                <span className="who">
                  {user.fullName}
                  {operator ? ` • ${operator.name}` : user.role === 'ADMIN' ? ' • Admin' : ''}
                </span>
                <button
                  onClick={async () => {
                    await logout();
                    navigate('/');
                  }}
                >
                  Log out
                </button>
              </>
            ) : (
              <NavLink to="/login">Log in</NavLink>
            )}
          </nav>
        </div>
      </header>
      <Outlet />
      <footer className="footer">Safar demo • payments and refunds are simulated • times shown in IST</footer>
    </>
  );
}

export function RequireAuth({ children, staff }: { children: ReactNode; staff?: boolean }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <main className="page"><Skeleton h={200} /></main>;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (staff && !isStaff(user)) return <Navigate to="/" replace />;
  return <>{children}</>;
}
