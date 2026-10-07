/**
 * rlm_rest JSON encoding helpers (docs/contracts/aaa-authorize.md §2–§3).
 * Request: `{ "<Attr>": { "type": "...", "value": [ ... ] } }`.
 * Response: `{ "<list>:<Attr>": { "value": [...], "op": ":=" | "+=", "do_xlat": false } }` — the
 * object form with `do_xlat: false` is mandatory for EVERY attribute (contract §3 rule 1).
 */

export type RadiusRequestBody = Record<string, { type?: unknown; value?: unknown } | undefined>;

/** First value of an attribute as a string (numbers stringified); undefined when absent. */
export function attr(body: RadiusRequestBody, name: string): string | undefined {
  const entry = body[name];
  if (entry === undefined || entry === null || typeof entry !== 'object') return undefined;
  const values = entry.value;
  const first: unknown = Array.isArray(values) ? values[0] : values;
  if (typeof first === 'string') return first;
  if (typeof first === 'number' && Number.isFinite(first)) return String(first);
  return undefined;
}

export function hasAttr(body: RadiusRequestBody, name: string): boolean {
  return body[name] !== undefined;
}

export interface PolicyItem {
  value: (string | number)[];
  op: ':=' | '+=';
  do_xlat: false;
}

export type RadiusPolicy = Record<string, PolicyItem>;

export class PolicyBuilder {
  private readonly items = new Map<string, (string | number)[]>();

  set(list: 'control' | 'reply', name: string, value: string | number): this {
    this.items.set(`${list}:${name}`, [value]);
    return this;
  }

  add(list: 'control' | 'reply', name: string, value: string | number): this {
    const key = `${list}:${name}`;
    const existing = this.items.get(key);
    if (existing === undefined) this.items.set(key, [value]);
    else existing.push(value);
    return this;
  }

  build(): RadiusPolicy {
    const out: RadiusPolicy = {};
    for (const [key, values] of this.items) {
      out[key] = { value: values, op: values.length > 1 ? '+=' : ':=', do_xlat: false };
    }
    return out;
  }
}

/** `ai:` + 32 lowercase hex digits of the session UUID (contract §3 rule 5). */
export function classForSession(sessionId: string): string {
  return `ai:${sessionId.replaceAll('-', '').toLowerCase()}`;
}

/** Parses `ECLOUD-Reply-Class` (`0x…` hex of the ASCII `ai:<32hex>`) back to a session UUID. */
export function sessionIdFromReplyClass(value: string | undefined): string | null {
  if (value === undefined) return null;
  let text = value;
  if (/^0x[0-9a-fA-F]+$/.test(value)) text = Buffer.from(value.slice(2), 'hex').toString('latin1');
  const match = /^ai:([0-9a-f]{32})$/.exec(text);
  if (match?.[1] === undefined) return null;
  const h = match[1];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * FreeRADIUS has no `CoovaChilli-*` dictionary names (contract §3 rule 3): the same vendor id
 * and attribute numbers are spelled `ChilliSpot-*`.
 */
export function dictionaryName(name: string): string {
  return name.startsWith('CoovaChilli-') ? `ChilliSpot-${name.slice('CoovaChilli-'.length)}` : name;
}

/** Contract §3 rule 7: never return User-Password or a control item other than Auth-Type. */
export const FORBIDDEN_REPLY_ATTRIBUTES = new Set(['User-Password', 'Class', 'Cleartext-Password']);

/** `AA-BB-CC-DD-EE-FF` / `aabb.ccdd.eeff` / … → `aa:bb:cc:dd:ee:ff`, or null when not a MAC. */
export function macFrom(value: string | undefined): string | null {
  if (value === undefined) return null;
  const hex = value.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g)?.join(':') ?? null;
}
