/**
 * Simulated RADIUS accounting stream (MULTI_VENDOR_INTEGRATION_PLAN.md §8.3 SIM-10…SIM-18).
 * Produces rows shaped like `radius.radacct_raw` as FreeRADIUS writes them
 * (`infra/freeradius/raddb/mods-config/sql/main/postgresql/queries.conf`: octets folded as
 * `(Gigawords << 32) + Octets`, AAA_ARCHITECTURE.md §5.2; fixtures `infra/freeradius/test/acct-*`).
 * Independent of `@ecloud/adapters`: the row type is structural.
 *
 * Counter width per adapter (CAPTIVE_PORTAL_ARCHITECTURE.md §3.4/§4, PHASE2_VALIDATION V-054):
 * CoovaChilli sends Acct-*-Gigawords (64-bit totals); uspot TIP sends 32-bit Octets only, so a
 * long session's counter wraps at 2^32. How the real TIP firmware wraps is REQUIRES_DEVICE_TEST.
 */

export const TWO_POW_32 = 4_294_967_296;

export type SimAcctStatus =
  'Start' | 'Interim-Update' | 'Stop' | 'Accounting-On' | 'Accounting-Off';

/** Structural copy of the drainer's `RawAccountingRow` (`radius.radacct_raw` subset). */
export interface SimRawAccountingRow {
  radacctid: number;
  acctsessionid: string;
  acctuniqueid: string;
  username: string | null;
  nasipaddress: string;
  nasidentifier: string | null;
  nasportid: string | null;
  acctsessiontime: number | null;
  acctinputoctets: number | null;
  acctoutputoctets: number | null;
  acctinterval: number | null;
  calledstationid: string | null;
  callingstationid: string | null;
  acctterminatecause: string | null;
  framedipaddress: string | null;
  class: string | null;
  acctstatustype: SimAcctStatus;
  eventtimestamp: Date | null;
  acctdelaytime: number | null;
  received_at: Date;
  packet_src_ip: string | null;
}

/** What the NAS puts on the wire for one direction of a counter. */
export interface WireCounter {
  readonly octets: number;
  /** null = attribute not sent (uspot TIP). */
  readonly gigawords: number | null;
}

/** Splits a true byte total into the wire attributes a NAS of the given width sends. */
export function wireCounter(totalBytes: number, octetWidth: 32 | 64): WireCounter {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) throw new Error('bad byte total');
  const octets = totalBytes % TWO_POW_32;
  return octetWidth === 64
    ? { octets, gigawords: Math.floor(totalBytes / TWO_POW_32) }
    : { octets, gigawords: null };
}

/** FreeRADIUS `queries.conf` fold: `(Gigawords << 32) + Octets` (missing Gigawords = 0). */
export function freeradiusFold(counter: WireCounter): number {
  return (counter.gigawords ?? 0) * TWO_POW_32 + counter.octets;
}

export interface SimSessionIdentity {
  readonly acctSessionId: string;
  readonly acctUniqueId: string;
  readonly username: string | null;
  /** `AA-BB-CC-DD-EE-FF`. */
  readonly callingStationId: string;
  readonly calledStationId: string;
  readonly nasIp: string;
  /** Authenticated UDP source (migration 014); defaults to `nasIp`. */
  readonly packetSrcIp?: string | null;
  readonly nasIdentifier: string;
  readonly class?: string | null;
  readonly framedIp?: string | null;
}

export interface SimPacket {
  readonly status: SimAcctStatus;
  readonly at: Date;
  /** True byte totals since session start; split + folded per `octetWidth`. */
  readonly inputBytes?: number;
  readonly outputBytes?: number;
  readonly sessionTimeS?: number;
  readonly terminateCause?: string;
  readonly interimS?: number;
}

/**
 * One simulated NAS session. `radacctid` values are local sequence numbers (the DB assigns
 * real ones on insert).
 */
export class SimAccountingSession {
  private seq = 0;

  constructor(
    readonly identity: SimSessionIdentity,
    readonly octetWidth: 32 | 64,
  ) {}

  /** The row FreeRADIUS would write for `packet` (Gigawords folded, width applied). */
  row(packet: SimPacket): SimRawAccountingRow {
    this.seq += 1;
    const id = this.identity;
    const counters = packet.status === 'Accounting-On' || packet.status === 'Accounting-Off';
    const fold = (bytes: number | undefined): number | null =>
      bytes === undefined ? null : freeradiusFold(wireCounter(bytes, this.octetWidth));
    return {
      radacctid: this.seq,
      acctsessionid: id.acctSessionId,
      acctuniqueid: id.acctUniqueId,
      username: counters ? null : id.username,
      nasipaddress: id.nasIp,
      nasidentifier: id.nasIdentifier,
      nasportid: null,
      acctsessiontime: packet.sessionTimeS ?? null,
      acctinputoctets: fold(packet.inputBytes),
      acctoutputoctets: fold(packet.outputBytes),
      acctinterval: packet.interimS ?? null,
      calledstationid: id.calledStationId,
      callingstationid: counters ? null : id.callingStationId,
      acctterminatecause: packet.terminateCause ?? null,
      framedipaddress: id.framedIp ?? null,
      class: id.class ?? null,
      acctstatustype: packet.status,
      eventtimestamp: packet.at,
      acctdelaytime: 0,
      received_at: packet.at,
      packet_src_ip: id.packetSrcIp === undefined ? id.nasIp : id.packetSrcIp,
    };
  }
}

/** `ai:` + 32 hex of the session UUID, as the octets string FreeRADIUS stores (contract §3 rule 5). */
export function simClassFor(sessionUuid: string): string {
  const hex = sessionUuid.replace(/-/g, '');
  return `0x61693a${Buffer.from(hex, 'latin1').toString('hex')}`;
}
