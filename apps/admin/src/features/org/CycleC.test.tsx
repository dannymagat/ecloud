import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ADAPTER_KEYS, ADAPTER_LABELS } from '../../lib/adapterStatus';
import { initialValues, toBody, type FieldDef } from '../resource/form';
import {
  POSTBACK_NAME_RE,
  POSTBACK_PROFILES,
  PostbackProfileEditor,
} from './PostbackProfileEditor';

describe('Cycle C admin: external captive portal (post-back) NAS profile', () => {
  it('the NAS adapter dropdown offers the post-back adapter', () => {
    expect(ADAPTER_KEYS).toContain('external-portal-postback');
    expect(ADAPTER_LABELS['external-portal-postback']).toMatch(/Cambium.*Aruba/);
  });

  it('offers every built-in profile plus the generic one', () => {
    expect(POSTBACK_PROFILES.map((p) => p.key)).toEqual([
      'cambium-hotspot',
      'aruba-ecp',
      'cisco-webauth',
      'fortinet-ecp',
      'ruckus-wispr',
      'omada-external-portal',
      'huawei-portal',
      'postback-generic',
    ]);
    expect(POSTBACK_NAME_RE.test('ga_cmac')).toBe(true);
    expect(POSTBACK_NAME_RE.test('a"><script>')).toBe(false);
  });

  it('selecting a profile emits the adapter_config JSON', () => {
    const onChange = vi.fn();
    render(<PostbackProfileEditor value="" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/Vendor profile/), {
      target: { value: 'cambium-hotspot' },
    });
    expect(JSON.parse(onChange.mock.calls[0]?.[0] as string)).toEqual({
      profile: 'cambium-hotspot',
    });
  });

  it('the generic profile shows the parameter-name editor and flags invalid names', () => {
    const onChange = vi.fn();
    render(
      <PostbackProfileEditor
        value={JSON.stringify({
          profile: 'postback-generic',
          generic: { params: { client_mac: 'bad name' }, fields: {}, method: 'POST' },
        })}
        onChange={onChange}
      />,
    );
    expect(screen.getByLabelText(/Client MAC parameter/)).toBeInTheDocument();
    expect(screen.getAllByText(/Letters, digits/).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText(/Login \(post-back\) URL parameter/), {
      target: { value: 'login_url' },
    });
    const sent = JSON.parse(onChange.mock.calls.at(-1)?.[0] as string) as {
      generic: { params: Record<string, string> };
    };
    expect(sent.generic.params.login_url).toBe('login_url');
  });

  it('strict login hosts, login path / port and the GET warning are editable', () => {
    const onChange = vi.fn();
    render(
      <PostbackProfileEditor
        value={JSON.stringify({
          profile: 'postback-generic',
          generic: { params: {}, fields: {}, method: 'GET' },
        })}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/credential in the URL/);
    fireEvent.click(screen.getByLabelText(/Strict login hosts/));
    expect(JSON.parse(onChange.mock.calls.at(-1)?.[0] as string)).toMatchObject({
      strict_login_hosts: true,
    });
    fireEvent.change(screen.getByLabelText(/Login path on the device/), {
      target: { value: '/auth' },
    });
    fireEvent.change(screen.getByLabelText(/Login port on the device/), {
      target: { value: '8080' },
    });
    expect(JSON.parse(onChange.mock.calls.at(-1)?.[0] as string)).toMatchObject({
      generic: { login_port: 8080 },
    });
  });

  it('custom fields are sent as JSON only while visible', () => {
    const fields: FieldDef[] = [
      { name: 'adapter_key', label: 'Adapter', type: 'select' },
      {
        name: 'adapter_config',
        label: 'Profile',
        type: 'custom',
        visibleWhen: (v) => v.adapter_key === 'external-portal-postback',
      },
    ];
    const values = {
      adapter_key: 'external-portal-postback',
      adapter_config: '{"profile":"aruba-ecp"}',
    };
    expect(toBody(fields, values, 'create')).toEqual({
      adapter_key: 'external-portal-postback',
      adapter_config: { profile: 'aruba-ecp' },
    });
    expect(toBody(fields, { ...values, adapter_key: 'generic-radius-8021x' }, 'create')).toEqual({
      adapter_key: 'generic-radius-8021x',
    });
    expect(initialValues(fields, { adapter_config: { profile: 'x' } }).adapter_config).toBe(
      '{"profile":"x"}',
    );
    expect(initialValues(fields, { adapter_config: {} }).adapter_config).toBe('');
  });
});
