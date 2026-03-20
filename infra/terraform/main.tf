data "aws_availability_zones" "available" {
  state = "available"
}

resource "random_id" "final_snapshot" {
  byte_length = 4
}

locals {
  name_prefix        = "${var.project_name}-${var.environment}"
  availability_zones = slice(data.aws_availability_zones.available.names, 0, 2)
  app_base_url       = var.public_base_url != null ? var.public_base_url : "http://${aws_lb.app.dns_name}"
  resolved_allowed_hosts = length(var.allowed_hosts) > 0 ? var.allowed_hosts : [
    trimsuffix(
      replace(replace(local.app_base_url, "https://", ""), "http://", ""),
      "/"
    )
  ]

  tags = {
    Environment = var.environment
    ManagedBy   = "terraform"
    Project     = var.project_name
  }

  public_subnets = {
    for index, cidr in var.public_subnet_cidrs :
    index => {
      az   = local.availability_zones[index]
      cidr = cidr
    }
  }

  private_db_subnets = {
    for index, cidr in var.private_db_subnet_cidrs :
    index => {
      az   = local.availability_zones[index]
      cidr = cidr
    }
  }

  container_environment = concat(
    [
      { name = "APP_NAME", value = "Horizon Layer" },
      { name = "APP_VERSION", value = var.app_version },
      { name = "SERVER_TRANSPORT", value = "http" },
      { name = "DEV_ROUTES_ENABLED", value = "false" },
      { name = "HOST", value = "0.0.0.0" },
      { name = "PORT", value = tostring(var.container_port) },
      { name = "APP_BASE_URL", value = local.app_base_url },
      { name = "MCP_RESOURCE_PATH", value = "/mcp" },
      { name = "ALLOWED_HOSTS", value = join(",", local.resolved_allowed_hosts) },
      { name = "DB_HOST", value = aws_db_instance.app.address },
      { name = "DB_PORT", value = tostring(aws_db_instance.app.port) },
      { name = "DB_NAME", value = var.db_name },
      { name = "DB_USER", value = var.db_username },
      { name = "DB_SSL_MODE", value = "require" },
      { name = "DB_SSL_REJECT_UNAUTHORIZED", value = "true" },
      { name = "EMBEDDING_MODEL", value = var.embedding_model },
      { name = "EMBEDDING_DIMENSIONS", value = tostring(var.embedding_dimensions) },
      { name = "AUTH_ENABLED", value = tostring(var.auth_enabled) },
      { name = "LOCAL_AUTH_ENABLED", value = "false" },
      { name = "SSO_ENABLED", value = tostring(var.auth_enabled) },
      { name = "SSO_PROVIDER_TYPE", value = var.sso_provider_type },
      { name = "SSO_CLIENT_ID", value = var.sso_client_id },
      { name = "SSO_ISSUER_URL", value = var.sso_issuer_url },
      { name = "SSO_DEFAULT_SCOPES", value = join(",", var.sso_default_scopes) },
      { name = "SSO_ALLOWED_DOMAINS", value = join(",", var.sso_allowed_domains) },
      { name = "SSO_TOKEN_STORAGE_DIR", value = "/app/runtime-state/fastmcp-auth" },
      { name = "BILLING_ENABLED", value = tostring(var.billing_enabled) },
      { name = "BILLING_PLAN_NAME", value = var.billing_plan_name },
      { name = "SECURE_COOKIES", value = "true" },
      { name = "NODE_ENV", value = "production" },
      { name = "XDG_CACHE_HOME", value = "/app/runtime-state/cache" },
      { name = "HF_HOME", value = "/app/runtime-state/hf" }
    ],
    var.stripe_price_id != null ? [{ name = "STRIPE_PRICE_ID", value = var.stripe_price_id }] : []
  )

  container_secrets = concat(
    [
      { name = "DB_PASSWORD", valueFrom = "${aws_db_instance.app.master_user_secret[0].secret_arn}:password::" },
      { name = "COOKIE_SECRET", valueFrom = var.cookie_secret_secret_arn },
      { name = "ENCRYPTION_KEY", valueFrom = var.encryption_key_secret_arn },
      { name = "SSO_CLIENT_SECRET", valueFrom = var.sso_client_secret_secret_arn }
    ],
    var.control_plane_callback_token_secret_arn != null ? [{ name = "CONTROL_PLANE_CALLBACK_TOKEN", valueFrom = var.control_plane_callback_token_secret_arn }] : [],
    var.billing_enabled && var.stripe_secret_key_secret_arn != null ? [{ name = "STRIPE_SECRET_KEY", valueFrom = var.stripe_secret_key_secret_arn }] : [],
    var.billing_enabled && var.stripe_webhook_secret_secret_arn != null ? [{ name = "STRIPE_WEBHOOK_SECRET", valueFrom = var.stripe_webhook_secret_secret_arn }] : []
  )

  secret_policy_arns = compact([
    aws_db_instance.app.master_user_secret[0].secret_arn,
    var.cookie_secret_secret_arn,
    var.encryption_key_secret_arn,
    var.sso_client_secret_secret_arn,
    var.control_plane_callback_token_secret_arn,
    var.billing_enabled ? var.stripe_secret_key_secret_arn : null,
    var.billing_enabled ? var.stripe_webhook_secret_secret_arn : null
  ])
}

resource "aws_vpc" "app" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(local.tags, {
    Name = "${local.name_prefix}-vpc"
  })
}

resource "aws_internet_gateway" "app" {
  vpc_id = aws_vpc.app.id

  tags = merge(local.tags, {
    Name = "${local.name_prefix}-igw"
  })
}

resource "aws_subnet" "public" {
  for_each = local.public_subnets

  availability_zone       = each.value.az
  cidr_block              = each.value.cidr
  map_public_ip_on_launch = true
  vpc_id                  = aws_vpc.app.id

  tags = merge(local.tags, {
    Name = "${local.name_prefix}-public-${each.key + 1}"
    Tier = "public"
  })
}

resource "aws_subnet" "private_db" {
  for_each = local.private_db_subnets

  availability_zone = each.value.az
  cidr_block        = each.value.cidr
  vpc_id            = aws_vpc.app.id

  tags = merge(local.tags, {
    Name = "${local.name_prefix}-db-${each.key + 1}"
    Tier = "private-db"
  })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.app.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.app.id
  }

  tags = merge(local.tags, {
    Name = "${local.name_prefix}-public-rt"
  })
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  route_table_id = aws_route_table.public.id
  subnet_id      = each.value.id
}

resource "aws_security_group" "alb" {
  description = "Public load balancer ingress"
  name        = "${local.name_prefix}-alb"
  vpc_id      = aws_vpc.app.id

  ingress {
    cidr_blocks = var.allowed_ingress_cidrs
    description = "HTTP"
    from_port   = 80
    protocol    = "tcp"
    to_port     = 80
  }

  dynamic "ingress" {
    for_each = var.certificate_arn != null ? [1] : []

    content {
      cidr_blocks = var.allowed_ingress_cidrs
      description = "HTTPS"
      from_port   = 443
      protocol    = "tcp"
      to_port     = 443
    }
  }

  egress {
    cidr_blocks = ["0.0.0.0/0"]
    from_port   = 0
    protocol    = "-1"
    to_port     = 0
  }

  tags = merge(local.tags, {
    Name = "${local.name_prefix}-alb-sg"
  })
}

resource "aws_security_group" "service" {
  description = "Fargate service ingress from the ALB only"
  name        = "${local.name_prefix}-svc"
  vpc_id      = aws_vpc.app.id

  ingress {
    description     = "App traffic from ALB"
    from_port       = var.container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
    to_port         = var.container_port
  }

  egress {
    cidr_blocks = ["0.0.0.0/0"]
    from_port   = 0
    protocol    = "-1"
    to_port     = 0
  }

  tags = merge(local.tags, {
    Name = "${local.name_prefix}-service-sg"
  })
}

resource "aws_security_group" "db" {
  description = "RDS ingress from ECS tasks"
  name        = "${local.name_prefix}-db"
  vpc_id      = aws_vpc.app.id

  ingress {
    description     = "Postgres from ECS"
    from_port       = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
    to_port         = 5432
  }

  egress {
    cidr_blocks = ["0.0.0.0/0"]
    from_port   = 0
    protocol    = "-1"
    to_port     = 0
  }

  tags = merge(local.tags, {
    Name = "${local.name_prefix}-db-sg"
  })
}

resource "aws_security_group" "efs" {
  description = "EFS ingress from ECS tasks"
  name        = "${local.name_prefix}-efs"
  vpc_id      = aws_vpc.app.id

  ingress {
    description     = "NFS from ECS"
    from_port       = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.service.id]
    to_port         = 2049
  }

  egress {
    cidr_blocks = ["0.0.0.0/0"]
    from_port   = 0
    protocol    = "-1"
    to_port     = 0
  }

  tags = merge(local.tags, {
    Name = "${local.name_prefix}-efs-sg"
  })
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.name_prefix}"
  retention_in_days = var.log_retention_days

  tags = local.tags
}

resource "aws_ecr_repository" "app" {
  name                 = local.name_prefix
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = local.tags
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [
      {
        action = {
          type = "expire"
        }
        description = "Keep the most recent 20 images"
        rulePriority = 1
        selection = {
          countNumber = 20
          countType   = "imageCountMoreThan"
          tagStatus   = "any"
        }
      }
    ]
  })
}

resource "aws_efs_file_system" "runtime_state" {
  encrypted        = true
  performance_mode = "generalPurpose"
  throughput_mode  = "bursting"

  tags = merge(local.tags, {
    Name = "${local.name_prefix}-runtime"
  })
}

resource "aws_efs_mount_target" "runtime_state" {
  for_each = aws_subnet.public

  file_system_id  = aws_efs_file_system.runtime_state.id
  subnet_id       = each.value.id
  security_groups = [aws_security_group.efs.id]
}

resource "aws_efs_access_point" "runtime_state" {
  file_system_id = aws_efs_file_system.runtime_state.id

  posix_user {
    gid = 1000
    uid = 1000
  }

  root_directory {
    path = "/runtime-state"

    creation_info {
      owner_gid   = 1000
      owner_uid   = 1000
      permissions = "0775"
    }
  }

  tags = local.tags
}

resource "aws_db_subnet_group" "app" {
  name       = "${local.name_prefix}-db"
  subnet_ids = [for subnet in aws_subnet.private_db : subnet.id]

  tags = merge(local.tags, {
    Name = "${local.name_prefix}-db-subnets"
  })
}

resource "aws_db_instance" "app" {
  allocated_storage               = var.db_allocated_storage
  apply_immediately               = var.apply_immediately
  auto_minor_version_upgrade      = true
  backup_retention_period         = var.db_backup_retention_period
  copy_tags_to_snapshot           = true
  db_name                         = var.db_name
  db_subnet_group_name            = aws_db_subnet_group.app.name
  deletion_protection             = var.db_deletion_protection
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  engine                          = "postgres"
  engine_version                  = var.db_engine_version
  identifier                      = local.name_prefix
  instance_class                  = var.db_instance_class
  manage_master_user_password     = true
  max_allocated_storage           = var.db_max_allocated_storage
  multi_az                        = var.db_multi_az
  performance_insights_enabled    = true
  publicly_accessible             = false
  skip_final_snapshot             = var.db_skip_final_snapshot
  storage_encrypted               = true
  storage_type                    = "gp3"
  username                        = var.db_username
  vpc_security_group_ids          = [aws_security_group.db.id]

  final_snapshot_identifier = var.db_skip_final_snapshot ? null : "${local.name_prefix}-final-${random_id.final_snapshot.hex}"

  tags = local.tags
}

data "aws_iam_policy_document" "ecs_task_execution_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      identifiers = ["ecs-tasks.amazonaws.com"]
      type        = "Service"
    }
  }
}

resource "aws_iam_role" "ecs_task_execution" {
  assume_role_policy = data.aws_iam_policy_document.ecs_task_execution_assume_role.json
  name               = "${local.name_prefix}-ecs-execution"

  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution" {
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
  role       = aws_iam_role.ecs_task_execution.name
}

data "aws_iam_policy_document" "ecs_task_execution_secrets" {
  statement {
    actions = [
      "secretsmanager:GetSecretValue"
    ]
    resources = local.secret_policy_arns
  }

  statement {
    actions   = ["kms:Decrypt"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "ecs_task_execution_secrets" {
  name   = "${local.name_prefix}-ecs-secrets"
  policy = data.aws_iam_policy_document.ecs_task_execution_secrets.json
  role   = aws_iam_role.ecs_task_execution.id
}

resource "aws_ecs_cluster" "app" {
  name = local.name_prefix

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = local.tags
}

resource "aws_lb" "app" {
  idle_timeout       = 60
  internal           = false
  load_balancer_type = "application"
  name               = substr(local.name_prefix, 0, 32)
  security_groups    = [aws_security_group.alb.id]
  subnets            = [for subnet in aws_subnet.public : subnet.id]

  tags = local.tags
}

resource "aws_lb_target_group" "app" {
  deregistration_delay = 30
  name                 = substr("${local.name_prefix}-tg", 0, 32)
  port                 = var.container_port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.app.id

  health_check {
    healthy_threshold   = 2
    interval            = 30
    matcher             = "200-399"
    path                = var.health_check_path
    protocol            = "HTTP"
    timeout             = 5
    unhealthy_threshold = 5
  }

  tags = local.tags
}

resource "aws_lb_listener" "http_forward" {
  count = var.certificate_arn == null ? 1 : 0

  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    target_group_arn = aws_lb_target_group.app.arn
    type             = "forward"
  }
}

resource "aws_lb_listener" "http_redirect" {
  count = var.certificate_arn != null ? 1 : 0

  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  count = var.certificate_arn != null ? 1 : 0

  certificate_arn   = var.certificate_arn
  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"

  default_action {
    target_group_arn = aws_lb_target_group.app.arn
    type             = "forward"
  }
}

resource "aws_ecs_task_definition" "app" {
  cpu                      = tostring(var.ecs_cpu)
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  family                   = local.name_prefix
  memory                   = tostring(var.ecs_memory)
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]

  container_definitions = jsonencode([
    {
      essential = true
      image     = "${aws_ecr_repository.app.repository_url}:${var.app_image_tag}"
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.app.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "app"
        }
      }
      mountPoints = [
        {
          containerPath = "/app/runtime-state"
          readOnly      = false
          sourceVolume  = "runtime-state"
        }
      ]
      name = "app"
      portMappings = [
        {
          containerPort = var.container_port
          hostPort      = var.container_port
          protocol      = "tcp"
        }
      ]
      environment = local.container_environment
      secrets     = local.container_secrets
    }
  ])

  volume {
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.runtime_state.id
      root_directory     = "/"
      transit_encryption = "ENABLED"

      authorization_config {
        access_point_id = aws_efs_access_point.runtime_state.id
        iam             = "DISABLED"
      }
    }

    name = "runtime-state"
  }

  tags = local.tags
}

resource "aws_ecs_service" "app" {
  cluster                            = aws_ecs_cluster.app.id
  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 50
  desired_count                      = var.desired_count
  enable_execute_command             = true
  force_new_deployment               = true
  launch_type                        = "FARGATE"
  name                               = local.name_prefix
  platform_version                   = "LATEST"
  task_definition                    = aws_ecs_task_definition.app.arn
  wait_for_steady_state              = false

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  load_balancer {
    container_name   = "app"
    container_port   = var.container_port
    target_group_arn = aws_lb_target_group.app.arn
  }

  network_configuration {
    assign_public_ip = true
    security_groups  = [aws_security_group.service.id]
    subnets          = [for subnet in aws_subnet.public : subnet.id]
  }

  depends_on = [
    aws_lb_listener.http_forward,
    aws_lb_listener.http_redirect,
    aws_lb_listener.https
  ]

  tags = local.tags
}
