import { useState, type FormEvent, type ReactNode } from 'react';
import { fieldErrors, type Problem } from '../../api/problem';
import { ProblemAlert } from '../../components/ProblemAlert';
import { Button, CheckboxField, SelectField, TextAreaField, TextField } from '../../components/ui';
import { initialValues, type FieldDef, type FormValues } from './form';
import { useOptions } from './useOptions';

function FieldInput({
  field,
  orgId,
  value,
  error,
  onChange,
}: {
  field: FieldDef;
  orgId: string;
  value: string | boolean;
  error?: string;
  onChange: (v: string | boolean) => void;
}) {
  const options = useOptions(orgId, field.optionsFrom);
  const common = {
    label: field.label,
    hint: field.hint,
    error,
    required: field.required,
    placeholder: field.placeholder,
  };
  switch (field.type) {
    case 'custom':
      return field.render === undefined ? null : (
        <>{field.render({ value: String(value), values: {}, error, onChange })}</>
      );
    case 'checkbox':
      return (
        <CheckboxField
          label={field.label}
          hint={field.hint}
          checked={value === true}
          onChange={onChange}
        />
      );
    case 'select': {
      const opts = field.options ?? options.data ?? [];
      return (
        <SelectField
          {...common}
          hint={options.isLoading ? 'Loading options…' : field.hint}
          options={opts}
          placeholder={field.required ? 'Select…' : '— none —'}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }
    case 'textarea':
      return (
        <TextAreaField
          {...common}
          rows={3}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    default:
      return (
        <TextField
          {...common}
          type={
            field.type === 'number'
              ? 'number'
              : field.type === 'datetime'
                ? 'datetime-local'
                : field.type === 'list'
                  ? 'text'
                  : field.type
          }
          min={field.min}
          max={field.max}
          autoComplete={field.type === 'password' ? 'new-password' : 'off'}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

export interface ResourceFormProps {
  orgId: string;
  fields: readonly FieldDef[];
  mode: 'create' | 'edit';
  row?: Record<string, unknown>;
  submitLabel: string;
  busy: boolean;
  problem: Problem | null;
  onSubmit: (values: FormValues, original: FormValues) => void;
  onCancel: () => void;
  footer?: ReactNode;
  /** Observes every change (e.g. live preview). */
  onValuesChange?: (values: FormValues) => void;
}

export function ResourceForm({
  orgId,
  fields,
  mode,
  row,
  submitLabel,
  busy,
  problem,
  onSubmit,
  onCancel,
  footer,
  onValuesChange,
}: ResourceFormProps) {
  const shown = fields.filter((f) => !(mode === 'edit' && f.createOnly));
  const [original] = useState(() => initialValues(fields, row));
  const [values, setValues] = useState<FormValues>(original);
  const errors = fieldErrors(problem);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(values, original);
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {shown
          .filter((f) => f.visibleWhen === undefined || f.visibleWhen(values))
          .map((f) => (
            <div
              key={f.name}
              className={
                f.type === 'textarea' || f.type === 'checkbox' || f.type === 'custom'
                  ? 'sm:col-span-2'
                  : undefined
              }
            >
              <FieldInput
                field={f}
                orgId={orgId}
                value={values[f.name] ?? ''}
                error={errors[f.name]}
                onChange={(v) => {
                  const next = { ...values, [f.name]: v };
                  setValues(next);
                  onValuesChange?.(next);
                }}
              />
            </div>
          ))}
      </div>
      <ProblemAlert problem={problem} />
      {footer}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" busy={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
