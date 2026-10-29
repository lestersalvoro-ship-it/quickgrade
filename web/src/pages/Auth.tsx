import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthLayout } from '../components/Layout';
import { Alert, Button, TextInput } from '../components/ui';
import { errorMessage, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { User } from '../lib/types';

export function LoginPage() {
  const { setUser } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ user: User }>('/auth/login', { email, password });
      setUser(r.user);
      const next = params.get('next');
      nav(next && next.startsWith('/') && !next.startsWith('//') ? next : '/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <h1 className="text-xl font-semibold">Sign in</h1>
      <p className="mt-1 text-sm text-ink-2">Welcome back. Sign in to grade and review your classes.</p>
      <form className="mt-6 space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="bad">{error}</Alert>}
        <TextInput label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextInput label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Sign in
        </Button>
      </form>
      <div className="mt-5 flex justify-between text-sm">
        <Link to="/forgot-password" className="text-primary hover:underline">
          Forgot password?
        </Link>
        <Link to="/register" className="text-primary hover:underline">
          Create an account
        </Link>
      </div>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const { setUser } = useAuth();
  const nav = useNavigate();
  const [form, setForm] = useState({ fullName: '', email: '', schoolName: '', password: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (form.password !== form.confirm) return setError('The passwords do not match.');
    setBusy(true);
    try {
      const r = await post<{ user: User }>('/auth/register', { fullName: form.fullName, email: form.email, schoolName: form.schoolName || undefined, password: form.password });
      setUser(r.user);
      nav('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <h1 className="text-xl font-semibold">Create your teacher account</h1>
      <p className="mt-1 text-sm text-ink-2">Free to use. Your classes and results stay private to your account.</p>
      <form className="mt-6 space-y-4" onSubmit={submit} noValidate>
        {error && <Alert tone="bad">{error}</Alert>}
        <TextInput label="Full name" autoComplete="name" required value={form.fullName} onChange={set('fullName')} />
        <TextInput label="Email" type="email" autoComplete="email" required value={form.email} onChange={set('email')} />
        <TextInput label="School or organisation" hint="Optional" autoComplete="organization" value={form.schoolName} onChange={set('schoolName')} />
        <TextInput label="Password" type="password" autoComplete="new-password" required hint="At least 10 characters, with letters and numbers or symbols." value={form.password} onChange={set('password')} />
        <TextInput label="Confirm password" type="password" autoComplete="new-password" required value={form.confirm} onChange={set('confirm')} />
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Create account
        </Button>
      </form>
      <p className="mt-5 text-center text-sm">
        Already have an account?{' '}
        <Link to="/login" className="text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<{ emailConfigured: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <AuthLayout>
      <h1 className="text-xl font-semibold">Reset your password</h1>
      {sent ? (
        <div className="mt-4 space-y-4">
          <Alert tone="good" title="Check your email">
            If an account exists for {email}, a reset link valid for one hour is on its way.
          </Alert>
          {!sent.emailConfigured && (
            <Alert tone="warn" title="Email delivery is not configured on this server">
              The administrator can find the reset link in the server log.
            </Alert>
          )}
          <Link to="/login" className="text-sm text-primary hover:underline">
            Back to sign in
          </Link>
        </div>
      ) : (
        <form
          className="mt-5 space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              setSent(await post('/auth/forgot-password', { email }));
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="text-sm text-ink-2">Enter your account email and we’ll send you a link to choose a new password.</p>
          {error && <Alert tone="bad">{error}</Alert>}
          <TextInput label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <Button type="submit" variant="primary" className="w-full" loading={busy}>
            Send reset link
          </Button>
          <Link to="/login" className="block text-center text-sm text-primary hover:underline">
            Back to sign in
          </Link>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <AuthLayout>
      <h1 className="text-xl font-semibold">Choose a new password</h1>
      {done ? (
        <div className="mt-4 space-y-3">
          <Alert tone="good">Your password was changed. All devices were signed out.</Alert>
          <Link to="/login" className="text-sm text-primary hover:underline">
            Sign in
          </Link>
        </div>
      ) : (
        <form
          className="mt-5 space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (password !== confirm) return setError('The passwords do not match.');
            setBusy(true);
            setError(null);
            try {
              await post('/auth/reset-password', { token, password });
              setDone(true);
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {!token && <Alert tone="bad">This link is missing its reset token. Request a new link.</Alert>}
          {error && <Alert tone="bad">{error}</Alert>}
          <TextInput label="New password" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} hint="At least 10 characters, with letters and numbers or symbols." />
          <TextInput label="Confirm new password" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={!token}>
            Save new password
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
