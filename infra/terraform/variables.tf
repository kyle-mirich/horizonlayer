variable "aws_region" {
  description = "AWS region for the deployment."
  type        = string
}

variable "project_name" {
  description = "Short project slug used in resource names."
  type        = string
  default     = "horizon-layer"
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
  default     = "prod"
}

variable "app_image_tag" {
  description = "Container image tag to run from the Terraform-managed ECR repository."
  type        = string
}

variable "app_version" {
  description = "Application version exposed to the container."
  type        = string
  default     = "1.0.0"
}

variable "public_base_url" {
  description = "Public base URL for the service. Leave null to use the ALB DNS name over HTTP."
  type        = string
  default     = null
}

variable "certificate_arn" {
  description = "Optional ACM certificate ARN for HTTPS on the ALB."
  type        = string
  default     = null
}

variable "allowed_ingress_cidrs" {
  description = "CIDR blocks allowed to reach the public ALB listeners."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "vpc_cidr" {
  description = "CIDR block for the application VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for two public subnets used by the ALB and ECS tasks."
  type        = list(string)
  default     = ["10.42.0.0/24", "10.42.1.0/24"]
}

variable "private_db_subnet_cidrs" {
  description = "CIDR blocks for two private subnets used by RDS."
  type        = list(string)
  default     = ["10.42.10.0/24", "10.42.11.0/24"]
}

variable "container_port" {
  description = "Application container port."
  type        = number
  default     = 3000
}

variable "ecs_cpu" {
  description = "Fargate task CPU units."
  type        = number
  default     = 1024
}

variable "ecs_memory" {
  description = "Fargate task memory in MiB."
  type        = number
  default     = 2048
}

variable "desired_count" {
  description = "Desired ECS task count."
  type        = number
  default     = 1
}

variable "health_check_path" {
  description = "ALB target group health check path."
  type        = string
  default     = "/healthz"
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days."
  type        = number
  default     = 30
}

variable "db_name" {
  description = "Application database name."
  type        = string
  default     = "horizon_layer"
}

variable "db_username" {
  description = "Master username for the RDS instance."
  type        = string
  default     = "horizon_layer"
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.small"
}

variable "db_engine_version" {
  description = "Optional RDS PostgreSQL engine version."
  type        = string
  default     = null
}

variable "db_allocated_storage" {
  description = "Initial RDS storage in GiB."
  type        = number
  default     = 20
}

variable "db_max_allocated_storage" {
  description = "Maximum autoscaled RDS storage in GiB."
  type        = number
  default     = 100
}

variable "db_backup_retention_period" {
  description = "Number of days to retain automated RDS backups."
  type        = number
  default     = 7
}

variable "db_multi_az" {
  description = "Whether to enable Multi-AZ for the RDS instance."
  type        = bool
  default     = false
}

variable "db_deletion_protection" {
  description = "Whether to enable deletion protection on the RDS instance."
  type        = bool
  default     = true
}

variable "db_skip_final_snapshot" {
  description = "Whether to skip the final snapshot when destroying the RDS instance."
  type        = bool
  default     = false
}

variable "apply_immediately" {
  description = "Whether Terraform should apply DB and ECS changes immediately."
  type        = bool
  default     = false
}

variable "embedding_model" {
  description = "Embedding model configured for the app."
  type        = string
  default     = "Xenova/all-MiniLM-L6-v2"
}

variable "embedding_dimensions" {
  description = "Expected embedding dimensions for the configured model."
  type        = number
  default     = 384
}

variable "auth_enabled" {
  description = "Whether HTTP auth is enabled for the service."
  type        = bool
  default     = true
}

variable "sso_provider_type" {
  description = "OIDC provider type used by FastMCP."
  type        = string
  default     = "google_oidc"
}

variable "sso_client_id" {
  description = "OIDC client ID."
  type        = string
  default     = ""
}

variable "sso_client_secret_secret_arn" {
  description = "Secrets Manager ARN holding the OIDC client secret."
  type        = string
}

variable "sso_issuer_url" {
  description = "OIDC issuer URL."
  type        = string
  default     = ""
}

variable "sso_allowed_domains" {
  description = "Allowed email domains for OIDC logins."
  type        = list(string)
  default     = []
}

variable "sso_default_scopes" {
  description = "Default OIDC scopes requested by the server."
  type        = list(string)
  default     = ["openid", "profile", "email"]
}

variable "cookie_secret_secret_arn" {
  description = "Secrets Manager ARN holding COOKIE_SECRET."
  type        = string
}

variable "encryption_key_secret_arn" {
  description = "Secrets Manager ARN holding ENCRYPTION_KEY."
  type        = string
}

variable "control_plane_callback_token_secret_arn" {
  description = "Optional Secrets Manager ARN holding CONTROL_PLANE_CALLBACK_TOKEN."
  type        = string
  default     = null
}

variable "billing_enabled" {
  description = "Whether billing endpoints and entitlement checks are enabled."
  type        = bool
  default     = false
}

variable "billing_plan_name" {
  description = "Plan name surfaced by the billing service."
  type        = string
  default     = "solo"
}

variable "stripe_price_id" {
  description = "Stripe price ID for checkout sessions."
  type        = string
  default     = null
}

variable "stripe_secret_key_secret_arn" {
  description = "Optional Secrets Manager ARN holding STRIPE_SECRET_KEY."
  type        = string
  default     = null
}

variable "stripe_webhook_secret_secret_arn" {
  description = "Optional Secrets Manager ARN holding STRIPE_WEBHOOK_SECRET."
  type        = string
  default     = null
}

variable "allowed_hosts" {
  description = "Optional host allowlist passed to the app."
  type        = list(string)
  default     = []
}

