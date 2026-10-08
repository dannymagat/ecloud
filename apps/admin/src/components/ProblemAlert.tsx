/** Renders an RFC 9457 problem plainly: title, detail, field errors and the request id. */
import { problemOf, type Problem } from '../api/problem';

export function ProblemAlert({ error, problem }: { error?: unknown; problem?: Problem | null }) {
  const p = problem ?? (error === undefined || error === null ? null : problemOf(error));
  if (!p) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
    >
      <p className="font-semibold">
        {p.title}
        {p.status ? <span className="font-normal"> (HTTP {p.status})</span> : null}
      </p>
      {p.detail ? <p className="mt-0.5">{p.detail}</p> : null}
      {p.errors && p.errors.length > 0 ? (
        <ul className="mt-1 list-disc pl-5">
          {p.errors.map((e, i) => (
            <li key={`${e.path}-${i}`}>
              {e.path ? <code className="font-mono text-xs">{e.path}</code> : null}
              {e.path ? ': ' : null}
              {e.message}
            </li>
          ))}
        </ul>
      ) : null}
      {p.request_id ? (
        <p className="mt-1 text-xs opacity-80">
          Request id: <code className="font-mono">{p.request_id}</code>
        </p>
      ) : null}
    </div>
  );
}
