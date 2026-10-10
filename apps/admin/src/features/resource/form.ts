/** Declarative form fields for the generic resource screens and their body conversion. */
import type { ReactNode } from 'react';
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
  | 'list'
  /** Rendered by `render`; the value is a JSON string, sent as parsed JSON (Cycle C). */
  | 'custom';

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
  /** Only shown (and only sent) while this returns true for the current values. */
  visibleWhen?: (values: FormValues) => boolean;
  /** `custom` fields: the editor; `value` is a JSON string ('' = unset). */
  render?: (props: {
    value: string;
    values: FormValues;
    error?: string;
    onChange: (value: string) => void;
  }) => ReactNode;
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
    else if (f.type === 'custom')
      values[f.name] =
        v === null || v === undefined || (typeof v === 'object' && Object.keys(v).length === 0)
          ? row === undefined && typeof f.defaultValue === 'string'
            ? f.defaultValue
            : ''
          : JSON.stringify(v);
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
    if (f.visibleWhen !== undefined && !f.visibleWhen(values)) continue;
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
      case 'custom':
        try {
          body[f.name] = JSON.parse(text) as unknown;
        } catch {
          body[f.name] = text; // the API answers a field error
        }
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
