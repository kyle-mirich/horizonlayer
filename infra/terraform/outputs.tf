output "alb_dns_name" {
  description = "Public DNS name of the application load balancer."
  value       = aws_lb.app.dns_name
}

output "app_base_url" {
  description = "Base URL configured into the ECS task."
  value       = local.app_base_url
}

output "ecr_repository_url" {
  description = "ECR repository URL for the application image."
  value       = aws_ecr_repository.app.repository_url
}

output "ecs_cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.app.name
}

output "ecs_service_name" {
  description = "ECS service name."
  value       = aws_ecs_service.app.name
}

output "rds_endpoint" {
  description = "PostgreSQL endpoint for the RDS instance."
  value       = aws_db_instance.app.address
}

output "rds_master_secret_arn" {
  description = "Secrets Manager ARN for the RDS-managed master credentials."
  value       = aws_db_instance.app.master_user_secret[0].secret_arn
}

output "runtime_state_efs_id" {
  description = "EFS file system ID used for FastMCP auth state and model cache persistence."
  value       = aws_efs_file_system.runtime_state.id
}

