# Architecture

## Status
`PROPOSED — discovery required before technology/device-specific implementation.`

## Logical Architecture

```text
                         CLOUD MANAGEMENT PLATFORM
┌───────────────────────────────────────────────────────────────────┐
│ Admin UI: Dashboard | Sites | Users | Devices | Policies | Logs   │
│           Portal | Sessions | Reports | Admin/RBAC                │
└──────────────────────────────┬────────────────────────────────────┘
                               │ HTTPS
                               ▼
┌───────────────────────────────────────────────────────────────────┐
│                       HTTP / API LAYER                            │
│ Admin API | Portal API | Policy API | Device API | Reporting      │
└───────────┬───────────────┬───────────────┬───────────────────────┘
            │               │               │
            ▼               ▼               ▼
     ┌─────────────┐ ┌─────────────┐ ┌─────────────────┐
     │ AAA/RADIUS  │ │Policy Engine│ │ Session Manager │
     │ Auth/Authz  │ │Intent/Assign│ │ Active Sessions │
     │ Accounting  │ │             │ │ Dynamic Action* │
     └──────┬──────┘ └──────┬──────┘ └────────┬────────┘
            └───────────────┬┴─────────────────┘
                            ▼
                 ┌──────────────────────┐
                 │       DATABASE       │
                 │ Sites / Users        │
                 │ Devices / Policies   │
                 │ Sessions / Accounting│
                 │ Portal / Audit       │
                 └──────────┬───────────┘
                            │
                      Secure Connectivity
                            │
          ┌─────────────────┼─────────────────┐
          ▼                 ▼                 ▼
       SITE A            SITE B            SITE N
   Gateway/AP*       Gateway/AP*       Gateway/AP*
          │                 │                 │
       Clients           Clients           Clients
```

`* Exact enforcement and dynamic-control capabilities are UNVERIFIED.`

## Access Flow
```text
Client connects
      │
      ▼
Network access device
      │
      ├── Authorized? ── yes ──> permitted network access
      │
      no
      ▼
Captive portal
      │
      ▼
Supported credential/access method
      │
      ▼
AAA / RADIUS
      │
      ├── reject ──> deny / portal error
      │
      └── accept
            │
            ▼
      Resolve assigned policy
            │
            ▼
   Translate to VERIFIED device mechanism
            │
            ▼
       Enforcement point
            │
            ▼
        Network access
            │
            ▼
    Accounting / session updates
```

## Key Architecture Principle
The cloud service manages policy intent. Actual packet-level enforcement belongs at a verified traffic enforcement point. Do not assume that point is the AP.
