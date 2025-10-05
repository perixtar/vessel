# Vessel

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Vessel lets you run Claude Code CLI in your self-hosting cloud setup.

---

This README walks you through:

1. Building a Docker image
2. Pushing it to Amazon ECR
3. Provisioning AWS infrastructure with Terraform (ECS Fargate + ALB + CloudWatch Logs)
4. Verifying & operating the ECS service

> Assumes `us-west-2` unless you override with `AWS_REGION`.

---

## 0) Prerequisites

- **AWS account/role** with permissions for ECR, ECS, IAM, ELB, CloudWatch Logs, STS.
- **Installed CLIs**: Docker, AWS CLI v2, Terraform.
- **Configured AWS credentials**: `aws configure` (or role via SSO/instance profile).

Verify tool versions and credentials:

```bash
docker --version
terraform --version
aws --version
aws configure
# Prompts:
# AWS Access Key ID [None]: AKIAxxxxxxxxxxxxxxxx
# AWS Secret Access Key [None]: <paste-your-secret-key>
# Default region name [None]: us-west-2
# Default output format [None]: json

# Step-by-step guide to finding or creating your Access Key ID:
# 1. Log in to the AWS Console: with your account or user credentials.
# 2. Click your account name: or profile in the top-right corner of the console.
# 3. Select "Security Credentials": from the drop-down menu.
# 4. Scroll down: to find the "Access Keys" section.
# 5. Click to expand: the "Access Keys (Access Key ID and Secret Access Key)" option to view your existing keys.
```

---

## 1) Set Environment Variables

Create a `.env` file by copying `.env.template` and add your API keys and secrets as needed:

```bash
cp .env.template .env
# Edit .env and fill in your API keys and other required values
```

```bash
export AWS_REGION=us-west-2
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export REPO_NAME=claudeproject
```

> Sanity check any variable with `echo`, e.g. `echo "$ACCOUNT_ID"`.

---

## 2) Create/Login to ECR

Create (idempotently) and login:

```bash
aws ecr create-repository --repository-name $REPO_NAME --region $AWS_REGION 2>/dev/null || true

aws ecr get-login-password --region "$AWS_REGION" \
| docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
```

### Verify ECR repo exists (optional but recommended)

```bash
aws ecr describe-repositories \
  --repository-names "$REPO_NAME" \
  --region "$AWS_REGION" \
  --query 'repositories[0].{Name:repositoryName,URI:repositoryUri,Created:createdAt,ARN:repositoryArn}' \
  --output table
```

---

## 3) Tag & Push the Image to ECR (single-arch, typical x86_64 build)

```bash
docker tag claudeproject:latest "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${REPO_NAME}:latest"
docker images | grep "${REPO_NAME}"
docker push "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${REPO_NAME}:latest"

export TF_IMAGE_URL="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${REPO_NAME}:latest"
```

> If you’re building on an Apple Silicon Mac (M-chip), **prefer the multi-arch path below** to avoid “no matching manifest” / “exec format error” when ECS pulls the image on x86_64 hosts.

---

## 3b) **Apple Silicon (M-chip) — Build & Push a Multi-arch Image (amd64 + arm64)**

This ensures your image can run on both amd64 and arm64 nodes.

```bash
# 1) Ensure buildx is ready
docker buildx create --name multi --use 2>/dev/null || docker buildx use multi
docker buildx inspect --bootstrap

# 2) Build and PUSH a multi-arch image (amd64 + arm64)
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t "${ECR_URI}" \
  --push .

# 3) (Optional) Verify the manifest has both platforms
docker buildx imagetools inspect "${ECR_URI}"

# 4) Kick ECS to pull the new image
aws ecs update-service \
  --cluster claudeproject-cluster \
  --service claudeproject-svc \
  --force-new-deployment \
  --region "${AWS_REGION}"

# 5) Export for Terraform
export TF_IMAGE_URL="${ECR_URI}"
```

> Note: `buildx build --push` pushes directly; you don’t need a separate `docker push`.

---

## 4) Provision Infrastructure with Terraform

```bash
terraform init

terraform plan \
  -var="region=${AWS_REGION}" \
  -var="image_url=${TF_IMAGE_URL}" \
  -var="container_port=8080"

terraform apply -auto-approve \
  -var="region=${AWS_REGION}" \
  -var="image_url=${TF_IMAGE_URL}" \
  -var="container_port=8080"
```

> Your Terraform should create: **ECS cluster**, **task definition** (using `image_url`), **service**, **ALB + listener + target group**, **CloudWatch Log Group**, and required **IAM** roles.

---

## 5) Discover the ALB URL & Test

Prefer Terraform outputs:

```bash
terraform output
# e.g. alb_dns_name = "claudeproject-alb-1234567.us-west-2.elb.amazonaws.com"
```

Or set manually if you already know it:

```bash
export ALB_URL="<url returned from terraform>"
curl -s "http://${ALB_URL}/"
```

```bash
# Test a simple prompt
curl -sS -X POST "$ALB_URL/ask" -H 'Content-Type: application/json' \
  -d '{"prompt":"Say hello from ECS","timeoutMs":50000}' | jq

```

If your app exposes a health endpoint, try `.../health`.

---

## 5b) Verify ECS Service Status (desired vs running)

Check your service counts, deployments, and recent events:

```bash
CLUSTER=claudeproject-cluster
SERVICE=claudeproject-svc
REGION=${AWS_REGION:-us-west-2}

aws ecs describe-services \
  --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
  --query 'services[0].{Desired:desiredCount,Running:runningCount,Pending:pendingCount,Deployments:deployments[*].{Id:id,Desired:desiredCount,Running:runningCount,Status:status},Events:events[0:10].[createdAt,message]}' \
  --output table
```

- **Desired** should match your intended count.
- **Running** should reach **Desired**; **Pending** should fall to `0`.
- **Events** help diagnose image pulls, permissions, health checks, etc.

> If your Terraform exports names, you can do:
> `CLUSTER=$(terraform output -raw ecs_cluster_name)` and `SERVICE=$(terraform output -raw ecs_service_name)`.
> If those outputs don’t exist here, I don’t know—use the hardcoded names above or check the ECS console.

---

## 5c) Start or Restart the ECS Service

Scale from zero or force a new deployment:

```bash
# If desiredCount was 0, set it to 1:
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --desired-count 1 --region "$REGION"

# If it was already 1, kick a new deployment to (re)start tasks:
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --force-new-deployment --region "$REGION"
```

> For `:latest` tags, a **force-new-deployment** ensures tasks pull the latest image.

---

## 6) Console Checks (ECR & ECS)

- **ECR**: Console → _Elastic Container Registry_ → _Repositories_.
  Ensure the **region** matches `AWS_REGION` (e.g., **us-west-2**). If you don’t see the repo in another region like **us-east-2**, switch regions.
- **ECS**: Console → _Elastic Container Service_ → _Clusters_ → your cluster → _Services/Tasks/Events_ for health and logs.

---

## 7) Troubleshooting

- **Wrong region in console** → Switch to _US West (Oregon) – us-west-2_ if that’s your `AWS_REGION`.
- **ECR login fails** → Re-run login; confirm region/account; verify IAM permissions.
- **ALB 5xx / unhealthy targets**

  - App must listen on **`0.0.0.0:8080`**.
  - Health check path/port must match the app.
  - SGs/Subnets must allow ALB → tasks traffic.
  - Check target health and **CloudWatch Logs**.

- **New image not picked up** → Use immutable tags or **force-new-deployment** when using `:latest`.
- **Repo creation quietly failed** (due to `|| true`) → Verify with:

  ```bash
  aws ecr describe-repositories \
    --repository-names "$REPO_NAME" \
    --region "$AWS_REGION" \
    --query 'repositories[0].repositoryUri' \
    --output text
  ```

If anything beyond this is unclear, I don’t know.

---

## 8) Cleanup

Destroy infra:

```bash
terraform destroy -auto-approve \
  -var="region=${AWS_REGION}" \
  -var="image_url=${TF_IMAGE_URL}" \
  -var="container_port=8080"
```

Optionally delete ECR repo (must be empty):

```bash
aws ecr list-images --repository-name "$REPO_NAME" --region "$AWS_REGION"
aws ecr batch-delete-image --repository-name "$REPO_NAME" --region "$AWS_REGION" \
  --image-ids imageTag=latest
aws ecr delete-repository --repository-name "$REPO_NAME" --region "$AWS_REGION"
```

---

## 9) Quick Command Reference

```bash
docker --version
terraform version
aws --version
aws configure

# Local build & run
docker build -t claudeproject:latest .
docker run --rm -p 8080:8080 claudeproject:latest

# Core env
export AWS_REGION=us-west-2
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export REPO_NAME=claudeproject

# ECR setup + login
aws ecr create-repository --repository-name $REPO_NAME --region $AWS_REGION 2>/dev/null || true
aws ecr get-login-password --region "$AWS_REGION" \
| docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

# Single-arch push (typical x86_64 build)
docker tag claudeproject:latest "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${REPO_NAME}:latest"
docker images | grep "${REPO_NAME}"
docker push "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${REPO_NAME}:latest"
export TF_IMAGE_URL="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${REPO_NAME}:latest"

# --- OR (Apple Silicon) Multi-arch push ---
export ECR_URI="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${REPO_NAME}:latest"
docker buildx create --name multi --use 2>/dev/null || docker buildx use multi
docker buildx inspect --bootstrap
docker buildx build --platform linux/amd64,linux/arm64 -t "${ECR_URI}" --push .
docker buildx imagetools inspect "${ECR_URI}" # optional
aws ecs update-service --cluster claudeproject-cluster --service claudeproject-svc --force-new-deployment --region "${AWS_REGION}"
export TF_IMAGE_URL="${ECR_URI}"

# Terraform
terraform init
terraform plan \
  -var="region=${AWS_REGION}" \
  -var="image_url=${TF_IMAGE_URL}" \
  -var="container_port=8080"
terraform apply -auto-approve \
  -var="region=${AWS_REGION}" \
  -var="image_url=${TF_IMAGE_URL}" \
  -var="container_port=8080"

# Verify ECS service
CLUSTER=claudeproject-cluster
SERVICE=claudeproject-svc
REGION=${AWS_REGION:-us-west-2}
aws ecs describe-services \
  --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
  --query 'services[0].{Desired:desiredCount,Running:runningCount,Pending:pendingCount,Deployments:deployments[*].{Id:id,Desired:desiredCount,Running:runningCount,Status:status},Events:events[0:10].[createdAt,message]}' \
  --output table

# Start/restart service
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --desired-count 1 --region "$REGION"
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --force-new-deployment --region "$REGION"

# ALB URL test
export ALB_URL="<url returned from terraform>"
curl -s "http://${ALB_URL}/"
```

---

### Optional Terraform outputs

If you control the Terraform, add:

```hcl
output "alb_dns_name"      { value = aws_lb.main.dns_name }
output "ecs_cluster_name"  { value = aws_ecs_cluster.main.name }
output "ecs_service_name"  { value = aws_ecs_service.main.name }
```

Then you can:

```bash
ALB_URL=$(terraform output -raw alb_dns_name)
CLUSTER=$(terraform output -raw ecs_cluster_name)
SERVICE=$(terraform output -raw ecs_service_name)
```

```

If you want me to also add a short “Why multi-arch matters on Apple Silicon” sidebar with common errors (“no matching manifest”, “exec format error”), I can—otherwise this should be ready to paste. If anything else here is uncertain, I don’t know.

```
