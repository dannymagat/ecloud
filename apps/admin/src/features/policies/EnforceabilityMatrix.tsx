/**
 * Per-adapter, per-field enforceability (D-028). Cells are four-state badges; a field is
 * only ever shown as device-enforced when its status is exactly VERIFIED_SUPPORTED.
 */
import { StatusBadge, StatusLegend } from '../../components/StatusBadge';
import { fieldLabel } from '../../lib/adapterStatus';

export interface AdapterFieldCell {
  field: string;
  status: unknown;
  evidence?: string;
  set?: boolean;
}

export interface AdapterColumn {
  adapter: string;
  fields: AdapterFieldCell[];
}

export function EnforceabilityMatrix({
  adapters,
  fields,
  caption = 'Enforceability by adapter',
}: {
  adapters: AdapterColumn[];
  /** Fields to show (rows), in order. */
  fields: readonly string[];
  caption?: string;
}) {
  if (fields.length === 0) {
    return (
      <p className="text-sm text-subtle">
        Set at least one policy field to see how each adapter enforces it.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="min-w-full divide-y divide-border text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-muted/60">
            <tr>
              <th
                scope="col"
                className="px-3 py-2 text-left text-xs font-semibold uppercase text-subtle"
              >
                Field
              </th>
              {adapters.map((a) => (
                <th
                  key={a.adapter}
                  scope="col"
                  className="px-3 py-2 text-left text-xs font-semibold text-subtle"
                >
                  <code>{a.adapter}</code>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {fields.map((field) => (
              <tr key={field}>
                <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-medium">
                  {fieldLabel(field)}
                </th>
                {adapters.map((a) => {
                  const cell = a.fields.find((f) => f.field === field);
                  return (
                    <td key={a.adapter} className="whitespace-nowrap px-3 py-2">
                      {cell ? (
                        <StatusBadge status={cell.status} evidence={cell.evidence} />
                      ) : (
                        <StatusBadge
                          status="UNDECLARED"
                          evidence="The adapter declares no status for this field."
                        />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <StatusLegend />
    </div>
  );
}

/** Normalises `per_adapter[].field_table` (simulate) or `adapters[].fields` (platform catalogue). */
export function toAdapterColumns(input: unknown): AdapterColumn[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((entry): AdapterColumn[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const e = entry as Record<string, unknown>;
    const adapter =
      typeof e.adapter === 'string' ? e.adapter : typeof e.key === 'string' ? e.key : null;
    const table = Array.isArray(e.field_table)
      ? e.field_table
      : Array.isArray(e.fields)
        ? e.fields
        : [];
    if (!adapter) return [];
    return [
      {
        adapter,
        fields: table.flatMap((f): AdapterFieldCell[] => {
          if (typeof f !== 'object' || f === null) return [];
          const r = f as Record<string, unknown>;
          if (typeof r.field !== 'string') return [];
          return [
            {
              field: r.field,
              status: r.status,
              evidence: typeof r.evidence === 'string' ? r.evidence : undefined,
              set: typeof r.set === 'boolean' ? r.set : undefined,
            },
          ];
        }),
      },
    ];
  });
}
