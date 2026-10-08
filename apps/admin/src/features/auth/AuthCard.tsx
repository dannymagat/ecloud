import type { ReactNode } from 'react';

export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <p className="text-lg font-semibold tracking-tight">ECLOUD</p>
          <h1 className="mt-1 text-xl font-semibold">{title}</h1>
        </div>
        <div className="space-y-4 rounded-lg border border-border bg-surface p-6 shadow-sm">
          {children}
        </div>
      </div>
    </main>
  );
}
