import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ErrorNotice, Field } from '../components/ui';
import { fieldErrors } from '../lib/api';
import { useAuth } from '../lib/auth';

const DEMO = [
  { label: 'Passenger', email: 'ravi@example.com', password: 'Passenger@12345' },
  { label: 'Operator (Deccan Starliner)', email: 'ops.deccan@safar.dev', password: 'Operator@12345' },
  { label: 'Admin', email: 'admin@safar.dev', password: 'Admin@12345' },
];

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [sp] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const go = async (e: string, p: string) => {
    setBusy(true);
    setError(null);
    try {
      const u = await login(e, p);
      navigate(sp.get('next') ?? (u.role === 'PASSENGER' ? '/' : '/console'), { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    go(email, password);
  };

  return (
    <main className="page">
      <div className="auth-card stack">
        <h1 style={{ fontSize: '2rem' }}>Log in</h1>
        <form className="panel stack" onSubmit={submit}>
          <Field label="Email"><input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Password"><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <ErrorNotice error={error} />
          <button className="btn block" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
          <p className="small">New here? <Link to={`/register${sp.get('next') ? `?next=${encodeURIComponent(sp.get('next')!)}` : ''}`}>Create a passenger account</Link></p>
        </form>
        <div className="panel stack demo-logins" style={{ ['--gap' as any]: '0.5rem' }}>
          <h3>Demo accounts</h3>
          <p className="small muted">Dummy data only. One click logs you in.</p>
          {DEMO.map((d) => (
            <button key={d.email} type="button" onClick={() => go(d.email, d.password)} disabled={busy}>
              <strong>{d.label}</strong><br /><span className="small muted">{d.email} • {d.password}</span>
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [sp] = useSearchParams();
  const [f, setF] = useState({ fullName: '', email: '', phone: '', password: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const errs = fieldErrors(error);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register(f);
      navigate(sp.get('next') ?? '/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const bind = (k: keyof typeof f) => ({ value: f[k], onChange: (e: any) => setF({ ...f, [k]: e.target.value }), 'aria-invalid': Boolean(errs[k]) });
  return (
    <main className="page">
      <div className="auth-card stack">
        <h1 style={{ fontSize: '2rem' }}>Create account</h1>
        <form className="panel stack" onSubmit={submit} noValidate>
          <Field label="Full name" error={errs.fullName}><input autoComplete="name" required {...bind('fullName')} /></Field>
          <Field label="Email" error={errs.email}><input type="email" autoComplete="email" required {...bind('email')} /></Field>
          <Field label="Mobile number" error={errs.phone} hint="10 digits"><input type="tel" inputMode="numeric" maxLength={10} autoComplete="tel-national" required {...bind('phone')} /></Field>
          <Field label="Password" error={errs.password} hint="8+ characters with a letter and a number"><input type="password" autoComplete="new-password" required {...bind('password')} /></Field>
          {error && !Object.keys(errs).length ? <ErrorNotice error={error} /> : null}
          <button className="btn block" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
          <p className="small">Already registered? <Link to="/login">Log in</Link></p>
        </form>
      </div>
    </main>
  );
}
