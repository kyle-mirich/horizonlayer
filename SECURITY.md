# Security Policy

## Supported Scope

Horizon Layer is a local-first MCP server intended to run on trusted developer machines or in self-managed infrastructure. The highest-priority reports are issues that could affect:

- database integrity or unintended data loss
- privilege or access boundary bypasses inside the local/system runtime model
- secret leakage through logs, responses, or setup flows
- command execution or startup paths that behave unsafely with untrusted input

The repository does not currently ship hosted auth, SSO, or a multi-tenant production control plane. Reports should be framed against the current local-first design rather than a hypothetical SaaS deployment.

## Reporting a Vulnerability

Please do not open public GitHub issues for suspected security vulnerabilities.

Prefer one of these private channels:

- GitHub Security Advisories for this repository, if enabled
- direct contact with the repository owner through GitHub

Please include:

- a clear description of the issue
- affected versions or commit ranges, if known
- reproduction steps or a proof of concept
- impact assessment
- any suggested mitigation

## Disclosure Expectations

- I will acknowledge receipt as quickly as possible.
- I will validate the report before discussing severity or timelines.
- I prefer coordinated disclosure after a fix is available.

## Safe Harbor

Good-faith research that avoids data destruction, denial of service, or access to other peoples' systems is welcome.
