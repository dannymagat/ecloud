/** Declarative form fields for the generic resource screens and their body conversion. */
import { isoToLocalInput, localInputToIso, str } from '../../lib/format';
import type { OrgCollectionPath } from './paths';

export type FieldType =
  | 'text'
  | 'email'
  | 'password'
  | 'number'
  | 'select'
  | 'checkbox'
  | 'datetime'
  | 'textarea'
  | 'list';

export interface OptionSource {
  path: OrgCollectionPath;
  label: (row: Record<string, unknown>) => string;
  query?: Record<string, string>;
}

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  hint?: string;
  placeholder?: string;
  options?: readonly { value: string; label: string }[];
  optionsFrom?: OptionSource;
  /** Shown on create only. */
  createOnly?: boolean;
  /** Field may be cleared to null on edit. */
  nullable?: boolean;
  defaultValue?: string | boolean;
  min?: number;
  max?: number;
}

export type FormValues = Record<string, string | boolean>;

export function initialValues(
  fields: readonly FieldDef[],
  row?: Record<string, unknown>,
): FormValues {
  const values: FormValues = {};
  for (const f of fields) {
    const v = row?.[f.name];
    if (f.type === 'checkbox')
      values[f.name] = typeof v === 'boolean' ? v : f.defaultValue === true;
    else if (f.type === 'datetime') values[f.name] = isoToLocalInput(v);
    else if (f.type === 'list') values[f.name] = Array.isArray(v) ? v.join(', ') : '';
    else if (v === null || v === undefined)
      values[f.name] = typeof f.defaultValue === 'string' ? f.defaultValue : '';
    else values[f.name] = str(v);
  }
  return values;
}

/**
 * Builds a request body. Create: empty optional fields are omitted. Edit: only `fields`
 * changed relative to `original` are sent; cleared nullable fields become null.
 */
export function toBody(
  fields: readonly FieldDef[],
  values: FormValues,
  mode: 'create' | 'edit',
  original?: FormValues,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const f of fields) {
    if (mode === 'edit' && f.createOnly) continue;
    const raw = values[f.name];
    if (mode === 'edit' && original && raw === original[f.name]) continue;
    if (f.type === 'checkbox') {
      body[f.name] = raw === true;
      continue;
    }
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text === '') {
      if (mode === 'edit' && f.nullable) body[f.name] = null;
      continue;
    }
    switch (f.type) {
      case 'number':
        body[f.name] = Number(text);
        break;
      case 'datetime':
        body[f.name] = localInputToIso(text);
        break;
      case 'list':
        body[f.name] = text
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      default:
        body[f.name] = text;
    }
  }
  return body;
}
