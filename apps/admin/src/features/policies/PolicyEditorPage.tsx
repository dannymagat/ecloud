/** Policy intent editor with API validation errors and the live enforceability preview. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, newIdempotencyKey, type RequestBody } from '../../api/client';
import { problemOf, type Problem } from '../../api/problem';
import type { Row } from '../../api/types';
import { ProblemAlert } from '../../components/ProblemAlert';
import { Card, Notice, PageHeader, Spinner } from '../../components/ui';
import { RequireOrgPermission } from '../../layout/guards';
import { useAuth } from '../../lib/auth';
import { useOrgId } from '../../lib/org';
import { can } from '../../lib/permissions';
import { initialValues, toBody, type FormValues } from '../resource/form';
import { ResourceForm } from '../resource/ResourceForm';
import { ENFORCEMENT_FIELDS, POLICY_FORM_FIELDS } from './policyFields';
import type { AdapterColumn } from './EnforceabilityMatrix';
import { ImpactPreview } from './ImpactPreview';
import { PreviewPanel } from './PreviewPanel';
import { str } from '../../lib/format';

type CreateBody = RequestBody<'/api/v1/orgs/{orgId}/policies', 'post'>;

function setFields(values: FormValues): string[] {
  return ENFORCEMENT_FIELDS.filter((f) => {
    const v = values[f];
    return typeof v === 'string' ? v.trim() !== '' : v === true;
  });
}

function Editor({ row }: { row?: Row }) {
  const orgId = useOrgId();
  const { me } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const original = useMemo(() => initialValues(POLICY_FORM_FIELDS, row), [row]);
  const [values, setValues] = useState<FormValues>(original);
  const [columns, setColumns] = useState<AdapterColumn[]>([]);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [idemKey] = useState(newIdempotencyKey);
  const mode = row ? 'edit' : 'create';
  const permission = row ? 'policy:update' : 'policy:create';
  const allowed = can(me, permission, { organizationId: orgId, anySite: true });

  const save = useMutation({
    mutationFn: ({ values: v, original }: { values: FormValues; original: FormValues }) =>
      row
        ? api('patch', '/api/v1/orgs/{orgId}/policies/{id}', {
            params: { orgId, id: row.id },
            body: toBody(POLICY_FORM_FIELDS, v, 'edit', original),
          })
        : api('post', '/api/v1/orgs/{orgId}/policies', {
            params: { orgId },
            body: toBody(POLICY_FORM_FIELDS, v, 'create') as CreateBody,
            idempotencyKey: idemKey,
          }),
    onSuccess: async (saved) => {
      await qc.invalidateQueries({ queryKey: ['org', orgId] });
      void navigate(`/orgs/${orgId}/policies/${saved.id}`, { replace: true });
    },
    onError: (e) => setProblem(problemOf(e)),
  });

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card title={row ? `Edit policy (version ${str(row.version ?? '1')})` : 'New policy'}>
        {allowed ? null : (
          <div className="mb-3">
            <Notice tone="warning">
              Read-only: saving requires <code>{permission}</code>.
            </Notice>
          </div>
        )}
        <ResourceForm
          key={row?.id ?? 'new'}
          orgId={orgId}
          fields={POLICY_FORM_FIELDS}
          mode={mode}
          row={row}
          submitLabel={row ? 'Save changes' : 'Create policy'}
          busy={save.isPending}
          problem={problem}
          onValuesChange={setValues}
          onCancel={() => void navigate(`/orgs/${orgId}/policies`)}
          onSubmit={(v, original) => {
            if (!allowed) return;
            setProblem(null);
            save.mutate({ values: v, original });
          }}
        />
      </Card>
      <div className="space-y-4">
        <PreviewPanel orgId={orgId} draftFields={setFields(values)} onColumns={setColumns} />
        {row ? (
          <ImpactPreview
            orgId={orgId}
            policyId={row.id}
            changes={toBody(POLICY_FORM_FIELDS, values, 'edit', original)}
            columns={columns}
            allowed={can(me, 'policy:preview', { organizationId: orgId, anySite: true })}
          />
        ) : null}
      </div>
    </div>
  );
}

function EditorScreen() {
  const orgId = useOrgId();
  const { policyId } = useParams();
  const isNew = policyId === undefined || policyId === 'new';
  const query = useQuery({
    queryKey: ['org', orgId, 'policy', policyId],
    enabled: !isNew,
    queryFn: ({ signal }) =>
      api('get', '/api/v1/orgs/{orgId}/policies/{id}', {
        params: { orgId, id: policyId as string },
        signal,
      }),
  });
  return (
    <div>
      <PageHeader
        title={isNew ? 'New policy' : str(query.data?.name ?? 'Policy')}
        description={
          <Link to={`/orgs/${orgId}/policies`} className="text-primary hover:underline">
            ← All policies
          </Link>
        }
      />
      {isNew ? (
        <Editor />
      ) : query.isPending ? (
        <Spinner label="Loading policy…" />
      ) : query.error ? (
        <ProblemAlert error={query.error} />
      ) : (
        <Editor row={query.data} />
      )}
    </div>
  );
}

export function PolicyEditorPage() {
  return (
    <RequireOrgPermission permission="policy:read">
      <EditorScreen />
    </RequireOrgPermission>
  );
}
