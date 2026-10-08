import { describe, expect, it } from 'vitest';
import {
  WebhookTargetError,
  isPrivateNetworkAddress,
  isPublicWebhookAddress,
  webhookTarget,
} from './net-guard.js';

describe('net-guard (moved from the worker webhook transport, L3)', () => {
  it('public vs private network classification', () => {
    for (const a of [
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '100.100.0.5',
      'fd00::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateNetworkAddress(a), a).toBe(true);
      expect(isPublicWebhookAddress(a), a).toBe(false);
    }
    for (const a of ['127.0.0.1', '169.254.169.254', 'fe80::1', '::1', '224.0.0.1', '0.0.0.0']) {
      expect(isPrivateNetworkAddress(a), a).toBe(false);
      expect(isPublicWebhookAddress(a), a).toBe(false);
    }
    expect(isPublicWebhookAddress('8.8.8.8')).toBe(true);
    expect(isPrivateNetworkAddress('8.8.8.8')).toBe(false);
    expect(isPrivateNetworkAddress('not-an-ip')).toBe(false);
  });

  it('webhookTarget keeps its static rules', () => {
    expect(webhookTarget('https://hooks.example.com/x').hostname).toBe('hooks.example.com');
    for (const bad of [
      'http://a.example',
      'https://u:p@a.example',
      'https://localhost',
      'https://10.0.0.1',
    ]) {
      expect(() => webhookTarget(bad), bad).toThrow(WebhookTargetError);
    }
  });

  it('review F1/F2: trailing-dot localhost and the IPv4-compatible ::/96 block are refused', () => {
    for (const a of [
      '::7f00:1',
      '::127.0.0.1',
      '::8.8.8.8',
      '::a00:1',
      '::10.0.0.1',
      '::1',
      '::',
    ]) {
      expect(isPublicWebhookAddress(a), a).toBe(false);
      expect(isPrivateNetworkAddress(a), a).toBe(false);
    }
    // the mapped / NAT64 forms keep their IPv4 classification
    expect(isPublicWebhookAddress('::ffff:8.8.8.8')).toBe(true);
    expect(isPrivateNetworkAddress('::ffff:10.0.0.1')).toBe(true);
    for (const bad of [
      'https://localhost./',
      'https://localhost../x',
      'https://api.localhost./',
      'https://[::127.0.0.1]/',
      'https://[::7f00:1]/',
      'https://[::8.8.8.8]/',
    ]) {
      expect(() => webhookTarget(bad), bad).toThrow(WebhookTargetError);
    }
    expect(webhookTarget('https://hooks.example.com./').hostname).toBe('hooks.example.com.');
  });
});
