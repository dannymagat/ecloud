-- ECLOUD migration 009: FreeRADIUS data integration (DATABASE_DESIGN.md §4.2, AAA_ARCHITECTURE.md §5).
--
-- The `radius` schema is the ONLY surface FreeRADIUS touches (role ecloud_radius, see 010):
--   radius.radacct_raw      insert-only staging; a worker drains it by radacctid watermark into
--                           public.accounting_records / public.sessions, then deletes drained rows
--                           older than 7 days (D-025). Not partitioned so the idempotency key
--                           can be a plain unique index (AAA_ARCHITECTURE.md §5).
--   radius.radpostauth_raw  insert-only post-auth log (no password column on purpose).
--   radius.nas / nas_v      optional rlm_sql client table (official `nas` shape). Pilot renders
--                           clients.conf instead and leaves it empty; when used it is populated by
--                           the worker only, and `secret` is readable solely by ecloud_radius.
-- Requires CREATE on the database for the connected role (ecloud_platform owns ecloud_test;
-- grant it on other databases out-of-band, see packages/db/README.md).
SET LOCAL lock_timeout = '5s';

CREATE SCHEMA radius;

CREATE TABLE radius.radacct_raw (
  radacctid          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  acctsessionid      text NOT NULL,
  acctuniqueid       text NOT NULL,
  username           text,
  realm              text,
  nasipaddress       inet NOT NULL,
  nasidentifier      text,
  nasportid          text,
  nasporttype        text,
  acctstarttime      timestamptz,
  acctupdatetime     timestamptz,
  acctstoptime       timestamptz,
  acctinterval       bigint,
  acctsessiontime    bigint,
  acctauthentic      text,
  connectinfo_start  text,
  connectinfo_stop   text,
  acctinputoctets    bigint,
  acctoutputoctets   bigint,
  calledstationid    text,
  callingstationid   text,
  acctterminatecause text,
  servicetype        text,
  framedprotocol     text,
  framedipaddress    inet,
  framedipv6address  inet,
  framedipv6prefix   inet,
  framedinterfaceid  text,
  delegatedipv6prefix inet,
  class              text,
  acctstatustype     text NOT NULL,
  eventtimestamp     timestamptz,
  acctdelaytime      integer,
  received_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_radacct_raw_status_type CHECK (
    acctstatustype IN ('Start', 'Interim-Update', 'Stop', 'Accounting-On', 'Accounting-Off')
  )
);
-- NAS retransmit of the same packet is a no-op (INSERT ... ON CONFLICT DO NOTHING in queries.conf)
CREATE UNIQUE INDEX uq_radacct_raw_packet ON radius.radacct_raw (
  acctuniqueid, acctstatustype,
  coalesce(acctsessiontime, 0), coalesce(acctinputoctets, 0), coalesce(acctoutputoctets, 0)
);
CREATE INDEX idx_radacct_raw_received ON radius.radacct_raw (received_at);
CREATE INDEX idx_radacct_raw_nas ON radius.radacct_raw (nasipaddress, received_at);

CREATE TABLE radius.radpostauth_raw (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username         text,
  reply            text,
  calledstationid  text,
  callingstationid text,
  nasipaddress     inet,
  nasidentifier    text,
  class            text,
  authdate         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_radpostauth_raw_authdate ON radius.radpostauth_raw (authdate);

-- Official `nas` shape plus the ECLOUD link columns; rendered by the worker from public.nas_clients.
CREATE TABLE radius.nas (
  id                            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nas_client_id                 uuid NOT NULL,
  organization_id               uuid NOT NULL,
  nasname                       text NOT NULL,
  shortname                     text NOT NULL,
  type                          text NOT NULL DEFAULT 'other',
  ports                         integer,
  secret                        text NOT NULL,
  server                        text,
  community                     text,
  description                   text,
  require_message_authenticator boolean NOT NULL DEFAULT true,
  rendered_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_radius_nas_nas_client_id FOREIGN KEY (nas_client_id)
    REFERENCES public.nas_clients (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uq_radius_nas_nas_client_id ON radius.nas (nas_client_id);
CREATE UNIQUE INDEX uq_radius_nas_nasname ON radius.nas (nasname);

CREATE VIEW radius.nas_v AS
  SELECT id, nasname, shortname, type, ports, secret, server, community, description
    FROM radius.nas;
