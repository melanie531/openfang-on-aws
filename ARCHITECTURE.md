# OpenFang AWS Deployment — Architecture Design Document

**Version:** 1.0
**Date:** 2026-03-09
**Status:** Phase 1 — Architecture Research & Design
**Target:** Dev/Test Environment

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Source Code Analysis Findings](#2-source-code-analysis-findings)
3. [AWS Architecture Overview](#3-aws-architecture-overview)
4. [VPC Design](#4-vpc-design)
5. [EC2 Instance Specification](#5-ec2-instance-specification)
6. [IAM Role & Policy](#6-iam-role--policy)
7. [Security Groups](#7-security-groups)
8. [SSM Session Manager Setup](#8-ssm-session-manager-setup)
9. [NAT Gateway vs NAT Instance](#9-nat-gateway-vs-nat-instance)
10. [Bedrock Integration via LiteLLM Proxy](#10-bedrock-integration-via-litellm-proxy)
11. [OpenFang Configuration](#11-openfang-configuration)
12. [Researcher Hand Activation](#12-researcher-hand-activation)
13. [UserData Script Outline](#13-userdata-script-outline)
14. [Cost Estimate](#14-cost-estimate)
15. [CDK vs CloudFormation Recommendation](#15-cdk-vs-cloudformation-recommendation)
16. [Deployment Verification Checklist](#16-deployment-verification-checklist)

---

## 1. Executive Summary

This document describes the architecture for deploying OpenFang Agent OS (v0.1.0, Rust, ~32MB binary) on AWS EC2 with Bedrock as the LLM provider. The deployment targets a dev/test environment with enterprise-grade security principles.

**Key architectural decisions:**

- **Docker-based deployment** on EC2 (simpler than bare-metal, matches upstream Dockerfile)
- **LiteLLM proxy sidecar** to bridge OpenFang's OpenAI-compatible driver to Bedrock's SigV4 API (see [Section 10](#10-bedrock-integration-via-litellm-proxy) for why this is needed)
- **Private subnet** with NAT instance (not NAT Gateway) for cost savings
- **SSM Session Manager** for secure access (no SSH keys, no bastion host, no open ports)
- **Instance profile** for Bedrock auth (no static AWS credentials)
- **DuckDuckGo** as zero-config web search provider for Researcher Hand

**Estimated monthly cost: ~$45–55** (excluding Bedrock token usage).

---

## 2. Source Code Analysis Findings

### 2.1 Build & Runtime Requirements

**Source:** `Dockerfile`, `docker-compose.yml`, `deploy/openfang.service`

| Aspect | Detail |
|--------|--------|
| **Build toolchain** | Rust (via `rust:1-slim-bookworm`), pkg-config, libssl-dev |
| **Build command** | `cargo build --release --bin openfang` |
| **Binary size** | ~32MB single binary |
| **Runtime base** | `debian:bookworm-slim` + `ca-certificates` |
| **Runtime deps** | ca-certificates (TLS), SQLite (embedded in binary) |
| **Data volume** | `/data` (OPENFANG_HOME) — SQLite DB, agent state, research logs |
| **Default port** | 4200 (HTTP API + dashboard), bound to `127.0.0.1` by default |
| **Memory** | ~40MB idle, 200-500MB under load with research tasks |

Docker is the simpler deployment path. The upstream Dockerfile uses a multi-stage build (Rust builder → Debian slim runtime). Building from source takes significant time and memory (~4GB+ for Rust compilation). Using Docker avoids installing the Rust toolchain on the EC2 instance.

### 2.2 Bedrock Integration — Critical Finding

**Source:** `crates/openfang-runtime/src/drivers/mod.rs`, `crates/openfang-types/src/model_catalog.rs`

**Bedrock does NOT have a native driver in OpenFang.** The model catalog registers 8 Bedrock models and defines `BEDROCK_BASE_URL`, but:

1. `provider_defaults("bedrock")` returns `None` (not in the match statement — `drivers/mod.rs:36-209`)
2. `create_driver()` has no special case for "bedrock" (unlike anthropic, gemini, codex — `drivers/mod.rs:235-363`)
3. The fallback path requires `base_url` to be explicitly set, and would use the OpenAI-compatible driver
4. **Bedrock's API uses AWS SigV4 signing**, not Bearer token auth — the OpenAI driver cannot authenticate directly

**Implication:** We need a **proxy** that translates OpenAI-compatible API calls → Bedrock API calls with SigV4 signing. LiteLLM is the standard solution (see [Section 10](#10-bedrock-integration-via-litellm-proxy)).

**Bedrock models available in catalog:**
- `bedrock/anthropic.claude-opus-4-6` (Frontier, 200K context)
- `bedrock/anthropic.claude-sonnet-4-6` (Smart, 200K context) ← recommended
- `bedrock/anthropic.claude-haiku-4-5-20251001` (Fast, 200K context)
- `bedrock/amazon.nova-pro-v1:0` (Smart, 300K context)
- `bedrock/amazon.nova-lite-v1:0` (Fast, 300K context)
- `bedrock/meta.llama3-3-70b-instruct-v1:0` (Balanced, 128K context)

### 2.3 Researcher Hand Requirements

**Source:** `crates/openfang-hands/bundled/researcher/HAND.toml`

The Researcher Hand uses these tools:
- `shell_exec` — native subprocess, no external deps (uses `/bin/sh`)
- `file_read`, `file_write`, `file_list` — native async filesystem ops
- `web_fetch` — native HTTP client (reqwest), built-in SSRF protection
- `web_search` — multi-provider with auto-fallback
- `memory_store`, `memory_recall` — SQLite-backed
- `knowledge_add_entity`, `knowledge_add_relation`, `knowledge_query` — knowledge graph
- `schedule_create`, `schedule_list`, `schedule_delete` — scheduler
- `event_publish` — event bus

**Web search providers** (`crates/openfang-runtime/src/web_search.rs`):
1. **Tavily** — requires `TAVILY_API_KEY`
2. **Brave** — requires `BRAVE_API_KEY`
3. **Perplexity** — requires `PERPLEXITY_API_KEY`
4. **DuckDuckGo** — **no API key needed** (HTML scraping fallback)

Auto-fallback priority: Tavily → Brave → Perplexity → DuckDuckGo. For zero-config deployment, DuckDuckGo works out of the box.

**No Python or Playwright required.** OpenFang's tools are native Rust. The `shell_exec` tool uses the system shell (`/bin/sh`), and the browser automation (Browser Hand) uses Chrome DevTools Protocol directly — but the Researcher Hand does not use browser tools.

### 2.4 Security Architecture

**Source:** `SECURITY.md`, `deploy/openfang.service`

OpenFang has 16 security layers. Key ones relevant to deployment:

| Security Feature | Deployment Impact |
|-----------------|-------------------|
| **API authentication** | Bearer token with loopback bypass for localhost — configure `api_key` in config |
| **SSRF protection** | Blocks private IPs, cloud metadata (169.254.169.254) — safe for VPC deployment |
| **Path traversal prevention** | `safe_resolve_path()` on all file ops — constrained to workspace |
| **Subprocess sandbox** | `env_clear()` + selective passthrough — shell commands are isolated |
| **Secret zeroization** | `Zeroizing<String>` on API keys — auto-wiped from memory |
| **Rate limiting** | GCRA per-IP — protects the API endpoint |
| **WASM sandbox** | Dual-metered (fuel + epoch) for tool code — prevents runaway execution |
| **Systemd hardening** | `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp` |

The systemd service file shows the expected security profile:
- Runs as dedicated `openfang` user/group
- `ReadWritePaths=/var/lib/openfang` only
- `LimitNOFILE=65536`, `LimitNPROC=4096`
- No new privileges, kernel protection enabled

---

## 3. AWS Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        AWS Region: us-west-2                        │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    VPC: 10.0.0.0/16                           │  │
│  │                                                               │  │
│  │  ┌─────────────────────────┐  ┌────────────────────────────┐  │  │
│  │  │  Public Subnet          │  │  Private Subnet             │  │  │
│  │  │  10.0.1.0/24 (AZ-a)    │  │  10.0.10.0/24 (AZ-a)       │  │  │
│  │  │                         │  │                              │  │  │
│  │  │  ┌──────────────────┐   │  │  ┌────────────────────────┐ │  │  │
│  │  │  │  NAT Instance    │   │  │  │  EC2: OpenFang         │ │  │  │
│  │  │  │  (t3.micro)      │   │  │  │  (t3.medium)           │ │  │  │
│  │  │  │  EIP attached    │◄──┼──┼──│                        │ │  │  │
│  │  │  └──────────────────┘   │  │  │  ┌──────────────────┐  │ │  │  │
│  │  │          │              │  │  │  │ Docker           │  │ │  │  │
│  │  │          │              │  │  │  │                  │  │ │  │  │
│  │  │          ▼              │  │  │  │ ┌──────────────┐ │  │ │  │  │
│  │  │  ┌──────────────────┐   │  │  │  │ │ OpenFang     │ │  │ │  │  │
│  │  │  │  Internet GW     │   │  │  │  │ │ :4200        │ │  │ │  │  │
│  │  │  │  (IGW)           │   │  │  │  │ └──────────────┘ │  │ │  │  │
│  │  │  └──────────────────┘   │  │  │  │ ┌──────────────┐ │  │ │  │  │
│  │  │          │              │  │  │  │ │ LiteLLM      │ │  │ │  │  │
│  │  │          ▼              │  │  │  │ │ Proxy :4000  │ │  │ │  │  │
│  │  │     Internet            │  │  │  │ └──────────────┘ │  │ │  │  │
│  │  │                         │  │  │  └──────────────────┘  │ │  │  │
│  │  └─────────────────────────┘  │  │                        │ │  │  │
│  │                               │  │  IAM Instance Profile  │ │  │  │
│  │                               │  │  → Bedrock InvokeModel │ │  │  │
│  │                               │  │  → SSM Managed         │ │  │  │
│  │                               │  └────────────────────────┘ │  │  │
│  │                               └────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ SSM Endpoint │  │ Bedrock      │  │ VPC Endpoints (optional) │  │
│  │ (for access) │  │ Runtime API  │  │ ssm, ssmmessages, ec2msg │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘

Data Flow:
  User → SSM Session Manager → Port Forward → localhost:4200 → OpenFang
  OpenFang → LiteLLM (:4000) → NAT → Bedrock Runtime API (us-west-2)
  OpenFang → NAT → Internet (web_search, web_fetch for Researcher Hand)
```

---

## 4. VPC Design

### 4.1 CIDR Allocation

| Resource | CIDR | Purpose |
|----------|------|---------|
| **VPC** | `10.0.0.0/16` | 65,536 IPs — room for future expansion |
| **Public Subnet** | `10.0.1.0/24` | NAT instance, 256 IPs, AZ us-west-2a |
| **Private Subnet** | `10.0.10.0/24` | EC2 instance, 256 IPs, AZ us-west-2a |

Single-AZ is acceptable for dev/test. For production, add a second AZ.

### 4.2 Route Tables

**Public Subnet Route Table:**

| Destination | Target | Notes |
|-------------|--------|-------|
| `10.0.0.0/16` | local | VPC internal |
| `0.0.0.0/0` | igw-xxx | Internet Gateway |

**Private Subnet Route Table:**

| Destination | Target | Notes |
|-------------|--------|-------|
| `10.0.0.0/16` | local | VPC internal |
| `0.0.0.0/0` | eni-xxx (NAT instance) | Outbound via NAT |

### 4.3 VPC Endpoints (Optional — Cost Optimization)

For reducing NAT traffic costs, consider VPC Interface Endpoints:

| Endpoint | Service | Benefit |
|----------|---------|---------|
| `com.amazonaws.us-west-2.ssm` | SSM | Free SSM access without NAT |
| `com.amazonaws.us-west-2.ssmmessages` | SSM Messages | Required for Session Manager |
| `com.amazonaws.us-west-2.ec2messages` | EC2 Messages | Required for SSM |
| `com.amazonaws.us-west-2.bedrock-runtime` | Bedrock | Bedrock calls without NAT |

**Note:** VPC Interface Endpoints cost ~$7.30/month each. For dev/test, using NAT for everything is simpler and cheaper than 4 endpoints ($29.20/month). Add endpoints for production.

---

## 5. EC2 Instance Specification

### 5.1 Instance Type

| Spec | Value | Rationale |
|------|-------|-----------|
| **Type** | `t3.medium` | 2 vCPU, 4GB RAM — sufficient for OpenFang + LiteLLM |
| **Architecture** | x86_64 | Matches upstream Docker image (Rust builder is x86) |
| **AMI** | Amazon Linux 2023 (al2023-ami-2023.x) | Docker support, SSM agent pre-installed |
| **EBS** | 30GB gp3 (3000 IOPS, 125 MB/s) | OS + Docker images + OpenFang data |
| **Placement** | Private subnet, no public IP | Security requirement |
| **Key Pair** | None | SSM Session Manager, no SSH needed |

### 5.2 Why t3.medium

- OpenFang idle: ~40MB RAM
- OpenFang under load (research): ~200-500MB RAM
- LiteLLM proxy: ~100-200MB RAM
- Docker overhead: ~200MB
- OS + buffers: ~1GB
- **Total estimated: ~2GB peak** — fits in 4GB with headroom

t3.micro (1GB) is too small. t3.small (2GB) is tight. t3.medium (4GB) gives comfortable margin.

### 5.3 NAT Instance Specification

| Spec | Value |
|------|-------|
| **Type** | `t3.micro` (1 vCPU, 1GB RAM) |
| **AMI** | Amazon Linux 2023 with NAT configuration |
| **EBS** | 8GB gp3 |
| **Placement** | Public subnet with Elastic IP |
| **Source/Dest Check** | Disabled (required for NAT) |

---

## 6. IAM Role & Policy

### 6.1 EC2 Instance Role: `openfang-ec2-role`

**Trust Policy:**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "ec2.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

### 6.2 Inline Policy: `openfang-bedrock-policy`

Follows least-privilege. Only allows invoking specific Bedrock models in us-west-2.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockInvokeModels",
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": [
        "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-6-v1",
        "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
        "arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-pro-v1:0",
        "arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-lite-v1:0"
      ]
    }
  ]
}
```

### 6.3 Managed Policy Attachments

| Policy ARN | Purpose |
|------------|---------|
| `arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore` | SSM Session Manager access |

**No other managed policies.** No S3, no CloudWatch Logs (unless explicitly needed later).

### 6.4 NAT Instance Role: `openfang-nat-role`

Minimal — only SSM for management.

```json
{
  "Version": "2012-10-17",
  "Statement": []
}
```

Attach: `AmazonSSMManagedInstanceCore` only.

---

## 7. Security Groups

### 7.1 OpenFang EC2 Security Group: `openfang-ec2-sg`

**Inbound Rules:**

| Rule # | Type | Protocol | Port | Source | Description |
|--------|------|----------|------|--------|-------------|
| — | — | — | — | — | **No inbound rules** |

SSM Session Manager does not require any inbound security group rules. It uses an outbound HTTPS connection to the SSM service.

**Outbound Rules:**

| Rule # | Type | Protocol | Port | Destination | Description |
|--------|------|----------|------|-------------|-------------|
| 1 | HTTPS | TCP | 443 | `0.0.0.0/0` | Bedrock API, web_search, web_fetch (HTTPS), SSM |
| 2 | HTTP | TCP | 80 | `0.0.0.0/0` | web_fetch (some sites are HTTP-only) |
| 3 | DNS | UDP | 53 | `0.0.0.0/0` | DNS resolution |
| 4 | DNS | TCP | 53 | `0.0.0.0/0` | DNS resolution (TCP fallback) |

### 7.2 NAT Instance Security Group: `openfang-nat-sg`

**Inbound Rules:**

| Rule # | Type | Protocol | Port | Source | Description |
|--------|------|----------|------|--------|-------------|
| 1 | HTTPS | TCP | 443 | `10.0.10.0/24` | From private subnet |
| 2 | HTTP | TCP | 80 | `10.0.10.0/24` | From private subnet |
| 3 | DNS | UDP | 53 | `10.0.10.0/24` | DNS from private subnet |
| 4 | DNS | TCP | 53 | `10.0.10.0/24` | DNS from private subnet (TCP fallback) |

**Outbound Rules:**

| Rule # | Type | Protocol | Port | Destination | Description |
|--------|------|----------|------|-------------|-------------|
| 1 | HTTPS | TCP | 443 | `0.0.0.0/0` | Forward HTTPS to internet |
| 2 | HTTP | TCP | 80 | `0.0.0.0/0` | Forward HTTP to internet |
| 3 | DNS | UDP | 53 | `0.0.0.0/0` | DNS resolution |
| 4 | DNS | TCP | 53 | `0.0.0.0/0` | DNS resolution (TCP fallback) |

---

## 8. SSM Session Manager Setup

### 8.1 Why SSM Over SSH/Bastion

| Aspect | SSM Session Manager | SSH Bastion |
|--------|-------------------|-------------|
| **Open ports** | Zero | Port 22 |
| **Key management** | IAM-based | SSH key pairs |
| **Audit trail** | CloudTrail + S3 logging | Manual |
| **Port forwarding** | Built-in | Manual SSH tunnel |
| **Cost** | Free (SSM agent) | EC2 instance cost |
| **Setup** | IAM policy only | SG + key pair + instance |

### 8.2 Prerequisites

1. EC2 instance has `AmazonSSMManagedInstanceCore` policy
2. Amazon Linux 2023 has SSM agent pre-installed
3. Instance has outbound HTTPS (443) to SSM endpoints
4. Operator's workstation has AWS CLI v2 + Session Manager plugin

### 8.3 Access Commands

```bash
# Shell access to OpenFang instance
aws ssm start-session --target i-0123456789abcdef0 --region us-west-2

# Port forward to access OpenFang dashboard locally
aws ssm start-session \
  --target i-0123456789abcdef0 \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["4200"],"localPortNumber":["4200"]}' \
  --region us-west-2

# Then open: http://localhost:4200 in your browser
```

### 8.4 IAM Policy for Operators

Operators need this IAM policy to use Session Manager:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SSMStartSession",
      "Effect": "Allow",
      "Action": [
        "ssm:StartSession",
        "ssm:TerminateSession",
        "ssm:ResumeSession"
      ],
      "Resource": [
        "arn:aws:ec2:us-west-2:ACCOUNT_ID:instance/*",
        "arn:aws:ssm:us-west-2:ACCOUNT_ID:document/AWS-StartPortForwardingSession"
      ],
      "Condition": {
        "StringEquals": {
          "ssm:resourceTag/Project": "openfang"
        }
      }
    },
    {
      "Sid": "SSMDescribe",
      "Effect": "Allow",
      "Action": [
        "ssm:DescribeSessions",
        "ssm:GetConnectionStatus",
        "ssm:DescribeInstanceInformation",
        "ec2:DescribeInstances"
      ],
      "Resource": "*"
    }
  ]
}
```

---

## 9. NAT Gateway vs NAT Instance

### 9.1 Cost Comparison

| Component | NAT Gateway | NAT Instance (t3.micro) |
|-----------|-------------|------------------------|
| **Hourly cost** | $0.045/hr | $0.0104/hr |
| **Monthly cost** | ~$32.40 | ~$7.49 |
| **Data processing** | $0.045/GB | $0 (standard EC2 network) |
| **Data transfer** | Standard rates | Standard rates |
| **Availability** | Managed, HA in AZ | Self-managed, single instance |
| **Bandwidth** | Up to 100 Gbps | Instance-limited (~5 Gbps burst) |
| **Maintenance** | Zero | Patching, monitoring |

### 9.2 Decision: NAT Instance

For dev/test, NAT instance saves ~$25/month. The reduced bandwidth and self-management overhead are acceptable for a single-user test environment.

**NAT instance setup requirements:**
1. Amazon Linux 2023 in public subnet
2. Elastic IP attached
3. Source/Destination Check disabled
4. iptables masquerade configured (in UserData)
5. IP forwarding enabled (`net.ipv4.ip_forward = 1`)

For production, switch to NAT Gateway for high availability and managed operations.

---

## 10. Bedrock Integration via LiteLLM Proxy

### 10.1 Why a Proxy Is Needed

As documented in [Section 2.2](#22-bedrock-integration--critical-finding), OpenFang's `"bedrock"` provider has **no native driver**. The code path:

1. `create_driver("bedrock", config)` → not a special-case provider
2. `provider_defaults("bedrock")` → returns `None`
3. Falls through to custom provider path → requires `base_url`
4. Creates `OpenAIDriver` pointing at `base_url`

The OpenAI driver sends standard `Authorization: Bearer <token>` requests. Bedrock requires AWS SigV4 signing. These are incompatible.

**Solution:** Run LiteLLM as a local proxy that:
- Accepts OpenAI-compatible API calls from OpenFang
- Translates them to Bedrock API calls with SigV4 signing
- Uses the EC2 instance profile for AWS credentials (no static keys)

### 10.2 LiteLLM Configuration

**Docker Compose addition** (`litellm_config.yaml`):

```yaml
model_list:
  - model_name: "bedrock/anthropic.claude-sonnet-4-6"
    litellm_params:
      model: "bedrock/anthropic.claude-sonnet-4-6-v1"
      aws_region_name: "us-west-2"
  - model_name: "bedrock/anthropic.claude-haiku-4-5-20251001"
    litellm_params:
      model: "bedrock/anthropic.claude-haiku-4-5-20251001-v1:0"
      aws_region_name: "us-west-2"
  - model_name: "bedrock/amazon.nova-pro-v1:0"
    litellm_params:
      model: "bedrock/amazon.nova-pro-v1:0"
      aws_region_name: "us-west-2"

general_settings:
  master_key: "sk-litellm-openfang-internal"  # Internal only, not exposed
```

### 10.3 How Auth Flows

```
OpenFang (OpenAI driver)
    │ POST /v1/chat/completions
    │ Authorization: Bearer sk-litellm-openfang-internal
    ▼
LiteLLM Proxy (:4000)
    │ Reads instance profile via IMDS (169.254.169.254)
    │ Signs request with SigV4 (boto3 credential chain)
    │ POST /model/anthropic.claude-sonnet-4-6-v1/invoke
    ▼
Bedrock Runtime API (bedrock-runtime.us-west-2.amazonaws.com)
    │ Validates SigV4 signature against IAM role
    │ Invokes model
    ▼
Response flows back through the chain
```

No static AWS credentials anywhere. The EC2 instance profile provides rotating temporary credentials via IMDS.

### 10.4 Alternative: Direct Anthropic API

If the Bedrock proxy adds unwanted complexity, an alternative is using the Anthropic API directly:

```toml
[default_model]
provider = "anthropic"
model = "claude-sonnet-4-20250514"
api_key_env = "ANTHROPIC_API_KEY"
```

This requires storing an Anthropic API key in AWS Secrets Manager or SSM Parameter Store and injecting it as an environment variable. It bypasses Bedrock entirely but loses the instance-profile-based auth advantage.

**Recommendation:** Use LiteLLM for Bedrock. The proxy adds ~100MB RAM overhead but provides clean IAM-based auth with no secret management.

---

## 11. OpenFang Configuration

### 11.1 openfang.toml

```toml
# /data/config.toml (inside the container, mapped from host)

# API authentication — required since we're exposing the API
api_key = "REPLACE_WITH_GENERATED_TOKEN"
api_listen = "0.0.0.0:4200"     # Listen on all interfaces (within Docker network)

[default_model]
provider = "bedrock"
model = "bedrock/anthropic.claude-sonnet-4-6"
base_url = "http://litellm:4000/v1"   # LiteLLM proxy (Docker service name)
api_key_env = "LITELLM_API_KEY"        # Internal key for LiteLLM

[memory]
decay_rate = 0.05
# sqlite_path = default (/data/openfang.db)

[network]
listen_addr = "0.0.0.0:4200"    # OFP listen address

# Web search — DuckDuckGo by default (zero config)
# Optionally set BRAVE_API_KEY or TAVILY_API_KEY for better results
# [web]
# search_provider = "duckduckgo"
```

### 11.2 Docker Compose (Production)

```yaml
version: "3.8"
services:
  openfang:
    build: /opt/openfang/source
    ports:
      - "127.0.0.1:4200:4200"    # Only localhost — accessed via SSM port forward
    volumes:
      - openfang-data:/data
      - ./config.toml:/data/config.toml:ro
    environment:
      - LITELLM_API_KEY=sk-litellm-openfang-internal
    depends_on:
      - litellm
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 2G

  litellm:
    image: ghcr.io/berriai/litellm:main-latest
    ports:
      - "127.0.0.1:4000:4000"    # Internal only
    volumes:
      - ./litellm_config.yaml:/app/config.yaml:ro
    command: ["--config", "/app/config.yaml", "--port", "4000"]
    environment:
      - AWS_DEFAULT_REGION=us-west-2
      - LITELLM_MASTER_KEY=sk-litellm-openfang-internal
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 512M

volumes:
  openfang-data:
```

### 11.3 Environment Variables Summary

| Variable | Value | Where Set | Purpose |
|----------|-------|-----------|---------|
| `LITELLM_API_KEY` | `sk-litellm-openfang-internal` | docker-compose env | OpenFang → LiteLLM auth |
| `LITELLM_MASTER_KEY` | `sk-litellm-openfang-internal` | docker-compose env | LiteLLM master key |
| `AWS_DEFAULT_REGION` | `us-west-2` | docker-compose env | LiteLLM Bedrock region |
| `OPENFANG_HOME` | `/data` | Dockerfile ENV | OpenFang data directory |

**No AWS credentials as env vars.** LiteLLM uses the instance profile via IMDS automatically (boto3 credential chain).

---

## 12. Researcher Hand Activation

### 12.1 Activation Steps

After OpenFang is running:

```bash
# 1. Connect to instance via SSM
aws ssm start-session --target i-INSTANCE_ID --region us-west-2

# 2. Enter the OpenFang container
docker exec -it openfang-openfang-1 /bin/sh

# 3. Activate the Researcher Hand
openfang hand activate researcher

# 4. Check status
openfang hand status researcher

# 5. Test with a research query
openfang chat researcher
> "What are the latest developments in AI agent frameworks in 2026?"
```

### 12.2 Researcher Hand Verification

The Researcher Hand should:
1. Detect the platform (Linux) via `shell_exec` running `python -c "import platform; print(platform.system())"`
2. Load state from memory
3. Decompose the research question into sub-questions
4. Execute `web_search` queries (DuckDuckGo by default)
5. `web_fetch` promising URLs for deep reading
6. Cross-reference findings
7. Generate a structured report
8. Store results in the knowledge graph

**Note:** The Researcher's Phase 0 calls `python -c "import platform; print(platform.system())"`. The Debian slim runtime image does **not** include Python. Either:
- Install Python 3 in the Dockerfile (adds ~50MB) — recommended
- Or accept that this specific detection step will fail gracefully (the agent continues regardless)

### 12.3 Recommended Dockerfile Modification

Add Python 3 minimal to the runtime stage:

```dockerfile
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates python3-minimal && rm -rf /var/lib/apt/lists/*
```

This adds ~25MB but ensures the Researcher Hand's platform detection works.

---

## 13. UserData Script Outline

```bash
#!/bin/bash
set -euxo pipefail

# ── 1. System Updates ──────────────────────────────────────────────
dnf update -y
dnf install -y docker git

# ── 2. Docker Setup ────────────────────────────────────────────────
systemctl enable docker
systemctl start docker
usermod -aG docker ec2-user

# Install Docker Compose v2
DOCKER_COMPOSE_VERSION="v2.27.0"
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/download/${DOCKER_COMPOSE_VERSION}/docker-compose-linux-x86_64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# ── 3. OpenFang Source & Config ────────────────────────────────────
mkdir -p /opt/openfang
cd /opt/openfang

# Clone OpenFang (pin to specific commit for stability)
git clone --depth 1 https://github.com/RightNow-AI/openfang.git source

# Generate API key for OpenFang
OPENFANG_API_KEY=$(openssl rand -hex 32)

# Create OpenFang config
cat > config.toml << 'TOML'
api_key = "OPENFANG_API_KEY_PLACEHOLDER"
api_listen = "0.0.0.0:4200"

[default_model]
provider = "bedrock"
model = "bedrock/anthropic.claude-sonnet-4-6"
base_url = "http://litellm:4000/v1"
api_key_env = "LITELLM_API_KEY"

[memory]
decay_rate = 0.05

[network]
listen_addr = "0.0.0.0:4200"
TOML
sed -i "s/OPENFANG_API_KEY_PLACEHOLDER/${OPENFANG_API_KEY}/" config.toml

# Create LiteLLM config
cat > litellm_config.yaml << 'YAML'
model_list:
  - model_name: "bedrock/anthropic.claude-sonnet-4-6"
    litellm_params:
      model: "bedrock/anthropic.claude-sonnet-4-6-v1"
      aws_region_name: "us-west-2"
  - model_name: "bedrock/anthropic.claude-haiku-4-5-20251001"
    litellm_params:
      model: "bedrock/anthropic.claude-haiku-4-5-20251001-v1:0"
      aws_region_name: "us-west-2"
  - model_name: "bedrock/amazon.nova-pro-v1:0"
    litellm_params:
      model: "bedrock/amazon.nova-pro-v1:0"
      aws_region_name: "us-west-2"

general_settings:
  master_key: "sk-litellm-openfang-internal"
YAML

# Create Docker Compose file
cat > docker-compose.yml << 'COMPOSE'
version: "3.8"
services:
  openfang:
    build: ./source
    ports:
      - "127.0.0.1:4200:4200"
    volumes:
      - openfang-data:/data
      - ./config.toml:/data/config.toml:ro
    environment:
      - LITELLM_API_KEY=sk-litellm-openfang-internal
    depends_on:
      litellm:
        condition: service_started
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 2G

  litellm:
    image: ghcr.io/berriai/litellm:main-latest
    ports:
      - "127.0.0.1:4000:4000"
    volumes:
      - ./litellm_config.yaml:/app/config.yaml:ro
    command: ["--config", "/app/config.yaml", "--port", "4000"]
    environment:
      - AWS_DEFAULT_REGION=us-west-2
      - LITELLM_MASTER_KEY=sk-litellm-openfang-internal
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 512M

volumes:
  openfang-data:
COMPOSE

# ── 4. Build & Start ──────────────────────────────────────────────
docker compose up -d --build

# ── 5. Save API Key for Operator ──────────────────────────────────
echo "OPENFANG_API_KEY=${OPENFANG_API_KEY}" > /opt/openfang/.env
chmod 600 /opt/openfang/.env

# ── 6. Signal Success ─────────────────────────────────────────────
/opt/aws/bin/cfn-signal -e $? --stack ${AWS::StackName} --resource OpenFangInstance --region us-west-2 || true

echo "OpenFang deployment complete. API key saved to /opt/openfang/.env"
```

**Note:** The Rust build during `docker compose up --build` will take significant time on first run (compiling 14 crates from source). On t3.medium this could take 15-30 minutes. To optimize:
- Pre-build the Docker image in a CI/CD pipeline and push to ECR
- Or use a larger instance (c5.xlarge) for the initial build, then downsize

---

## 14. Cost Estimate

### 14.1 Monthly Cost Breakdown

| Component | Specification | Monthly Cost |
|-----------|--------------|-------------|
| **EC2 — OpenFang** | t3.medium, us-west-2, on-demand | $30.37 |
| **EC2 — NAT Instance** | t3.micro, us-west-2, on-demand | $7.59 |
| **EBS — OpenFang** | 30 GB gp3 | $2.40 |
| **EBS — NAT** | 8 GB gp3 | $0.64 |
| **Elastic IP** | 1 EIP (attached to NAT) | $3.65 |
| **Data Transfer** | ~5 GB outbound estimate | $0.45 |
| **SSM** | Session Manager | Free |
| **CloudWatch** | Basic monitoring | Free |
| | | |
| **Subtotal (fixed)** | | **~$45.10/month** |

### 14.2 Bedrock Token Costs (Variable)

| Model | Input (per 1M tokens) | Output (per 1M tokens) |
|-------|----------------------|----------------------|
| Claude Sonnet 4.6 | $3.00 | $15.00 |
| Claude Haiku 4.5 | $0.25 | $1.25 |
| Amazon Nova Pro | $0.80 | $3.20 |
| Amazon Nova Lite | $0.06 | $0.24 |

**Estimated Bedrock usage for Researcher Hand testing:**
- ~10 research sessions/month
- ~50K input tokens + ~10K output tokens per session (Sonnet 4.6)
- Input: 500K tokens × $3.00/1M = $1.50
- Output: 100K tokens × $15.00/1M = $1.50
- **Estimated Bedrock: ~$3/month** for light testing

### 14.3 Total Estimated Monthly Cost

| Scenario | Cost |
|----------|------|
| **Idle (deployed, not used)** | ~$45/month |
| **Light testing (10 research sessions)** | ~$48/month |
| **Moderate use (50 research sessions)** | ~$60/month |
| **Heavy use (daily research)** | ~$80-120/month |

### 14.4 Cost Optimization Options

| Optimization | Savings | Trade-off |
|-------------|---------|-----------|
| **Reserved Instance (1yr)** t3.medium | ~40% ($18/mo vs $30) | 1-year commitment |
| **Spot Instance** for OpenFang | ~70% ($9/mo) | Interruption risk |
| **Scheduled stop/start** (8hrs/day) | ~67% ($15/mo) | Not 24/7 |
| **Graviton (t4g.medium)** | ~20% ($24/mo) | Needs ARM Docker build |
| **Use Nova Lite instead of Sonnet** | ~95% token savings | Lower quality |

---

## 15. CDK vs CloudFormation Recommendation

### 15.1 Comparison

| Aspect | CDK (TypeScript) | CloudFormation (YAML) |
|--------|------------------|----------------------|
| **Language** | TypeScript — familiar to most devs | YAML — verbose but universal |
| **Abstractions** | L2 constructs simplify VPC, EC2 | Raw resources, more boilerplate |
| **IDE support** | Full TypeScript autocomplete | Limited YAML validation |
| **Testing** | Jest snapshot tests | cfn-lint only |
| **Maintenance** | CDK lib updates needed | Stable, no dependency drift |
| **Complexity for this project** | ~300 lines | ~600 lines |
| **Learning curve** | Moderate (CDK + TS) | Low (just YAML) |
| **Team familiarity** | Likely good (TS is common) | Universal |

### 15.2 Recommendation: CDK (TypeScript)

For this project, CDK is recommended because:

1. **VPC construct** handles subnets, route tables, and NAT in ~10 lines vs ~80 lines of CloudFormation
2. **Strong typing** catches misconfigurations at compile time (SG rules, IAM policies)
3. **Reusability** — the stack can be parameterized for dev/staging/prod
4. **Testing** — snapshot tests validate infrastructure changes
5. **Familiarity** — TypeScript is the most common CDK language

### 15.3 Proposed CDK Project Structure

```
openfang-aws-deploy/
├── bin/
│   └── openfang-deploy.ts          # CDK app entry point
├── lib/
│   ├── openfang-stack.ts           # Main stack (VPC + EC2 + IAM + SGs)
│   ├── nat-instance.ts             # NAT instance construct
│   └── config/
│       ├── openfang.toml           # OpenFang config template
│       ├── litellm_config.yaml     # LiteLLM config
│       └── docker-compose.yml      # Production compose file
├── test/
│   └── openfang-stack.test.ts      # Snapshot + assertion tests
├── cdk.json
├── tsconfig.json
├── package.json
├── ARCHITECTURE.md                 # This document
└── CONTEXT.md                      # Project context
```

---

## 16. Deployment Verification Checklist

### 16.1 Infrastructure Verification

- [ ] VPC created with correct CIDR (10.0.0.0/16)
- [ ] Public subnet (10.0.1.0/24) has route to IGW
- [ ] Private subnet (10.0.10.0/24) has route to NAT instance
- [ ] NAT instance has Elastic IP and source/dest check disabled
- [ ] EC2 instance is in private subnet with no public IP
- [ ] Security groups match specification (no inbound on EC2)
- [ ] IAM role has Bedrock invoke permissions
- [ ] IAM role has SSM managed instance core policy
- [ ] SSM Session Manager can connect to instance

### 16.2 OpenFang Verification

- [ ] Docker containers running: `docker compose ps` shows both services healthy
- [ ] LiteLLM proxy responds: `curl http://localhost:4000/health`
- [ ] OpenFang API responds: `curl -H "Authorization: Bearer $KEY" http://localhost:4200/api/health`
- [ ] Bedrock model accessible: test chat completion through LiteLLM
- [ ] OpenFang config loaded correctly: check `/api/models` endpoint
- [ ] Data volume persists across container restarts

### 16.3 Researcher Hand Verification

- [ ] `openfang hand list` shows Researcher as available
- [ ] `openfang hand activate researcher` succeeds
- [ ] `openfang hand status researcher` shows active
- [ ] Test query produces web searches (check logs for DuckDuckGo queries)
- [ ] Test query produces a structured research report
- [ ] Report is saved to data volume

### 16.4 Security Verification

- [ ] No public IPs on OpenFang instance
- [ ] No SSH key pairs in use
- [ ] No AWS credentials in environment variables or config files
- [ ] OpenFang API requires Bearer token
- [ ] LiteLLM only accessible from localhost/Docker network
- [ ] Port 4200 only bound to 127.0.0.1 on host
- [ ] EC2 instance tagged with `Project: openfang` for SSM conditions

---

## Appendix A: Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Rust build timeout on t3.medium | Medium | Delays deployment | Pre-build Docker image in CI or use larger instance for first build |
| LiteLLM proxy instability | Low | Bedrock calls fail | Pin LiteLLM version, add health checks, auto-restart |
| DuckDuckGo rate limiting | Medium | web_search degraded | Add Brave API key ($0 for 2000 queries/month free tier) |
| NAT instance failure | Low | All outbound fails | Monitor with CloudWatch, auto-recovery via ASG (future) |
| OpenFang v0.1.0 breaking changes | Medium | Requires rebuild | Pin to specific git commit |
| IMDS v1 disabled by default in AL2023 | Low | LiteLLM can't get creds | Ensure IMDSv2 hop limit ≥ 2 for Docker containers |

## Appendix B: IMDSv2 Configuration

Docker containers need IMDSv2 with an increased hop limit to access instance metadata. By default, the hop limit is 1, which means Docker containers (which add a network hop) cannot reach IMDS.

**EC2 launch configuration must set:**
```
HttpTokens: required          # IMDSv2 only (more secure)
HttpPutResponseHopLimit: 2    # Allow Docker containers to reach IMDS
```

This is critical for LiteLLM to obtain Bedrock credentials from the instance profile.

## Appendix C: Future Enhancements

1. **ECR image repository** — pre-build OpenFang Docker image in CI, push to ECR, pull on EC2 (eliminates build step)
2. **CloudWatch Logs** — ship OpenFang + LiteLLM logs to CloudWatch
3. **Auto Scaling** — for production, wrap in ASG with health checks
4. **ALB + WAF** — if exposing API to team (not just SSM port forward)
5. **Secrets Manager** — rotate OpenFang API key automatically
6. **Bedrock VPC Endpoint** — eliminate NAT traffic for Bedrock calls
7. **Multi-AZ** — NAT Gateway + second subnet for HA
8. **Graviton/ARM** — t4g.medium for ~20% cost savings (requires ARM Rust build)
