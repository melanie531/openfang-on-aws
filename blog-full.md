# OpenFang on AWS — Deploying an Open-Source Agent OS with Amazon Bedrock

## 1. Introduction

The AI agent landscape is moving beyond conversational chatbots. A new category is emerging: autonomous agents that run on schedules, build knowledge graphs, and produce deliverables — all without waiting for a human to type a prompt. These systems operate more like background services than chat interfaces, and they require infrastructure patterns that look fundamentally different from serving a web application.

This post walks through deploying [OpenFang](https://github.com/RightNow-AI/openfang), an open-source Agent Operating System written in Rust, on AWS using Amazon Bedrock as the LLM backend. OpenFang compiles to a single ~32 MB binary, ships with seven pre-built autonomous agent packages called "Hands," and includes 16 independent security layers — making it a compelling candidate for teams evaluating autonomous agent infrastructure.

By the end of this series, you will understand:

- What an Agent OS is and how it differs from agent frameworks like LangChain or CrewAI
- How OpenFang compares to OpenClaw, another open-source agent platform
- How to deploy OpenFang on a private EC2 instance with zero inbound ports, IAM-based authentication, and Amazon Bedrock integration via a LiteLLM sidecar proxy
- What a Well-Architected Framework (WAF) security review reveals about deploying autonomous agents — and how to remediate the findings

This is a development and test deployment. Production hardening guidance, including the full WAF review results and remediation steps, is covered in later sections. All infrastructure is deployed with AWS CDK and can be torn down with a single command.

---

## 2. What Is an Agent OS?

### The concept

An Agent OS is a runtime that manages autonomous agents the way a traditional operating system manages processes. It handles scheduling, resource isolation, inter-process communication, and lifecycle management. Agents are not functions you call — they are long-running entities that the OS starts, monitors, suspends, and resumes.

This is a meaningful distinction from what most practitioners encounter when working with agent frameworks.

### Agent frameworks vs. an Agent OS

Frameworks like LangChain, CrewAI, AutoGen, and LangGraph are libraries. You import them into your application code, define agent logic in Python, and execute that logic within your application's process. When your application stops, the agents stop. There is no daemon, no scheduler, no resource metering independent of your code.

An Agent OS operates differently. It runs as a standalone daemon — comparable to `systemd` managing services on Linux. Agents are declared through configuration manifests, not imperative code. The OS starts them on schedules, enforces resource budgets, isolates their execution environments, records an immutable audit trail, and manages their entire lifecycle independent of any user session.

Consider a concrete example: OpenFang's Researcher Hand. Once activated, it decomposes research questions into sub-queries, searches the web across multiple sources, cross-references findings using credibility evaluation criteria (CRAAP — Currency, Relevance, Authority, Accuracy, Purpose), builds a knowledge graph from the results, and delivers a cited report. This happens autonomously on a schedule. No user prompt triggers each step.

### OpenFang specifics

OpenFang is built in Rust and compiles to a single ~32 MB binary across 14 crates totaling 137,000+ lines of code with 1,767+ passing tests. The architecture includes:

- **Kernel** — Orchestration, RBAC, metering, scheduling, and budget tracking
- **Runtime** — Agent execution loop, 53 built-in tools, WASM sandbox, MCP and A2A protocol support
- **Hands** — Seven bundled autonomous agent packages (Researcher, Lead, Collector, Predictor, Twitter, Clip, Browser), each with a TOML manifest, multi-phase system prompt, domain expertise reference, and guardrails

What qualifies it as an "OS" rather than a "framework" comes down to kernel-level capabilities that frameworks do not provide:

| Capability | Agent OS (OpenFang) | Agent Frameworks (LangChain, CrewAI, AutoGen, LangGraph) |
|---|---|---|
| **Execution model** | Daemon process — agents run independently of user sessions | Library — agents execute within your application process |
| **Scheduling** | Built-in cron-style scheduler; agents wake on schedules | No native scheduling; requires external orchestration (Airflow, cron) |
| **Resource isolation** | WASM dual-metered sandbox with fuel metering and epoch interruption | No sandboxing (CrewAI, LangGraph) or Docker-level isolation (AutoGen) |
| **Audit trail** | Merkle hash-chain — cryptographically linked, tamper-evident | Application-level logging; no integrity guarantees |
| **Daemon mode** | Native systemd support; runs as a background service | Not applicable — terminates when the calling process exits |
| **Capability control** | Kernel-enforced RBAC; agents declare required tools, kernel gates access | Trust-based — agents access whatever the code imports |
| **Security layers** | 16 independent layers (SSRF protection, taint tracking, prompt injection scanning, rate limiting, etc.) | 0–2 layers depending on framework |
| **Bundled agents** | 7 production-ready Hands with multi-phase operational playbooks | None — you build agent logic from scratch |
| **Channel adapters** | 40 native adapters (Telegram, Slack, Discord, WhatsApp, Teams, etc.) | 0 native adapters; requires custom integration |

The distinction is not about capability — you can build sophisticated agents with any of these frameworks. The distinction is about operational maturity. An Agent OS treats agents as first-class managed workloads, not as code paths in your application.

---

## 3. OpenFang vs. OpenClaw — Choosing the Right Tool

Both OpenFang and OpenClaw are open-source, MIT-licensed, and built for AI agents. Both support multiple LLM providers. But they solve fundamentally different problems, and understanding the distinction matters when selecting the right tool for a given workload.

### OpenFang: Autonomous workers

OpenFang is a Rust-based Agent OS designed for autonomous task execution. Its seven bundled Hands run on schedules, produce deliverables (research reports, qualified lead lists, OSINT intelligence), and build knowledge graphs — all without human prompting. It runs as a daemon, ships as a single ~32 MB binary with a cold start under 200 ms, and includes 16 security layers with a WASM-sandboxed execution environment. It supports 40 channel adapters for delivering results and 27 LLM providers for model routing.

The interaction model is declarative: you activate a Hand, configure its schedule and parameters, and it operates autonomously. The dashboard and API provide monitoring and control, but the agents do not depend on conversational input to function.

### OpenClaw: Conversational assistant

OpenClaw is a Node.js/TypeScript platform designed as a personal AI assistant. Its primary interfaces are messaging platforms — WhatsApp, Telegram, and Discord. It provides rich conversational memory, tool orchestration, sub-agent delegation, and cron-based scheduling. The footprint is larger (~500 MB install, ~6 second cold start), which reflects its richer runtime ecosystem for conversational AI.

The interaction model is conversational: you chat with OpenClaw through a messaging platform, and it uses tools and memory to assist you. It excels at context-rich, multi-turn interactions where the human is an active participant.

### Comparison

| Dimension | OpenFang | OpenClaw |
|---|---|---|
| **Language** | Rust | Node.js / TypeScript |
| **Install size** | ~32 MB | ~500 MB |
| **Cold start** | <200 ms | ~6 s |
| **Primary mode** | Autonomous daemon | Conversational assistant |
| **Bundled agents** | 7 Hands (Researcher, Lead, Collector, Predictor, Twitter, Clip, Browser) | None (you configure assistants) |
| **Security layers** | 16 (WASM sandbox, taint tracking, Merkle audit, SSRF protection, etc.) | 3 (basic access controls) |
| **Channel adapters** | 40 | 13 |
| **LLM providers** | 27 | 10 |
| **Best for** | Scheduled autonomous tasks — research, lead gen, OSINT, monitoring | Personal AI assistant — chat-based interaction on messaging platforms |

### When to use which

**Choose OpenFang** when you need agents that run autonomously on schedules — daily lead generation, continuous OSINT monitoring, automated research pipelines. When you want a lightweight daemon on a small EC2 instance. When your security requirements demand WASM sandboxing, taint tracking, and a tamper-evident audit trail.

**Choose OpenClaw** when you want a personal AI assistant accessible through WhatsApp or Telegram. When you need rich conversational memory and multi-turn context. When your primary interaction model is chat-based and the human is in the loop for most decisions.

**Use both together** for the most capable architecture: OpenFang runs the autonomous backend work — research, monitoring, lead generation — while OpenClaw delivers the results conversationally to your messaging platform and handles human-in-the-loop interactions. OpenFang produces; OpenClaw communicates.

The key insight is that these are complementary tools, not competitors. One automates; the other converses.

## 4. Why Deploy on AWS?

OpenFang runs well on a laptop for testing. But autonomous agents — by definition — need to run when you are not at your desk.

If the Researcher Hand is scheduled for 6 AM daily, or the Collector is monitoring a target continuously, your laptop needs to be open, awake, and connected. For anything beyond casual experimentation, always-on infrastructure becomes a requirement.

AWS provides four specific advantages for this workload:

### Amazon Bedrock: Managed LLM Access

Bedrock provides access to Claude, Nova, Llama, and other foundation models through a single API with IAM-based authentication. No GPU provisioning, no model hosting, no inference infrastructure to manage. You pay per token. For an always-on agent that may invoke the LLM dozens of times per day, this is significantly simpler and more cost-effective than self-hosting.

### IAM Instance Profiles: Zero Static Credentials

The EC2 instance obtains temporary, automatically rotating AWS credentials via the Instance Metadata Service (IMDS). There is no `.env` file with an `ANTHROPIC_API_KEY` or `AWS_SECRET_ACCESS_KEY`. The credentials rotate automatically, cannot be exfiltrated from a config file, and are scoped to precisely the IAM permissions the agent needs.

### SSM Session Manager: Zero Inbound Ports

With SSM, the instance has no SSH port, no bastion host, no VPN endpoint. Access is authenticated via IAM, encrypted in transit, and logged to CloudTrail. Port forwarding to the OpenFang dashboard works through the same channel. The attack surface is effectively zero from a network ingress perspective.

### VPC Isolation

The instance runs in a private subnet with no public IP. A NAT Gateway provides outbound internet access (the agent needs it for web research), but nothing on the internet can initiate a connection to the instance. Combined with SSM and a restricted security group, this creates a defense-in-depth posture.

| Dimension | Local (Laptop) | AWS (EC2 + Bedrock) |
|---|---|---|
| **Availability** | Only when laptop is open | 24/7 |
| **LLM access** | API keys in env files | IAM instance profile — no static keys |
| **Credential security** | Plaintext on disk | Rotating via IMDS, scoped by IAM policy |
| **Network access** | Home network, shared WiFi | Private subnet, no inbound ports |
| **Cost** | $0 infra (your electricity) | ~$33–65/month + Bedrock tokens |
| **Monitoring** | None (unless you build it) | CloudWatch, VPC Flow Logs, CloudTrail |

The cost of this deployment — roughly $33/month when reusing an existing VPC, or $65/month with a new VPC — is modest for an always-on autonomous agent with enterprise-grade security.

---

## 5. The Bedrock Integration Challenge — The LiteLLM Proxy Pattern

### The Problem

OpenFang's model catalog lists eight Bedrock models and defines a `BEDROCK_BASE_URL` constant. On the surface, it appears Bedrock-ready. It is not.

Examining the source code (`crates/openfang-runtime/src/drivers/mod.rs`), the `provider_defaults("bedrock")` function returns `None` — there is no match arm for the Bedrock provider. The `create_driver()` function has no special case for Bedrock either, unlike Anthropic, Gemini, or Codex which have dedicated driver logic. The fallback path creates an OpenAI-compatible driver and sets `base_url` to the configured endpoint.

This fallback would work — except for authentication. The OpenAI-compatible driver sends `Authorization: Bearer <token>` headers. Amazon Bedrock requires AWS Signature Version 4 (SigV4) signing. These are fundamentally incompatible authentication schemes.

### The Solution: LiteLLM Sidecar Proxy

[LiteLLM](https://github.com/BerryAI/litellm) is an open-source proxy that translates between OpenAI-compatible API calls and 100+ LLM providers, including Amazon Bedrock. It runs as a lightweight sidecar container alongside OpenFang.

The integration works as follows:

1. OpenFang sends a standard `POST /v1/chat/completions` request to `http://litellm:4000` with a Bearer token
2. LiteLLM receives the request, identifies the target model from its configuration
3. LiteLLM reads EC2 instance profile credentials from IMDS (via boto3's standard credential chain)
4. LiteLLM signs the request with SigV4 and sends it to `bedrock-runtime.us-west-2.amazonaws.com`
5. The Bedrock response flows back through LiteLLM to OpenFang in the OpenAI response format

### Model Name Translation

This seemingly simple proxy introduces a three-layer name translation problem:

- **OpenFang catalog name:** `bedrock/anthropic.claude-sonnet-4-6`
- **Bedrock foundation model ID:** `anthropic.claude-sonnet-4-6-v1`
- **Cross-region inference profile ID:** `us.anthropic.claude-sonnet-4-6`

OpenFang strips the `bedrock/` prefix before sending to LiteLLM. LiteLLM needs to map the bare name to the correct Bedrock model identifier including the `us.` prefix for cross-region inference.

The LiteLLM configuration handles this with a model list that registers both the prefixed and bare names:

```yaml
model_list:
  - model_name: "bedrock/anthropic.claude-sonnet-4-6"
    litellm_params:
      model: "bedrock/us.anthropic.claude-sonnet-4-6"
      aws_region_name: "us-west-2"
  - model_name: "anthropic.claude-sonnet-4-6"
    litellm_params:
      model: "bedrock/us.anthropic.claude-sonnet-4-6"
      aws_region_name: "us-west-2"

general_settings:
  master_key: "${LITELLM_KEY}"
```

The second entry (without the `bedrock/` prefix) catches requests from OpenFang after it strips the prefix. Both entries route to the same underlying Bedrock model.

### Why This Pattern Matters Beyond OpenFang

The LiteLLM sidecar pattern is not OpenFang-specific. Any open-source agent framework that speaks the OpenAI API — LangChain, AutoGen, CrewAI, LangGraph, or any custom agent code using the OpenAI Python SDK — can use the identical setup to access Amazon Bedrock. The framework talks to `localhost:4000` as if it were the OpenAI API. LiteLLM handles authentication, model routing, and response translation transparently.

This makes the LiteLLM sidecar a **reusable architecture pattern** for running open-source AI tools on AWS with Bedrock.

---

## 6. Architecture Deep Dive

### VPC Design

The CDK stack provisions a VPC with a `10.0.0.0/16` CIDR block containing a public subnet (hosting the NAT Gateway) and a private subnet (hosting the EC2 instance). For development and testing, this is a single-AZ deployment. The stack also supports reusing an existing VPC by passing `-c vpcId=vpc-xxx` at deploy time, which skips VPC creation entirely.

### EC2 Instance

| Specification | Value |
|---|---|
| **Instance type** | t3.xlarge (4 vCPU, 16 GB RAM) |
| **AMI** | Amazon Linux 2023 (latest) |
| **EBS** | 30 GB gp3, encrypted at rest |
| **Public IP** | None |
| **Key pair** | None (SSM access only) |
| **IMDSv2** | Required, hop limit = 2 |
| **Placement** | Private subnet |

The t3.xlarge instance is sized for the Docker build phase — compiling OpenFang's 137K lines of Rust code requires more than 4 GB of RAM. After the initial build, the runtime needs are modest (~200–500 MB under load). For production, you could build the image separately and push it to ECR, then run on a t3.medium.

### Docker Compose: Two Containers

The deployment uses Docker Compose to run two containers on a shared Docker network:

**OpenFang** — Runs with `network_mode: host` because it binds to `127.0.0.1:50051` and ignores the `listen_addr` configuration override. Docker port mapping cannot reach a loopback-bound process inside a container, so host networking is required. The OpenFang API and dashboard are accessible on `localhost:50051`.

**LiteLLM** — Runs in standard Docker bridge mode, publishing port 4000 to `127.0.0.1:4000`. It mounts the `litellm_config.yaml` file and uses the EC2 instance profile for Bedrock authentication.

Neither port is exposed to the VPC. They are bound to localhost only. Access from an operator's workstation uses SSM port forwarding:

```bash
aws ssm start-session \
  --target <instance-id> \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["50051"],"localPortNumber":["4200"]}' \
  --region us-west-2
```

### IMDSv2 Hop Limit

A critical detail: Docker containers add a network hop when accessing the EC2 Instance Metadata Service. The default IMDSv2 hop limit of 1 blocks container access to IMDS. This means LiteLLM cannot obtain instance profile credentials, resulting in `NoCredentialsError` from boto3.

The fix is a single CDK configuration:

```typescript
instance.instance.addPropertyOverride(
  "MetadataOptions.HttpPutResponseHopLimit", 2
);
```

### UserData Bootstrap Sequence

The EC2 UserData script runs the full provisioning sequence at launch:

1. Install system packages (Docker, git, build tools)
2. Install Docker Compose
3. Clone OpenFang source code
4. **Generate secrets dynamically** — `openssl rand -hex 32` for both the LiteLLM master key and the OpenFang API key (no hardcoded values)
5. Write LiteLLM configuration (`litellm_config.yaml`)
6. Write OpenFang configuration (`config.toml`)
7. Write Docker Compose manifest
8. `docker compose up -d --build`
9. Wait for services, then activate the Researcher Hand via the API

### Access Model

The operator's access path: Workstation → AWS CLI → SSM Session Manager (HTTPS, IAM-authenticated, CloudTrail-logged) → Port forward → `localhost:4200` → OpenFang dashboard. At no point does a port open to the internet.

## 7. Security: What the WAF Review Revealed

Before deploying any AI agent system beyond a proof of concept, run it through the AWS Well-Architected Framework Security Pillar. Here is what we found — and the lessons apply to any autonomous agent deployment, not just OpenFang.

### What Was Already Good

The deployment scored 7/10 for both Identity and Access Management and Infrastructure Protection:

- **Zero inbound ports** — The security group allows no ingress traffic. Nothing on the internet can connect to this instance.
- **IMDSv2 enforced** — Prevents SSRF-based credential theft from the instance metadata service.
- **Instance profile** — No static AWS credentials anywhere in the system. Temporary credentials rotate automatically.
- **Least-privilege IAM** — The policy allows only `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on specific model families.
- **Encrypted EBS** — Data at rest is encrypted by default.
- **Localhost-bound Docker ports** — Both OpenFang (50051) and LiteLLM (4000) bind to `127.0.0.1`, not `0.0.0.0`.
- **No SSH keys** — Access is exclusively through SSM Session Manager.

These are solid foundations. If you are deploying agents on AWS, this is the baseline to aim for.

### What Was Missing

The deployment scored 3/10 for Detection Controls and 2/10 for Incident Response:

| Finding | Severity | Issue |
|---|---|---|
| No alerting infrastructure | CRITICAL | No SNS topic, no email notifications. If the instance dies, no one knows. |
| No VPC Flow Logs | HIGH | No network traffic visibility for an agent with `web_fetch` and `shell_exec` capabilities. |
| No centralized logging | HIGH | Container logs exist only on the local EBS volume. |
| No CloudWatch Alarms | HIGH | CPU spikes, status check failures, and disk pressure go undetected. |
| Hardcoded LiteLLM master key | HIGH | The same static string `sk-litellm-openfang-internal` appeared in four places. |
| Unpinned LiteLLM image | HIGH | `ghcr.io/berriai/litellm:main-latest` is a moving target — supply chain risk. |
| No backup plan | MEDIUM | The knowledge graph and research data sit on a single EBS volume with no snapshots. |

### How We Fixed the Critical and High Findings

Using AWS CDK, we added the following to the stack:

1. **SNS Topic + CloudWatch Alarms** — StatusCheckFailed alarm (period 60s, threshold 1) and High CPU alarm (>80%, period 300s) both notify an SNS topic. A `CfnParameter` accepts an alert email at deploy time.

2. **VPC Flow Logs** — All traffic logged to a CloudWatch Log Group with 30-day retention and a dedicated IAM role for the VPC Flow Log service.

3. **Dynamic secret generation** — Both the LiteLLM master key and OpenFang API key are generated at runtime with `openssl rand -hex 32`. No static secrets in UserData or config files.

4. **Pinned container image** — LiteLLM image pinned to `ghcr.io/berriai/litellm:main-v1.65.0`.

5. **Termination protection** — Enabled on the EC2 instance to prevent accidental stack deletion.

After remediation, the scores improved:

| Security Area | Before | After |
|---|---|---|
| Identity and Access Management | 7/10 | 7/10 |
| Detection Controls | 3/10 | 6/10 |
| Infrastructure Protection | 7/10 | 8/10 |
| Data Protection | 5/10 | 6/10 |
| Incident Response | 2/10 | 5/10 |
| **Overall** | **4.8/10** | **6.4/10** |

### The Takeaway for Any Agent Deployment

AI agents with autonomous internet access and shell execution are a different threat model than a web application. An agent that can run `shell_exec` and `web_fetch` can reach internal networks, exfiltrate data, or be manipulated via prompt injection to take unintended actions.

Detection controls — logging, monitoring, alerting — are non-negotiable for production agent deployments. Treat the agent like an intern with root access: trust, but verify, and keep the audit trail comprehensive.

---

## 8. Deploying It Yourself — CDK Walkthrough

### Prerequisites

- Node.js >= 18
- AWS CDK CLI (`npm install -g aws-cdk`)
- AWS credentials with VPC, EC2, IAM, CloudWatch, and SNS permissions
- CDK bootstrapped in the target account/region (`cdk bootstrap`)
- SSM Session Manager plugin installed locally

### Two Deployment Modes

**Mode 1 — New VPC (full self-contained deployment):**

```bash
git clone https://github.com/melanie531/openfang-on-aws.git
cd openfang-on-aws
npm install
npx cdk deploy --parameters AlertEmail=your@email.com
```

This creates the VPC, subnets, NAT Gateway, EC2 instance, IAM role, security group, flow logs, alarms, and SNS topic. Estimated cost: ~$65/month.

**Mode 2 — Existing VPC (reuse your networking):**

```bash
npx cdk deploy -c vpcId=vpc-xxx --parameters AlertEmail=your@email.com
```

This creates only the EC2 instance, IAM role, security group, and monitoring resources within your existing VPC. Estimated cost: ~$33/month.

### Context Variables

| Variable | Default | Description |
|---|---|---|
| `vpcId` | (none — creates new) | Existing VPC ID to reuse |
| `instanceType` | `t3.xlarge` | EC2 instance type |
| `bedrockRegion` | `us-west-2` | Region for Bedrock API calls |

### Connecting

```bash
# Shell access
aws ssm start-session --target <instance-id> --region us-west-2

# Port forward to dashboard
aws ssm start-session --target <instance-id> \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["50051"],"localPortNumber":["4200"]}' \
  --region us-west-2

# Get the auto-generated API key
cat /opt/openfang/.env
```

### Cost Breakdown

| Component | Mode 1 (New VPC) | Mode 2 (Existing VPC) |
|---|---|---|
| EC2 t3.xlarge | ~$30/month | ~$30/month |
| NAT Gateway | ~$33/month | $0 (existing) |
| EBS 30GB gp3 | ~$2.40/month | ~$2.40/month |
| CloudWatch Logs | ~$0.50/month | ~$0.50/month |
| Bedrock tokens | Variable (~$3/month light use) | Variable |
| **Total** | **~$66/month** | **~$33/month** |

### Tear Down

```bash
npx cdk destroy
```

This removes everything. The S3 temp bucket (if created) may need manual cleanup.

---

## 9. What We Learned — Practical Gotchas

### 1. Rust Compilation OOM on t3.medium

OpenFang's 14 Rust crates need more than 4 GB of RAM to compile. On a t3.medium (4 GB), the `cargo build` process gets OOM-killed silently during the Docker build. The instance reboots, Docker restarts, the build fails again — an infinite loop that consumes credits.

**Solution:** We upgraded to t3.xlarge (16 GB) and added a 4 GB swap file in UserData before the Docker build. For production, pre-build the Docker image and push it to ECR to avoid compilation on the instance entirely.

### 2. Model Name Translation Is a Three-Layer Problem

OpenFang sends `anthropic.claude-sonnet-4-6`. Bedrock expects `anthropic.claude-sonnet-4-6-v1`. Cross-region inference profiles use `us.anthropic.claude-sonnet-4-6`. Getting any layer wrong produces cryptic 400 errors from Bedrock with no clear indication of what went wrong. Map all three layers explicitly in LiteLLM's `model_list`.

### 3. Docker Networking with Loopback Binding

OpenFang hardcodes `127.0.0.1:50051` as its listen address, ignoring the `listen_addr` configuration field. In standard Docker bridge mode, this means the port is unreachable from outside the container — including from the host and from other containers. The fix is `network_mode: host`, which lets OpenFang bind to the host's loopback interface directly.

### 4. IMDSv2 Hop Limit = 2

Docker adds a network hop. The default IMDSv2 hop limit of 1 prevents containers from reaching the instance metadata service. LiteLLM fails with `NoCredentialsError` because boto3 cannot obtain instance profile credentials. One line in CDK fixes this: `HttpPutResponseHopLimit: 2`.

### 5. Researcher Hand Needs Python

The Researcher Hand's first phase runs `python -c "import platform; print(platform.system())"` for platform detection. The Debian slim runtime image does not include Python. The detection fails gracefully (it defaults to Linux), but installing `python3-minimal` (~25 MB) in the Dockerfile avoids the edge case.

### 6. DuckDuckGo as Zero-Config Search

The Researcher Hand supports Tavily, Brave, and Perplexity for web search, but all require API keys. DuckDuckGo is the automatic fallback — zero configuration, no API key needed. It works well for development and testing but may hit rate limits under heavy use. For production, Brave Search (2,000 free queries/month) is a practical step up.

---

## 10. Conclusion

The Agent OS is an emerging category. OpenFang (v0.1.0, February 2026) represents one approach — autonomous agents that run as OS-level daemons, not chatbot sessions. It is early, opinionated, and not yet battle-tested in production at scale. But the core concept — agents as managed workloads with scheduling, sandboxing, and audit trails — points to where the industry is heading.

AWS provides a natural foundation for these systems. Bedrock delivers managed LLM access without GPU provisioning. IAM eliminates static credentials. VPC isolation and SSM create a zero-trust access model. CloudWatch and VPC Flow Logs provide the detection controls that autonomous agents require.

Three patterns from this deployment are reusable beyond OpenFang:

1. **The LiteLLM sidecar** — Any OpenAI-compatible agent framework can use this pattern to access Bedrock with IAM authentication.
2. **The WAF security review template** — The five-pillar review we conducted applies to any agent deployment. Detection controls and incident response are where most teams underinvest.
3. **The CDK two-mode pattern** — Supporting both new VPC and existing VPC deployments via context variables makes the stack reusable across environments.

The code is open source: [github.com/melanie531/openfang-on-aws](https://github.com/melanie531/openfang-on-aws). Deploy it. Run your own WAF review. And if you build something interesting with OpenFang's Hands — we would like to hear about it.

---

*Melanie Li is an AWS Solutions Architect specializing in machine learning and generative AI. She writes about AI infrastructure, agent systems, and the practical side of deploying ML in production. Find her on [LinkedIn](https://www.linkedin.com/in/peiyaoli/) and [GitHub](https://github.com/melanie531).*
