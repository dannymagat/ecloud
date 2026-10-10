/**
 * "RADIUS Secret" box (D-045): the NAS secret stays masked; "Reveal and copy" asks for a FRESH
 * MFA code (only with ADMIN_MFA_MODE=required; D-046: otherwise one confirmation click), then shows the value, copies it to the clipboard and hides it again after 30 s.
 * The value lives in this component's state only (never in the TanStack cache: the reveal is a
 * mutation with gcTime 0 that is reset as soon as it succeeds). Several NAS → a NAS selector.
 * The existing rotate-secret action sits next to it.
 */
import { useMutation } from '@tanstack/react-query';
import { Eye, EyeOff, KeyRound } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Dialog } from '../../components/Dialog';
import { ProblemAlert } from '../../components/ProblemAlert';
import { Button, Card, SelectField, TextField } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { can } from '../../lib/permissions';
import { RotateSecret } from '../org/NasPage';
import { revealSecret, type OverviewNas } from './data';

export const REVEAL_SECONDS = 30;
const MASK = '••••••••••••••••••••••••';

function MfaDialog({
  open,
  mfa,
  nasName,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean;
  /** false (ADMIN_MFA_MODE=off): a confirmation only, no code field. */
  mfa: boolean;
  nasName: string;
  busy: boolean;
  error: unknown;
  onSubmit: (code: string | null) => void;
  onClose: () => void;
}) {
  // Mounted only while open: the code starts empty on every open.
  const [code, setCode] = useState('');
  const valid = !mfa || /^[0-9]{6}$/.test(code);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) onSubmit(mfa ? code : null);
  };
  return (
    <Dialog
      open={open}
      title={mfa ? 'Confirm with your MFA code' : 'Reveal the RADIUS secret'}
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-3 text-sm">
        <p>
          Revealing the RADIUS secret of <span className="font-medium">{nasName}</span>{' '}
          {mfa
            ? 'needs a new code from your authenticator app. '
            : 'is recorded in the audit log. '}
          {mfa ? 'The reveal is recorded in the audit log; the' : 'The'} value is hidden again after{' '}
          {REVEAL_SECONDS} seconds.
        </p>
        {mfa ? (
          <TextField
            label="MFA code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            hint="6 digits from your authenticator app."
          />
        ) : null}
        <ProblemAlert error={error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!valid}>
            Reveal and copy
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function RadiusSecretBox({ orgId, nas }: { orgId: string; nas: readonly OverviewNas[] }) {
  const { me } = useAuth();
  const [selected, setSelected] = useState<string>(nas[0]?.id ?? '');
  const current = nas.find((n) => n.id === selected) ?? nas[0];
  const [dialog, setDialog] = useState(false);
  /** The revealed value, the NAS it belongs to and when it hides (component state only). */
  const [revealed, setRevealed] = useState<{
    nasId: string;
    value: string;
    until: number;
  } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');

  const reveal = useMutation({
    gcTime: 0,
    mutationFn: ({ nasId, code }: { nasId: string; code: string | null }) =>
      revealSecret(orgId, nasId, code),
  });

  const resetReveal = reveal.reset;
  // Stable: the Dialog re-focuses its first field whenever onClose changes identity.
  const closeDialog = useCallback(() => {
    setDialog(false);
    resetReveal();
  }, [resetReveal]);

  const hide = () => {
    setRevealed(null);
    setCopied('idle');
  };

  // Auto-hide after REVEAL_SECONDS: the value is dropped from state when the time is up.
  const until = revealed?.until ?? null;
  useEffect(() => {
    if (until === null) return undefined;
    const t = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= until) {
        setRevealed(null);
        setCopied('idle');
      }
    }, 1000);
    return () => clearInterval(t);
  }, [until]);

  if (current === undefined) {
    return (
      <Card title="RADIUS Secret">
        <p className="text-sm text-subtle">
          Each NAS gets its own RADIUS shared secret when you add it. Add an access point to get
          one.
        </p>
      </Card>
    );
  }

  const target = { organizationId: orgId, siteId: current.site_id };
  const mfaOn = me?.kind !== 'admin' || me.mfa.mode !== 'off';
  const canReveal = can(me, 'nas:secret:reveal', target);
  const canRotate = can(me, 'nas:secret:rotate', target);
  const impersonating = me?.kind === 'admin' && me.impersonation !== null;
  // Shown only for the NAS it was revealed for, and only until it expires.
  const secret =
    revealed !== null && revealed.nasId === current.id && now < revealed.until
      ? revealed.value
      : null;
  const left = revealed === null ? 0 : Math.max(0, Math.ceil((revealed.until - now) / 1000));

  const submit = (code: string | null) => {
    reveal.mutate(
      { nasId: current.id, code },
      {
        onSuccess: (value) => {
          reveal.reset(); // drop the value from the mutation state at once
          setDialog(false);
          const at = Date.now();
          setNow(at);
          setRevealed({ nasId: current.id, value, until: at + REVEAL_SECONDS * 1000 });
          navigator.clipboard.writeText(value).then(
            () => setCopied('ok'),
            () => setCopied('failed'),
          );
        },
      },
    );
  };

  return (
    <Card title="RADIUS Secret">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)_auto] lg:items-end">
        {nas.length > 1 ? (
          <SelectField
            label="NAS"
            value={current.id}
            onChange={(e) => {
              hide(); // switching NAS hides the value at once
              setSelected(e.target.value);
            }}
            options={nas.map((n) => ({ value: n.id, label: `${n.name} (${n.site_name})` }))}
          />
        ) : (
          <p className="text-sm text-subtle lg:pb-2.5">
            NAS <span className="font-medium text-fg">{current.name}</span> · {current.site_name}
          </p>
        )}
        <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted px-3 py-2">
          <KeyRound aria-hidden="true" className="h-4 w-4 shrink-0 text-subtle" />
          <code
            data-testid="radius-secret-value"
            aria-label={secret === null ? 'RADIUS secret (hidden)' : 'RADIUS secret'}
            className="min-w-0 flex-1 select-all break-all font-mono text-sm"
          >
            {secret ?? (current.has_secret ? MASK : 'No secret stored')}
          </code>
          {secret !== null ? (
            <Button size="sm" variant="ghost" onClick={hide} aria-label="Hide the secret now">
              <EyeOff aria-hidden="true" className="h-3.5 w-3.5" />
              Hide
            </Button>
          ) : null}
        </div>
        <p
          aria-live="polite"
          className="min-h-[1rem] text-xs text-subtle lg:order-last lg:col-span-3"
        >
          {secret !== null
            ? `${copied === 'ok' ? 'Copied to the clipboard (it stays there until you copy something else). ' : copied === 'failed' ? 'Copy failed: select and copy it manually. ' : ''}Hidden again in ${String(left)} s.`
            : ''}
        </p>
        <div className="flex flex-wrap items-center gap-2 lg:pb-1">
          {canReveal ? (
            <Button
              variant="primary"
              size="sm"
              disabled={impersonating || !current.has_secret}
              title={impersonating ? 'Not available while impersonating' : undefined}
              onClick={() => {
                reveal.reset();
                setDialog(true);
              }}
            >
              <Eye aria-hidden="true" className="h-3.5 w-3.5" />
              Reveal and copy
            </Button>
          ) : (
            <p className="text-xs text-subtle">
              Revealing the secret needs the Organization Admin role{mfaOn ? ' and MFA' : ''}.
            </p>
          )}
          {canRotate ? (
            <RotateSecret row={{ id: current.id, name: current.name }} orgId={orgId} />
          ) : null}
        </div>
      </div>
      {dialog ? (
        <MfaDialog
          open
          mfa={mfaOn}
          nasName={current.name}
          busy={reveal.isPending}
          error={reveal.isError ? reveal.error : null}
          onSubmit={submit}
          onClose={closeDialog}
        />
      ) : null}
    </Card>
  );
}
