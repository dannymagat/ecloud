/**
 * Per-adapter, per-field enforceability (D-028 × MULTI_VENDOR_INTEGRATION_PLAN.md §4.4). A field
 * is shown as device-enforced only when it is VERIFIED_SUPPORTED with lab/production evidence
 * and a device-test reference (V12); source-verified cells read as expected, not device-tested.
 */
import { StatusBadge, StatusLegend } from '../../components/StatusBadge';
import { fieldLabel } from '../../lib/adapterStatus';

export interface AdapterFieldCell {
  field: string;
  status: unknown;
  evidence?: string;
  /** Evidence level from the API (`evidence_level`); absent ⇒ weakest presentation. */
  evidenceLevel?: string;
  dtRefs?: string[];
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
  mode = 'catalogue',
}: {
  adapters: AdapterColumn[];
  /** Fields to show (rows), in order. */
  fields: readonly string[];
  caption?: string;
  /** `preview` = policy editor wording ("Expected (source-verified, not device-tested)"). */
  mode?: 'catalogue' | 'preview';
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
                        <StatusBadge
                          status={cell.status}
                          evidence={cell.evidence}
                          evidenceLevel={cell.evidenceLevel}
                          dtRefs={cell.dtRefs}
                          mode={mode}
                        />
                      ) : (
                        <StatusBadge
                          status="UNDECLARED"
                          evidence="The adapter declares no status for this field."
                          mode={mode}
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
      <StatusLegend mode={mode} />
    </div>
  );
}

function stringField(r: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) if (typeof r[k] === 'string') return r[k];
  return undefined;
}

function stringList(r: Record<string, unknown>, ...keys: string[]): string[] | undefined {
  for (const k of keys) {
    const v = r[k];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  }
  return undefined;
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
              evidenceLevel: stringField(r, 'evidence_level', 'evidenceLevel'),
              dtRefs: stringList(r, 'dt_refs', 'dtRefs'),
              set: typeof r.set === 'boolean' ? r.set : undefined,
            },
          ];
        }),
      },
    ];
  });
}
