/**
 * TOTP enrolment: POST /auth/mfa/enrol → QR (rendered locally with `qrcode`, no third party)
 * + manual secret → POST /auth/mfa/confirm → recovery codes shown once.
 */
import QRCode from 'qrcode';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { api } from '../../api/client';
import { problemOf, type Problem } from '../../api/problem';
import { ProblemAlert } from '../../components/ProblemAlert';
import { SecretOnce } from '../../components/SecretOnce';
import { Button, Notice, Spinner, TextField } from '../../components/ui';
import { needsMfaEnrolment, useAuth } from '../../lib/auth';
import { AuthCard } from './AuthCard';

interface Enrolment {
  secret: string;
  otpauth_uri: string;
}

export function MfaEnrolPage() {
  const { me, loading, refresh, logout } = useAuth();
  const navigate = useNavigate();
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const started = useRef(false);

  const start = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await api('post', '/api/v1/auth/mfa/enrol', {});
      setEnrolment(result);
      setQr(await QRCode.toDataURL(result.otpauth_uri, { margin: 1, width: 192 }));
    } catch (error) {
      setProblem(problemOf(error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (me && !started.current && !recovery) {
      started.current = true;
      void start();
    }
  }, [me, recovery]);

  if (loading) return <Spinner label="Loading…" />;
  if (!me) return <Navigate to="/login" replace />;
  // D-046: MFA switched off (ADMIN_MFA_MODE=off): the enrolment screen is unreachable.
  if (me.kind === 'admin' && me.mfa.mode === 'off') return <Navigate to="/" replace />;
  if (!needsMfaEnrolment(me) && !enrolment && !recovery) {
    return (
      <AuthCard title="Two-factor authentication">
        <Notice tone="success">
          Two-factor authentication is already active for this account.
        </Notice>
        <Button variant="primary" className="w-full" onClick={() => void navigate('/')}>
          Continue
        </Button>
      </AuthCard>
    );
  }

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const result = await api('post', '/api/v1/auth/mfa/confirm', {
        body: { code: code.trim() },
      });
      setRecovery(result.recovery_codes);
      setEnrolment(null);
      setQr(null);
    } catch (error) {
      setProblem(problemOf(error));
    } finally {
      setBusy(false);
    }
  };

  if (recovery) {
    return (
      <AuthCard title="Save your recovery codes">
        <SecretOnce
          title="Recovery codes"
          value={recovery}
          description="Each code signs you in once if you lose your authenticator. They are shown only now."
          doneLabel="I have saved them — continue"
          onDone={() => {
            void refresh().then(() => navigate('/', { replace: true }));
          }}
        />
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Set up two-factor authentication">
      <p className="text-sm text-subtle">
        Your account requires an authenticator app (TOTP). Scan the code, then enter the 6-digit
        code it shows.
      </p>
      {busy && !enrolment ? <Spinner label="Preparing enrolment…" /> : null}
      {enrolment ? (
        <div className="space-y-3">
          {qr ? (
            <img
              src={qr}
              width={192}
              height={192}
              alt="QR code for your authenticator app"
              className="mx-auto rounded bg-white p-1"
            />
          ) : null}
          <details className="text-sm">
            <summary className="cursor-pointer text-primary">
              Can’t scan? Enter the key manually
            </summary>
            <code className="mt-2 block select-all break-all rounded bg-muted px-2 py-1 font-mono text-xs">
              {enrolment.secret}
            </code>
          </details>
          <form onSubmit={(e) => void confirm(e)} className="space-y-3">
            <TextField
              label="Authentication code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
            <Button type="submit" variant="primary" className="w-full" busy={busy}>
              Confirm and enable
            </Button>
          </form>
        </div>
      ) : null}
      <ProblemAlert problem={problem} />
      {problem && !enrolment ? (
        <Button onClick={() => void start()} busy={busy}>
          Try again
        </Button>
      ) : null}
      <button
        type="button"
        className="text-sm text-subtle underline-offset-2 hover:underline"
        onClick={() => void logout().then(() => navigate('/login'))}
      >
        Sign out
      </button>
    </AuthCard>
  );
}
