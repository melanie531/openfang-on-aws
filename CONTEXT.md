# OpenFang AWS Deployment — Context for Claude Code

## What is OpenFang?
- Open-source Agent OS built in Rust (137K LOC, 14 crates, v0.3.29)
- Repo cloned at: `/tmp/openfang-research/`
- Single binary (~32MB), Dockerfile available
- Exposes HTTP API on port 4200 (default: localhost only)
- Has built-in Bedrock support for model providers

## Goal
Deploy OpenFang on AWS EC2 with enterprise-grade security, then test the **Researcher Hand** (autonomous deep research agent).

## Key Source Files to Study
- `/tmp/openfang-research/Dockerfile` — Docker build (Rust builder → Debian slim runtime)
- `/tmp/openfang-research/docker-compose.yml` — Docker Compose config
- `/tmp/openfang-research/openfang.toml.example` — Full config reference
- `/tmp/openfang-research/deploy/openfang.service` — Systemd unit file
- `/tmp/openfang-research/crates/openfang-hands/bundled/researcher/HAND.toml` — Researcher Hand config
- `/tmp/openfang-research/crates/openfang-runtime/src/model_catalog.rs` — Bedrock model support
- `/tmp/openfang-research/SECURITY.md` — Security architecture
- `/tmp/openfang-research/scripts/install.sh` — Install script (Linux/macOS)
- `/tmp/openfang-research/README.md` — Full docs

## Deployment Requirements
1. **VPC**: Isolated VPC with public + private subnets
2. **EC2**: t3.medium or larger in private subnet (no public IP)
3. **NAT Gateway**: For outbound internet (Bedrock API calls, web_search, web_fetch)
4. **VPN / Bastion**: Secure access — either AWS Client VPN, SSM Session Manager, or bastion host
5. **IAM**: Instance profile with Bedrock invoke permissions (bedrock:InvokeModel, bedrock:InvokeModelWithResponseStream)
6. **Security Groups**: Minimal — no inbound from internet, only from VPN/bastion
7. **OpenFang Config**: Use Bedrock as model provider (not Anthropic API key)
8. **Researcher Hand**: Must be activated and testable

## Bedrock Integration
OpenFang natively supports Bedrock. Config:
```toml
[default_model]
provider = "bedrock"
model = "bedrock/anthropic.claude-sonnet-4-6"
api_key_env = "AWS_ACCESS_KEY_ID"  # IAM role via instance profile
```
- Region: us-west-2 (same as our OpenClaw)
- Auth: Instance profile (IAM role) — no API keys needed

## Deliverable
A CDK (TypeScript) project that deploys:
- VPC + subnets + NAT Gateway + route tables
- EC2 instance with OpenFang pre-installed
- IAM role with Bedrock permissions
- Security Groups (locked down)
- SSM Session Manager for access
- UserData script that: installs Docker, pulls/builds OpenFang, configures for Bedrock, activates Researcher Hand

## CRITICAL: Two Deployment Modes
The CDK project MUST support both modes via context/parameters:

### Mode 1: Create New Infrastructure
- Creates new VPC, subnets, NAT Gateway, route tables — everything from scratch
- For fresh AWS accounts or isolated deployments

### Mode 2: Use Existing Infrastructure
- Accepts existing VPC ID, private subnet IDs, security group IDs as parameters
- Reuses existing NAT Gateway (already in the VPC)
- Only creates: EC2 instance, IAM role, OpenFang-specific security group, UserData
- For accounts that already have networking infra set up

Implementation: Use CDK context variables or stack props:
```typescript
// Example:
const existingVpcId = this.node.tryGetContext('vpcId'); // optional
if (existingVpcId) {
  vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: existingVpcId });
} else {
  vpc = new ec2.Vpc(this, 'Vpc', { ... }); // create new
}
```

## Cost Notes
- NAT Gateway: ~$0.045/hr + data transfer (use NAT Gateway, not NAT instance — more professional/standard)
- EC2 t3.medium: ~$0.042/hr
- Bedrock: pay per token
