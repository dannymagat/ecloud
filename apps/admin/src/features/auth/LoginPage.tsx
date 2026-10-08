/**
 * Login: email + password, then (when enrolled) a TOTP or recovery-code step. Accounts that
 * must enrol MFA are sent to /mfa/enrol (their session holds no permissions until confirmed).
 */
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { api } from '../../api/client';
import { problemOf, type Problem } from '../../api/problem';
import type { LoginResult } from '../../api/types';
import { ProblemAlert } from '../../components/ProblemAlert';
import { Button, Notice, TextField } from '../../components/ui';
import { needsMfaEnrolment, useAuth } from '../../lib/auth';
import { AuthCard as AuthLayout } from './AuthCard';

function safeNext(next: string | null): string {
  // Only same-app relative paths: never redirect to another origin.
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export function LoginPage() {
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const expired = params.get('expired') === '1';

  const [step, setStep] = useState<'password' | 'mfa'>('password');
  const [email, setEmail] = useState('');
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
    setBusy(true);
    setProblem(null);
    try {
      const result = (await api('post', '/api/v1/auth/login', {
        body: { email, password },
      })) as LoginResult;
      setPassword('');
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
    <AuthLayout title="Sign in">
      {expired ? (
        <Notice tone="warning">Your session has expired. Sign in again to continue.</Notice>
      ) : null}
      <form onSubmit={(e) => void submitPassword(e)} className="space-y-4">
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <TextField
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <ProblemAlert problem={problem} />
        <Button type="submit" variant="primary" className="w-full" busy={busy}>
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
