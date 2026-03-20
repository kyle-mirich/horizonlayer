# infra

`infra/` holds deployment infrastructure rather than application runtime code.

## What Is Here

- `terraform/`: the AWS deployment baseline for the service.

## Scope

This folder exists to provision and configure the environment around the app:

- networking
- compute
- persistent storage
- database
- secrets wiring
- deployment outputs

The runtime still lives in `src/`. `infra/` only explains where that runtime gets deployed.
