# infra/terraform

This folder contains the Terraform configuration for the AWS-hosted version of Horizon Layer.

## Files

- `versions.tf`: Terraform and provider version requirements.
- `variables.tf`: the full input surface for infrastructure sizing, auth, billing, networking, and app runtime settings.
- `main.tf`: the actual infrastructure graph.
- `outputs.tf`: the values you need after apply, such as ALB DNS name, ECR URL, and service identifiers.
- `terraform.tfvars.example`: starter values for a deployable environment.
- `.gitignore`: keeps local Terraform state artifacts out of Git.

## What `main.tf` Builds

- VPC, subnets, route tables, and internet gateway
- security groups for ALB, ECS service, RDS, and EFS
- ALB and target group with `/healthz` checks
- ECS cluster, task definition, and Fargate service
- ECR repository for the app image
- RDS PostgreSQL instance
- EFS for runtime state such as auth/cache directories
- IAM and secret wiring for container env vars and secret injection

## App Configuration Surface

The Terraform layer does more than infrastructure. It also constructs most of the container environment:

- server transport and host/port
- base URL and allowed hosts
- Postgres host/port/name/user and SSL mode
- embedding model configuration
- auth and SSO toggles
- billing toggles
- cache/model directories mounted into runtime state

That means production behavior is partially shaped here, not only in `src/config.ts`.

## When To Read This Folder

- before changing deployment assumptions
- before adding a new required env var
- before changing runtime paths that depend on EFS persistence
- before touching auth or billing settings that need secret injection
