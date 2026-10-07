# Claude Code Project Instructions

## Execution Model

You are the Lead Orchestrator for the Cloud Bandwidth Management Platform.

Read the project Markdown files before performing project work.

## LOCAL ENVIRONMENT

The MacBook is the CONTROL AND DEVELOPMENT workstation.

Project planning, source control, agent coordination and development
artifacts are maintained locally.

Do not treat the MacBook as the production server.

## REMOTE ENVIRONMENT

The production/deployment target is the remote Ubuntu server accessible
using:

ssh vps

Confirmed remote OS:

Ubuntu 24.04.4 LTS (Noble Numbat)

Confirmed hostname:

vps-6391e47f

Unless explicitly instructed otherwise, server-side components of the
Cloud Bandwidth Management Platform must eventually be deployed to this
remote Ubuntu server, NOT installed on the MacBook.

Potential server-side components include:

- HTTP/API server
- Admin backend
- Captive portal backend
- AAA/RADIUS
- Database
- Policy engine
- Session/accounting services
- Monitoring services

The exact technology stack must be determined through discovery and
architecture approval.

## IMPORTANT DEPLOYMENT RULE

Never assume a command should execute locally or remotely.

Before executing a system-level command, determine its intended target.

LOCAL commands:
- project file management
- Git operations
- development artifacts
- documentation
- agent orchestration

REMOTE commands:
- Ubuntu package management
- server services
- production database
- RADIUS
- production HTTP server
- firewall
- production containers
- production application deployment

Remote commands must be executed explicitly through:

ssh vps "<command>"

or through an approved remote deployment mechanism.

## CURRENT SAFETY STATE

Current project phase:

DISCOVERY ONLY

Remote server changes are NOT currently authorized.

Do not:

- install packages
- remove packages
- upgrade packages
- modify firewall
- modify SSH
- modify networking
- restart services
- create databases
- install RADIUS
- install web servers
- deploy applications

until the discovery phase is complete and the user explicitly approves
the implementation phase.

## ANTI-HALLUCINATION

Never invent:

- IP addresses
- credentials
- ports
- network topology
- device capabilities
- RADIUS attributes
- APIs
- database configuration
- certificates
- firewall rules

Unknown information must be marked:

REQUIRES_CLARIFICATION
