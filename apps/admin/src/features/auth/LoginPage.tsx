/**
 * Login: email + password, then (when enrolled) a TOTP or recovery-code step. Accounts that
 * must enrol MFA are sent to /mfa/enrol (their session holds no permissions until confirmed).
 */
import { Eye, EyeOff } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { api } from '../../api/client';
import { problemOf, type Problem } from '../../api/problem';
import type { LoginResult } from '../../api/types';
import { ProblemAlert } from '../../components/ProblemAlert';
import { Button, cx, Notice, TextField } from '../../components/ui';
import { needsMfaEnrolment, useAuth } from '../../lib/auth';
import { AuthCard as AuthLayout } from './AuthCard';

function safeNext(next: string | null): string {
  // Only same-app relative paths: never redirect to another origin.
  return next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\')
    ? next
    : '/';
}

/**
 * "Remember me" keeps only the email address on this browser (never the password, never a
 * token); it does not change the session lifetime.
 */
export const REMEMBER_EMAIL_KEY = 'ecloud-admin-remember-email';

function readRememberedEmail(): string {
  try {
    return localStorage.getItem(REMEMBER_EMAIL_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeRememberedEmail(email: string | null): void {
  try {
    if (email) localStorage.setItem(REMEMBER_EMAIL_KEY, email);
    else localStorage.removeItem(REMEMBER_EMAIL_KEY);
  } catch {
    // Storage unavailable (private mode): nothing is remembered.
  }
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;

const focusRing =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';
const labelClass = 'block text-sm font-medium text-fg';
const fieldClass =
  'block w-full rounded-lg border border-border bg-surface px-3.5 py-2.5 text-base text-fg ' +
  'placeholder:text-subtle focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 ' +
  'aria-[invalid=true]:border-danger';

export function LoginPage() {
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const expired = params.get('expired') === '1';

  const [step, setStep] = useState<'password' | 'mfa'>('password');
  const [email, setEmail] = useState(readRememberedEmail);
  const [remember, setRemember] = useState(() => readRememberedEmail() !== '');
  const [showPassword, setShowPassword] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const emailId = useId();
  const passwordId = useId();
  const forgotId = useId();
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState('');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  if (me && step === 'password' && !busy) {
    return <Navigate to={needsMfaEnrolment(me) ? '/mfa/enrol' : next} replace />;
  }

  const finish = async (result: LoginResult) => {
    if (result.mfa_required && result.mfa_token) {
      setMfaToken(result.mfa_token);
      setStep('mfa');
      setCode('');
      return;
    }
    const current = await refresh();
    if (result.mfa_enrolment_required || needsMfaEnrolment(current)) {
      void navigate('/mfa/enrol', { replace: true });
    } else {
      void navigate(next, { replace: true });
    }
  };

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    const found: { email?: string; password?: string } = {};
    if (!trimmed) found.email = 'Enter your email address.';
    else if (!EMAIL_SHAPE.test(trimmed)) found.email = 'Enter a valid email address.';
    if (!password) found.password = 'Enter your password.';
    setErrors(found);
    if (found.email || found.password) {
      (found.email ? emailRef : passwordRef).current?.focus();
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const result = (await api('post', '/api/v1/auth/login', {
        body: { email: trimmed, password },
      })) as LoginResult;
      // Remember the address only once the server accepted the password (no typos kept).
      storeRememberedEmail(remember ? trimmed : null);
      setPassword('');
      setShowPassword(false);
      await finish(result);
    } catch (error) {
      setProblem(problemOf(error));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const body = useRecovery
        ? { mfa_token: mfaToken, recovery_code: code.trim() }
        : { mfa_token: mfaToken, code: code.trim() };
      const result = (await api('post', '/api/v1/auth/mfa/verify', { body })) as LoginResult;
      await finish(result);
    } catch (error) {
      setProblem(problemOf(error));
    } finally {
      setBusy(false);
    }
  };

  if (step === 'mfa') {
    return (
      <AuthLayout title="Two-factor verification">
        <form onSubmit={(e) => void submitCode(e)} className="space-y-4" noValidate>
          {useRecovery ? (
            <TextField
              label="Recovery code"
              name="recovery_code"
              autoComplete="off"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          ) : (
            <TextField
              label="Authentication code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              hint="6-digit code from your authenticator app."
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          )}
          <ProblemAlert problem={problem} />
          <Button type="submit" variant="primary" className="w-full" busy={busy}>
            Verify
          </Button>
          <div className="flex justify-between text-sm">
            <button
              type="button"
              className="text-primary underline-offset-2 hover:underline"
              onClick={() => {
                setUseRecovery((v) => !v);
                setCode('');
              }}
            >
              {useRecovery ? 'Use authenticator code' : 'Use a recovery code'}
            </button>
            <button
              type="button"
              className="text-subtle underline-offset-2 hover:underline"
              onClick={() => {
                setStep('password');
                setMfaToken('');
                setProblem(null);
              }}
            >
              Start over
            </button>
          </div>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Sign in" subtitle="Please sign in to continue.">
      {expired ? (
        <Notice tone="warning">Your session has expired. Sign in again to continue.</Notice>
      ) : null}
      <form onSubmit={(e) => void submitPassword(e)} className="space-y-5" noValidate>
        <div className="space-y-1.5">
          <label htmlFor={emailId} className={labelClass}>
            Email
          </label>
          <input
            ref={emailRef}
            id={emailId}
            name="email"
            type="email"
            autoComplete="username"
            placeholder="you@company.com"
            required
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? `${emailId}-error` : undefined}
            className={fieldClass}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (errors.email) setErrors((x) => ({ ...x, email: undefined }));
            }}
          />
          {errors.email ? (
            <p id={`${emailId}-error`} className="text-sm text-danger">
              {errors.email}
            </p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <label htmlFor={passwordId} className={labelClass}>
            Password
          </label>
          <div className="relative">
            <input
              ref={passwordRef}
              id={passwordId}
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              required
              aria-invalid={errors.password ? true : undefined}
              aria-describedby={errors.password ? `${passwordId}-error` : undefined}
              className={cx(fieldClass, 'pr-12')}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (errors.password) setErrors((x) => ({ ...x, password: undefined }));
              }}
            />
            <button
              type="button"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              aria-controls={passwordId}
              onClick={() => setShowPassword((v) => !v)}
              className={cx(
                'absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-subtle hover:text-fg',
                focusRing,
              )}
            >
              {showPassword ? (
                <EyeOff aria-hidden="true" className="h-5 w-5" />
              ) : (
                <Eye aria-hidden="true" className="h-5 w-5" />
              )}
            </button>
          </div>
          {errors.password ? (
            <p id={`${passwordId}-error`} className="text-sm text-danger">
              {errors.password}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
          <label className="inline-flex cursor-pointer items-center gap-2 text-fg">
            <input
              type="checkbox"
              name="remember"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className={cx('h-4 w-4 rounded border-border accent-primary', focusRing)}
            />
            Remember me
          </label>
          <button
            type="button"
            aria-expanded={forgotOpen}
            aria-controls={forgotId}
            onClick={() => setForgotOpen((v) => !v)}
            className={cx(
              'rounded font-medium text-primary underline-offset-2 hover:underline',
              focusRing,
            )}
          >
            Forgot your password?
          </button>
        </div>
        {forgotOpen ? (
          <div id={forgotId}>
            <Notice tone="info">
              Passwords are reset by your platform administrator. Ask them to reset it from Platform
              › Administrators.
            </Notice>
          </div>
        ) : null}
        <ProblemAlert problem={problem} />
        <Button
          type="submit"
          variant="primary"
          className="w-full rounded-lg py-3 text-base font-semibold"
          busy={busy}
        >
          {busy ? 'Logging in…' : 'Log in'}
        </Button>
      </form>
    </AuthLayout>
  );
}
