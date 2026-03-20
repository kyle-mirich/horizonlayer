# Deployment

This repository supports three deployment shapes:

1. Local `stdio` via the launcher in `dist/launcher.js`
2. Local HTTP via Docker Compose or a local Node process
3. AWS deployment via Terraform

For AWS, the practical production path in this repo is:

1. Build and push the app image to Terraform-managed ECR.
2. Provision networking, ECS Fargate, an ALB, EFS-backed runtime state, and RDS PostgreSQL with Terraform.
3. Store infrastructure or application secrets in AWS Secrets Manager when needed and wire their ARNs into Terraform inputs.
4. Deploy the ECS service revision that points at the pushed image tag.

The Terraform entrypoint lives in [`infra/terraform`](../infra/terraform).

## What Terraform creates

- A dedicated VPC with two public subnets for the ALB and Fargate tasks.
- Two private database subnets for PostgreSQL.
- An internet-facing ALB with `/healthz` target checks.
- An ECS cluster, task definition, and Fargate service for the app container.
- An ECR repository for the application image.
- An encrypted EFS file system mounted into the container at `/app/runtime-state`.
- A PostgreSQL RDS instance with a Secrets Manager-managed master password.
- Security groups, IAM execution role, and CloudWatch log group wiring.

## Assumptions

- The application image built from the existing `Dockerfile` is the deployable artifact.
- The app should run as a single ECS service behind an ALB.
- Runtime state and model/cache artifacts should persist across task replacements, so ECS mounts EFS for runtime-state data.
- PostgreSQL is provided by RDS, and the existing startup flow runs migrations on process boot.
- Secrets stay in Secrets Manager rather than Terraform state.

## Prerequisites

- AWS account credentials with permissions for ECS, ECR, ALB, VPC, EFS, IAM, CloudWatch, RDS, and Secrets Manager.
- Terraform `>= 1.6`.
- Docker with access to build the application image.
- AWS CLI configured for the target account and region.

## Local deployment modes

### Local stdio launcher

Use this when the MCP client expects a stdio server:

```bash
make install
make build
node dist/launcher.js
```

If `DATABASE_URL` is unset, the launcher tries to ensure a local Docker-backed PostgreSQL instance is available first. If Docker is not available, startup fails with a user-facing message that tells the user to start Docker Desktop or set `DATABASE_URL`.

Literal first-run flow:

```bash
git clone https://github.com/kyle-mirich/horizonlayer.git
cd horizonlayer
npm ci
npm run build
codex mcp add horizondb -- node "$(pwd)/dist/launcher.js"
```

### Local HTTP server

Use this when you want a long-running endpoint at `http://127.0.0.1:3000/mcp`:

```bash
make docker-up
```

Or:

```bash
make db-up
make dev
```

Literal first-run flow:

```bash
git clone https://github.com/kyle-mirich/horizonlayer.git
cd horizonlayer
npm ci
docker compose up --build
```

## 1. Create supporting secrets if your environment needs them

This repo no longer requires app-layer OAuth or cookie secrets. Depending on your deployment, you may still choose to store values such as `DATABASE_URL` overrides or other operational secrets in Secrets Manager.

Example:

```bash
aws secretsmanager create-secret \
  --name horizon-layer/prod/example-secret \
  --secret-string 'replace-with-64-random-bytes'
```

The RDS password does not need a manual secret. Terraform enables `manage_master_user_password`, and AWS creates that secret for the database instance automatically.

## 2. Configure Terraform inputs

Copy the example tfvars and fill in your values:

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
```

Required inputs for a normal deployment:

- `aws_region`
- `app_image_tag`

Optional but common:

- `public_base_url` if you are fronting the ALB with a real DNS name
- `certificate_arn` for HTTPS
- `allowed_hosts`

## 3. Provision the AWS foundation

Initialize and apply Terraform:

```bash
cd infra/terraform
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

Useful outputs after apply:

- `ecr_repository_url`
- `alb_dns_name`
- `app_base_url`
- `ecs_cluster_name`
- `ecs_service_name`
- `rds_endpoint`
- `rds_master_secret_arn`

## 4. Build and push the application image

Use the Terraform-created ECR repository:

```bash
AWS_REGION=us-west-2
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REPO_URL="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/horizon-layer-prod"
IMAGE_TAG="2026-03-12"

aws ecr get-login-password --region "${AWS_REGION}" | \
  docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

docker build -t "${REPO_URL}:${IMAGE_TAG}" .
docker push "${REPO_URL}:${IMAGE_TAG}"
```

If your `project_name` or `environment` differs, use the `ecr_repository_url` Terraform output instead of composing the repository URL manually.

## 5. Roll out the container revision

Update `app_image_tag` in `terraform.tfvars`, then re-apply Terraform:

```bash
cd infra/terraform
terraform apply
```

Terraform will register a new ECS task definition revision and update the service.

## 6. Post-deploy checks

- Open the ALB DNS name or your configured `public_base_url`.
- Verify `GET /healthz` returns `200`.
- Verify the app can reach PostgreSQL and complete migrations on boot.
- Verify your MCP client can reach the deployed `/mcp` endpoint over the expected transport.

## Operational notes

- ECS tasks run in public subnets with a public IP to avoid NAT-gateway overhead. Security groups still limit inbound traffic to the ALB only.
- RDS stays private and only accepts traffic from the ECS service security group.
- EFS stores runtime state and cache data so task replacement does not wipe downloaded model artifacts or other persisted local files.
- The ECS task now sets `DB_SSL_MODE=require` for RDS and auto-populates `ALLOWED_HOSTS` from the ALB/public base URL unless you override it.
- The app still downloads and initializes the embedding model at runtime. The first healthy deployment will be slower than subsequent task starts.
- The current stack deploys one ECS service and one RDS instance. Add autoscaling, Route 53, WAF, and CI/CD only when you need them.

## Files

- Local stdio launcher: [`src/launcher.ts`](../src/launcher.ts)
- Terraform root: [`infra/terraform`](../infra/terraform)
- Local container workflow: [`Dockerfile`](../Dockerfile), [`docker-compose.yml`](../docker-compose.yml)
