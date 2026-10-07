/**
 * Reusable stub of the ECLOUD internal AAA listener as specified in
 * docs/contracts/aaa-authorize.md (FreeRADIUS rlm_rest -> `/internal/aaa/authorize` and
 * `/internal/aaa/post-auth`). Used by the aaa-contract suite against the real FreeRADIUS
 * container and by unit tests; it is NOT an implementation of ECLOUD's AAA decision logic.
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const AAA_AUTHORIZE_PATH = '/internal/aaa/authorize';
export const AAA_POST_AUTH_PATH = '/internal/aaa/post-auth';
export const INTERNAL_TOKEN_HEADER = 'x-internal-token';
/** Reply-Message FreeRADIUS sends when the backend fails (contract §4). */
export const AAA_UNAVAILABLE_MESSAGE = 'AAA backend unavailable';

/** rlm_rest JSON policy value; `do_xlat: false` is mandatory (contract §3 rule 1). */
export interface PolicyValue {
  value: (string | number)[];
  op: ':=' | '+=' | '=';
  do_xlat: false;
}

export type RlmRestPolicy = Record<string, PolicyValue>;

/** `{"value":[v],"op":":=","do_xlat":false}` */
export function policyValue(
  value: string | number | (string | number)[],
  op: PolicyValue['op'] = ':=',
): PolicyValue {
  return { value: Array.isArray(value) ? value : [value], op, do_xlat: false };
}

export interface AcceptPolicyInput {
  /** `PAP` (default, FreeRADIUS compares `cleartextPassword`), `CHAP` or `Accept`. */
  authType?: 'PAP' | 'CHAP' | 'MS-CHAP' | 'Accept';
  /** Required for PAP/CHAP/MS-CHAP. */
  cleartextPassword?: string;
  /** Reply attributes without the `reply:` prefix, e.g. `{ 'Session-Timeout': 3600 }`. */
  reply?: Record<string, string | number>;
}

/** Builds a contract-conformant 200 body (§3). */
export function buildAcceptPolicy(input: AcceptPolicyInput = {}): RlmRestPolicy {
  const authType = input.authType ?? 'PAP';
  if (authType !== 'Accept' && input.cleartextPassword === undefined) {
    throw new Error(`buildAcceptPolicy: Auth-Type ${authType} requires cleartextPassword`);
  }
  const policy: RlmRestPolicy = { 'control:Auth-Type': policyValue(authType) };
  if (input.cleartextPassword !== undefined) {
    policy['control:Cleartext-Password'] = policyValue(input.cleartextPassword);
  }
  for (const [name, value] of Object.entries(input.reply ?? {})) {
    policy[`reply:${name}`] = policyValue(value);
  }
  return policy;
}

/** Builds the optional 401 body that carries a Reply-Message (§4). */
export function buildRejectPolicy(replyMessage?: string): RlmRestPolicy | undefined {
  return replyMessage === undefined
    ? undefined
    : { 'reply:Reply-Message': policyValue(replyMessage) };
}

export type AaaStubMode =
  | { kind: 'accept'; policy: RlmRestPolicy }
  | { kind: 'reject'; replyMessage?: string; status?: 401 | 403 }
  | { kind: 'unavailable'; status?: number }
  | { kind: 'slow'; delayMs: number; policy: RlmRestPolicy };

/** One request seen by the stub; `body` is the parsed rlm_rest JSON (contract §2). */
export interface AaaStubRequest {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, { type?: string; value?: unknown[] }> | undefined;
  /** Status the stub answered with. */
  status: number;
  receivedAt: number;
}

export interface AaaStub {
  /** `http://<host>:<port>` as bound. */
  url: string;
  host: string;
  port: number;
  setMode(mode: AaaStubMode): void;
  readonly requests: readonly AaaStubRequest[];
  clearRequests(): void;
  /** Resolves with the first recorded request matching `predicate` (polls until `timeoutMs`). */
  waitForRequest(
    predicate: (request: AaaStubRequest) => boolean,
    timeoutMs?: number,
  ): Promise<AaaStubRequest>;
  close(): Promise<void>;
}

export interface StartAaaStubOptions {
  /** Default `127.0.0.1`. Use `0.0.0.0` when a container reaches the host via the bridge gateway. */
  host?: string;
  /** Default `0` (ephemeral). */
  port?: number;
  /** Expected `X-Internal-Token`; mismatches get `401` without a body (contract §1). */
  token?: string;
  mode?: AaaStubMode;
}

/** First value of a contract attribute (`{"type":..,"value":[..]}`), or `undefined`. */
export function attributeValue(body: AaaStubRequest['body'], name: string): unknown {
  return body?.[name]?.value?.[0];
}

function tokenMatches(expected: string, received: string | string[] | undefined): boolean {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  // rlm_rest sends octets attributes as raw bytes inside JSON strings: decode as latin1.
  return Buffer.concat(chunks).toString('latin1');
}

function parseJson(text: string): AaaStubRequest['body'] {
  if (text.trim() === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as AaaStubRequest['body'])
      : undefined;
  } catch {
    return undefined;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Starts the stub; default mode is `unavailable` (500) so nothing is accepted by accident. */
export async function startAaaStub(options: StartAaaStubOptions = {}): Promise<AaaStub> {
  let mode: AaaStubMode = options.mode ?? { kind: 'unavailable' };
  const requests: AaaStubRequest[] = [];

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const raw = await readBody(req);
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const record = (status: number): void => {
      requests.push({
        path,
        method: req.method ?? '',
        headers: { ...req.headers },
        body: parseJson(raw),
        status,
        receivedAt: Date.now(),
      });
    };

    if (req.method !== 'POST' || (path !== AAA_AUTHORIZE_PATH && path !== AAA_POST_AUTH_PATH)) {
      record(404);
      res.writeHead(404).end();
      return;
    }
    if (
      options.token !== undefined &&
      !tokenMatches(options.token, req.headers[INTERNAL_TOKEN_HEADER])
    ) {
      record(401);
      res.writeHead(401).end();
      return;
    }
    if (path === AAA_POST_AUTH_PATH) {
      record(204);
      res.writeHead(204).end();
      return;
    }

    const current = mode;
    switch (current.kind) {
      case 'accept':
        record(200);
        sendJson(res, 200, current.policy);
        return;
      case 'slow':
        await new Promise((resolve) => setTimeout(resolve, current.delayMs));
        record(200);
        if (!res.destroyed) sendJson(res, 200, current.policy);
        return;
      case 'reject': {
        const status = current.status ?? 401;
        record(status);
        const body = buildRejectPolicy(current.replyMessage);
        if (body === undefined) res.writeHead(status).end();
        else sendJson(res, status, body);
        return;
      }
      case 'unavailable': {
        const status = current.status ?? 500;
        record(status);
        res.writeHead(status).end();
        return;
      }
    }
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const urlHost = host.includes(':') ? `[${host}]` : host;

  return {
    url: `http://${urlHost}:${String(port)}`,
    host,
    port,
    setMode(next) {
      mode = next;
    },
    get requests() {
      return requests;
    },
    clearRequests() {
      requests.length = 0;
    },
    async waitForRequest(predicate, timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = requests.find(predicate);
        if (found !== undefined) return found;
        if (Date.now() >= deadline) {
          throw new Error(`AAA stub: no matching request within ${String(timeoutMs)} ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
