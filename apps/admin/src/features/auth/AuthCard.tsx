import type { ReactNode } from 'react';
import { WordmarkText } from '../../layout/TopBar';

/**
 * Sign-in / MFA screens: the EZECLOUD wordmark above a centred white card (about 440px wide)
 * whose heading and content are left-aligned.
 */
export function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-[440px] space-y-6">
        <p className="text-center text-3xl font-extrabold tracking-wide">
          <WordmarkText />
        </p>
        <div className="space-y-6 rounded-xl border border-border bg-surface px-6 py-8 shadow-sm sm:px-8">
          <div className="space-y-1.5">
            <h1 className="text-3xl font-bold tracking-tight text-fg">{title}</h1>
            {subtitle ? <p className="text-sm text-subtle">{subtitle}</p> : null}
          </div>
          {children}
        </div>
      </div>
    </main>
  );
}
