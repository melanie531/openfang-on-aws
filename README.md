# OpenFang AWS Deployment

Deploy [OpenFang](https://github.com/RightNow-AI/openfang) Agent OS on AWS EC2 with Amazon Bedrock as the LLM provider, using a LiteLLM proxy sidecar for OpenAI-to-Bedrock translation.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  VPC (10.0.0.0/16)                                                  │
│                                                                     │
│  Private Subnet (EC2 t3.xlarge)                                     │
│  ┌──────────────────────────────────┐                               │
│  │  Docker                          │                               │
│  │  ┌────────────┐  ┌────────────┐  │   VPC Endpoint (PrivateLink)  │
│  │  │ OpenFang   │→ │ LiteLLM    │──│──→ bedrock-runtime ──→ Bedrock│
│  │  │ :4200      │  │ Proxy :4000│  │   (never leaves AWS network)  │
│  │  └────────────┘  └────────────┘  │                               │
│  │       │                          │                               │
│  └───────│──────────────────────────┘                               │
│          │  web_search, web_fetch                                   │
│          └──→ NAT Gateway ──→ Internet                              │
│                                                                     │
│  ↑ SSM Session Manager (no SSH, no open ports)                      │
└─────────────────────────────────────────────────────────────────────┘
```

**Traffic routing:**
- **Bedrock API calls** → VPC Interface Endpoint (PrivateLink) — stays within AWS network
- **Web searches, git, Docker Hub** → NAT Gateway → Public internet

**Key components:**
- **OpenFang** — Agent OS with Researcher Hand (autonomous deep research)
- **LiteLLM proxy** — Translates OpenAI-compatible API calls to Bedrock with SigV4 signing
- **Bedrock VPC Endpoint** — PrivateLink with private DNS; Bedrock traffic never traverses the public internet
- **IAM instance profile** — No static AWS credentials; rotating temp creds via IMDS
- **SSM Session Manager** — Zero inbound ports; shell + port forwarding over HTTPS

## Prerequisites

1. **Node.js** >= 18
2. **AWS CDK CLI**: `npm install -g aws-cdk`
3. **AWS credentials** configured (`aws configure` or env vars) with permissions to create VPC, EC2, IAM resources
4. **CDK bootstrapped** in target account/region: `cdk bootstrap aws://ACCOUNT_ID/REGION`
5. **SSM Session Manager plugin** installed on your workstation ([install guide](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html))

## Quick Start

```bash
npm install
```

### Mode 1: Create New VPC (default)

Creates a full VPC with public/private subnets, NAT Gateway, Bedrock Runtime VPC Endpoint, and the OpenFang EC2 instance.

```bash
npx cdk deploy
```

### Mode 2: Use Existing VPC

Reuses an existing VPC (and its NAT Gateway/subnets). Creates EC2 + IAM + Security Groups + Bedrock VPC Endpoint.

```bash
npx cdk deploy -c vpcId=vpc-0123456789abcdef0
```

### Additional Context Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `vpcId` | _(none — creates new)_ | Existing VPC ID to reuse |
| `instanceType` | `t3.xlarge` | EC2 instance type |
| `bedrockRegion` | _(stack region)_ | AWS region for Bedrock model access |

Example with all options:

```bash
npx cdk deploy \
  -c vpcId=vpc-xxx \
  -c instanceType=t3.large \
  -c bedrockRegion=us-east-1
```

## Connecting via SSM Session Manager

After deployment, the stack outputs the instance ID and ready-to-use commands.

### Shell Access

```bash
aws ssm start-session --target i-0123456789abcdef0 --region us-west-2
```

### Port Forward (access OpenFang dashboard locally)

```bash
aws ssm start-session \
  --target i-0123456789abcdef0 \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["4200"],"localPortNumber":["4200"]}' \
  --region us-west-2
```

Then open `http://localhost:4200` in your browser.

## Checking OpenFang Status

Once connected via SSM:

```bash
# Go to deployment directory
cd /opt/openfang

# Check container status
docker compose ps

# View logs
docker compose logs -f

# Check LiteLLM health
curl http://localhost:4000/health

# Get OpenFang API key
cat /opt/openfang/.env

# Check OpenFang API (replace KEY with value from .env)
curl -H "Authorization: Bearer KEY" http://localhost:4200/api/health
```

## Testing the Researcher Hand

```bash
cd /opt/openfang

# Enter the OpenFang container
docker compose exec openfang /bin/sh

# Check available hands
openfang hand list

# Activate Researcher Hand (may already be activated by UserData)
openfang hand activate researcher

# Check status
openfang hand status researcher

# Start an interactive research session
openfang chat researcher
# Try: "What are the latest developments in AI agent frameworks in 2026?"
```

The Researcher Hand will:
1. Detect the platform (Linux) via python3
2. Decompose the question into sub-queries
3. Search the web (DuckDuckGo — zero config)
4. Fetch and analyze web pages
5. Cross-reference findings
6. Produce a structured research report
7. Store results in the knowledge graph

## Tear Down

```bash
npx cdk destroy
```

This removes all AWS resources created by the stack. If you used Mode 1 (new VPC), the VPC and NAT Gateway are also deleted.

## Cost Breakdown

### Fixed Monthly Costs (Mode 1 — New VPC)

| Component | Spec | Monthly Cost |
|-----------|------|-------------|
| EC2 — OpenFang | t3.xlarge on-demand | ~$60 |
| NAT Gateway | Standard | ~$32 |
| NAT Gateway data | ~5 GB estimate | ~$0.25 |
| VPC Endpoint | Bedrock Runtime (PrivateLink) | ~$7.30 |
| EBS | 30 GB gp3, encrypted | ~$2.40 |
| SSM Session Manager | — | Free |
| **Subtotal** | | **~$102/month** |

### Fixed Monthly Costs (Mode 2 — Existing VPC)

| Component | Spec | Monthly Cost |
|-----------|------|-------------|
| EC2 — OpenFang | t3.xlarge on-demand | ~$60 |
| VPC Endpoint | Bedrock Runtime (PrivateLink) | ~$7.30 |
| EBS | 30 GB gp3, encrypted | ~$2.40 |
| SSM Session Manager | — | Free |
| **Subtotal** | | **~$70/month** |

### Bedrock Token Costs (Variable)

| Model | Input / 1M tokens | Output / 1M tokens |
|-------|--------------------|---------------------|
| Claude Sonnet 4.6 | $3.00 | $15.00 |
| Claude Haiku 4.5 | $0.25 | $1.25 |
| Amazon Nova Pro | $0.80 | $3.20 |
| Amazon Nova Lite | $0.06 | $0.24 |

Light testing (~10 research sessions/month with Sonnet 4.6): ~$3/month in Bedrock costs.

### Cost Optimization

- **Scheduled stop/start** (8 hrs/day weekdays): ~67% EC2 savings
- **Reserved Instance** (1 year): ~40% EC2 savings
- **Use Nova Lite** instead of Sonnet: ~95% token savings (lower quality)

## Security

- **Zero inbound ports** — security group has no inbound rules
- **Bedrock via PrivateLink** — API calls route through VPC endpoint, never traverse the public internet
- **SSM Session Manager** — IAM-based access, CloudTrail audit trail
- **No SSH keys** — no key pairs created or used
- **No static AWS credentials** — instance profile with IMDS for Bedrock auth
- **IMDSv2 enforced** — hop limit set to 2 for Docker container access
- **Encrypted EBS** — root volume encrypted at rest
- **Least-privilege IAM** — only `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` for specific models
- **VPC Flow Logs** — all network traffic logged to CloudWatch (30-day retention)
- **OpenFang API key** — auto-generated, required for API access
- **LiteLLM internal only** — bound to localhost, not exposed

## Project Structure

```
openfang-aws-deploy/
├── bin/
│   └── openfang-deploy.ts      # CDK app entry point
├── lib/
│   ├── openfang-stack.ts       # Main stack (VPC + EC2 + IAM + SG + VPC Endpoint)
│   └── user-data.sh            # EC2 UserData bootstrap script
├── cdk.json                    # CDK configuration
├── tsconfig.json               # TypeScript configuration
├── package.json                # Dependencies
├── ARCHITECTURE.md             # Detailed architecture design
├── CONTEXT.md                  # Project context
└── README.md                   # This file
```
