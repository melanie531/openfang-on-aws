# Blog Outline: OpenFang on AWS — Deploying an Open-Source Agent OS with Amazon Bedrock

**Target Audience:** AWS Solutions Architects, cloud engineers, and builders evaluating autonomous AI agent systems.

**Estimated Total Length:** ~4,500–5,500 words

**Blog Type:** How-To / Tutorial with architectural deep-dive

---

## 1. Introduction

- The AI agent landscape is evolving beyond chatbots — autonomous agents that work on schedules, build knowledge graphs, and produce deliverables without human prompting are emerging.
- This post walks through deploying OpenFang, an open-source Agent OS written in Rust, on AWS using Amazon Bedrock as the LLM backend.
- By the end, readers will understand what an Agent OS is, how to run one on AWS with zero inbound ports and IAM-based auth, and what security lessons apply to any agent deployment.
- Brief mention: this is a dev/test deployment; production hardening guidance is included.

**Estimated word count:** 200–300

**Diagrams/tables:** None

---

## 2. What is an Agent OS?

- Define the concept: an Agent OS is a runtime that manages autonomous agents the way an operating system manages processes — scheduling, resource isolation, inter-process communication, and lifecycle management.
- Contrast with chatbot frameworks (LangChain, CrewAI, AutoGen, LangGraph): these are libraries you call from your code. An Agent OS is a daemon that runs agents independently of any user session. Agents wake up on schedules, act autonomously, persist state, and report results.
- OpenFang specifics: Rust, single ~32MB binary, 14 crates, 137K LOC, 1,767+ tests. Compiles to one executable. Includes a kernel (orchestration, RBAC, metering, scheduler), a runtime (agent loop, 53 tools, WASM sandbox), and 7 bundled "Hands" (autonomous agent packages).
- What makes it an "OS" vs. a "framework": kernel-level resource metering (WASM dual-metered sandbox), Merkle hash-chain audit trail, capability-based access control, 16 independent security layers, 40 channel adapters, native daemon mode with systemd support.
- Use cases that illustrate autonomy: Researcher Hand decomposes questions, searches the web, cross-references, builds a knowledge graph, and delivers a report — all without human prompting.

**Estimated word count:** 500–700

**Diagrams/tables:**
- Table: "Agent OS vs. Agent Framework" — comparing kernel features (scheduling, sandboxing, audit trail, daemon mode) across OpenFang, LangChain, CrewAI, AutoGen, LangGraph

---

## 3. OpenFang vs. OpenClaw — Choosing the Right Tool

- Both are open-source, MIT-licensed, and built for AI agents. But they solve fundamentally different problems.
- **OpenFang:** Rust, single binary, 7 bundled Hands (Researcher, Lead, Collector, Predictor, Twitter, Clip, Browser). Focused on autonomous task execution — agents that run 24/7 on schedules, produce deliverables (research reports, lead lists, OSINT intelligence), build knowledge graphs. Runs as a daemon. Zero-config Hands that just work. 16 security layers, WASM sandbox, 40 channel adapters, 27 LLM providers.
- **OpenClaw:** Node.js/TypeScript, personal AI assistant. Focused on conversational interaction with messaging platform integration (WhatsApp, Telegram, Discord as primary interfaces). Tool orchestration, memory system, cron jobs, sub-agents. Bigger footprint (~500MB, ~6s cold start) but rich ecosystem for conversational AI.
- **Key insight:** OpenFang = autonomous workers. OpenClaw = conversational assistant with tool access. They are complementary, not competing.
- When to use which:
  - OpenFang: You need agents that run autonomously on schedules (daily lead gen, continuous OSINT monitoring, automated research). You want a lightweight daemon that can run on a small EC2 instance. You care deeply about security (WASM sandbox, taint tracking, audit trail).
  - OpenClaw: You want a personal AI assistant on your phone (WhatsApp/Telegram). You need rich conversational memory and context. Your primary interaction model is chat.
  - Both together: OpenFang runs the autonomous backend work (research, monitoring, lead gen). OpenClaw delivers the results conversationally to your messaging platform and handles human-in-the-loop interactions.

**Estimated word count:** 500–600

**Diagrams/tables:**
- Table: "OpenFang vs. OpenClaw" — columns: Language, Binary Size, Cold Start, Primary Mode, Bundled Agents, Security Layers, Channel Adapters, Best For
- (Optional) Diagram: "Using Both Together" — OpenFang autonomously producing results, forwarding to OpenClaw for conversational delivery

---

## 4. Why Deploy on AWS?

- Local deployment works for testing, but autonomous agents need always-on infrastructure. If the Researcher Hand is running daily at 6 AM, your laptop needs to be open.
- **Amazon Bedrock:** Managed LLM access with no infrastructure to manage. Pay per token. No GPU provisioning. Access to Claude, Nova, Llama, and others through a single API with IAM-based authentication.
- **IAM instance profiles:** No static API keys. The EC2 instance obtains temporary, rotating credentials via IMDS. This is more secure than any `.env` file with an `ANTHROPIC_API_KEY`.
- **SSM Session Manager:** Zero inbound ports. No SSH keys. No bastion host. IAM-based access with CloudTrail audit trail. Port forwarding built in.
- **VPC isolation:** Private subnet, no public IP, restricted outbound security group. The agent can reach the internet (it needs to for web research) but nothing can reach it.
- **Cost:** ~$33–65/month for the always-on infrastructure (depending on VPC mode), plus Bedrock token costs (~$3/month for light testing with Claude Sonnet).

**Estimated word count:** 400–500

**Diagrams/tables:**
- Table: "Why AWS?" — Local vs. AWS comparison across Availability, LLM Access, Credential Security, Network Access, Cost

---

## 5. The Bedrock Integration Challenge — The LiteLLM Proxy Pattern

- **The problem:** OpenFang supports 27 LLM providers but has no native Amazon Bedrock driver. Its source code (`drivers/mod.rs`) registers Bedrock models in the catalog but `provider_defaults("bedrock")` returns `None`. The fallback path creates an OpenAI-compatible driver — which sends `Authorization: Bearer` headers. Bedrock requires AWS SigV4 signing. These are incompatible.
- **The solution:** LiteLLM as a sidecar proxy. LiteLLM accepts OpenAI-compatible API calls from OpenFang, translates them to Bedrock API calls with SigV4 signing using the EC2 instance profile credentials (via boto3 credential chain).
- **Model name translation:** OpenFang's model catalog uses names like `bedrock/anthropic.claude-sonnet-4-6`. Bedrock's API expects `anthropic.claude-sonnet-4-6-v1`. LiteLLM's `model_list` config handles the mapping. Also, cross-region inference profiles (e.g., `us.anthropic.claude-sonnet-4-6`) add another layer of name translation.
- **Auth flow walkthrough:** OpenFang → HTTP POST to `litellm:4000/v1/chat/completions` with Bearer token → LiteLLM reads instance profile creds from IMDS → signs request with SigV4 → POST to `bedrock-runtime.us-west-2.amazonaws.com` → response flows back.
- **Why this pattern matters beyond OpenFang:** Any open-source agent framework (LangChain, AutoGen, CrewAI) that speaks the OpenAI API can use this same LiteLLM sidecar pattern to access Bedrock. It is a reusable architecture pattern for running open-source AI tools on AWS.

**Estimated word count:** 500–700

**Diagrams/tables:**
- Diagram: Auth flow — OpenFang → LiteLLM (Bearer token) → IMDS (temp creds) → Bedrock (SigV4) → Response
- Code snippet: `litellm_config.yaml` model_list showing name mapping

---

## 6. Architecture Deep Dive

- **VPC design:** 10.0.0.0/16 VPC, public subnet (NAT Gateway), private subnet (EC2 instance). Single-AZ for dev/test. CDK creates this automatically or reuses an existing VPC.
- **EC2 instance:** t3.medium (2 vCPU, 4GB RAM) or t3.xlarge for build phase. Amazon Linux 2023. No public IP, no SSH key pair. 30GB encrypted gp3 EBS.
- **Docker Compose:** Two containers on a shared Docker network. OpenFang (`:4200`, bound to `127.0.0.1`) and LiteLLM proxy (`:4000`, bound to `127.0.0.1`). Neither port is exposed to the VPC — only accessible via SSM port forwarding.
- **IMDSv2 with hop limit 2:** Critical detail — Docker containers add a network hop. IMDSv2 default hop limit of 1 blocks container access to instance metadata. Setting it to 2 lets LiteLLM reach IMDS for Bedrock credentials.
- **UserData bootstrap:** System packages → Docker + Compose → git clone OpenFang → generate secrets with `openssl rand` → write config files → `docker compose up --build` → activate Researcher Hand.
- **Access model:** Operator's workstation → AWS CLI → SSM Session Manager (HTTPS, IAM-authenticated) → port forward → `localhost:4200` → OpenFang dashboard.

**Estimated word count:** 600–800

**Diagrams/tables:**
- Architecture diagram: Full VPC layout with public/private subnets, NAT Gateway, EC2 with Docker containers, SSM Session Manager, Bedrock Runtime API (reuse the ASCII diagram from ARCHITECTURE.md but describe it for a visual version)
- Table: EC2 spec summary (instance type, AMI, EBS, placement, key pair)

---

## 7. Security: What We Found in the WAF Review

- Frame this section as educational: "Before deploying any AI agent system to production, run it through the AWS Well-Architected Framework Security Pillar. Here is what we found."
- **What was already good (score: 7/10 for IAM and Infrastructure):**
  - Zero inbound ports — nothing can connect to the instance
  - IMDSv2 enforced — prevents SSRF-based credential theft
  - Instance profile — no static AWS credentials anywhere
  - Least-privilege IAM — only `bedrock:InvokeModel` and `InvokeModelWithResponseStream`
  - Encrypted EBS at rest
  - Docker ports bound to localhost only
  - No SSH keys
- **What was missing (score: 2-3/10 for Detection and Incident Response):**
  - No VPC Flow Logs (no network traffic visibility for an agent with `web_fetch` and `shell_exec`)
  - No centralized logging (container logs only on local disk)
  - No CloudWatch Alarms (CPU, status check, Bedrock errors)
  - No alerting (no SNS topic, no email notifications)
  - Hardcoded LiteLLM master key (same string in 4 places)
  - Unpinned container images (supply chain risk)
  - No backups (knowledge graph and research data on single EBS volume)
- **How we fixed the critical + high findings:**
  - VPC Flow Logs → CloudWatch Logs with 30-day retention
  - CloudWatch Alarms for StatusCheckFailed and High CPU → SNS topic
  - LiteLLM key generated dynamically with `openssl rand -hex 32`
  - LiteLLM image pinned to `main-v1.65.0`
  - Stack termination protection enabled
- **Takeaway for any agent deployment:** AI agents with autonomous internet access and shell execution are a different threat model than a web application. Detection controls (logging, monitoring, alerting) are non-negotiable. Treat the agent like an intern with root access — trust but verify, and keep the audit trail.

**Estimated word count:** 700–900

**Diagrams/tables:**
- Table: WAF Security Pillar scores — 5 areas (IAM, Detection, Infrastructure, Data Protection, Incident Response) with before/after scores
- Table: Critical + High findings summary with remediation status (Fixed / Accepted / Deferred)

---

## 8. Deploying It Yourself — CDK Walkthrough

- **Prerequisites:** Node.js >= 18, AWS CDK CLI, AWS credentials with VPC/EC2/IAM permissions, CDK bootstrapped, SSM Session Manager plugin installed.
- **Mode 1 — New VPC:** `npx cdk deploy` — creates VPC, NAT Gateway, subnets, EC2, IAM, security group. Full self-contained deployment. ~$65/month.
- **Mode 2 — Existing VPC:** `npx cdk deploy -c vpcId=vpc-xxx` — reuses existing VPC and NAT. Only creates EC2 + IAM + SG. ~$33/month.
- **Context variables:** `vpcId`, `instanceType`, `bedrockRegion` — customizable at deploy time.
- **Connecting:** SSM shell access, port forwarding for dashboard, checking container status, getting the auto-generated API key.
- **Testing the Researcher Hand:** Activate, run a research query, observe the multi-phase execution (decompose → search → fetch → cross-reference → report → knowledge graph).
- **Tear down:** `npx cdk destroy` — removes everything.

**Estimated word count:** 400–500

**Diagrams/tables:**
- Table: Cost breakdown for Mode 1 vs. Mode 2
- Table: Context variables with defaults and descriptions
- Code snippets: deploy commands, SSM connect, port forward, hand activation

---

## 9. What We Learned — Practical Gotchas

- **Rust compilation OOM on t3.medium:** OpenFang's 14 Rust crates need ~4GB+ to compile. t3.medium has 4GB RAM. Solution: allocate 4GB swap space in UserData before the Docker build. Without this, `cargo build` gets OOM-killed silently during `docker compose up --build`.
- **Model name translation is a three-layer problem:** OpenFang model catalog names (`bedrock/anthropic.claude-sonnet-4-6`) differ from Bedrock model IDs (`anthropic.claude-sonnet-4-6-v1`) which differ from cross-region inference profile IDs (`us.anthropic.claude-sonnet-4-6`). LiteLLM's `model_list` bridges this, but getting the mapping wrong produces cryptic 400 errors from Bedrock.
- **Docker networking and loopback binding:** Both containers bind to `127.0.0.1` on the host for security. But inter-container communication uses the Docker network (service name `litellm`). The `base_url` in OpenFang's config must use `http://litellm:4000/v1` (Docker DNS), not `http://localhost:4000/v1` (host loopback). This trips up everyone the first time.
- **IMDSv2 hop limit = 2:** Mentioned in architecture but worth emphasizing. Docker adds a network hop. Default hop limit of 1 means LiteLLM cannot reach IMDS for credentials. Result: `NoCredentialsError` from boto3 inside the container. The fix is one line in CDK: `HttpPutResponseHopLimit: 2`.
- **Researcher Hand needs Python:** Phase 0 of the Researcher Hand runs `python -c "import platform; print(platform.system())"` for platform detection. The Debian slim runtime image does not include Python. Solution: patch the Dockerfile to add `python3-minimal` (~25MB). Without it, the detection fails gracefully, but it is better to fix it.
- **DuckDuckGo as zero-config search:** The Researcher Hand supports Tavily, Brave, and Perplexity for web search but all require API keys. DuckDuckGo is the fallback and needs no key. It works for dev/test but may hit rate limits under heavy use. Brave Search offers 2,000 free queries/month as a step up.

**Estimated word count:** 500–700

**Diagrams/tables:**
- (Optional) Table: "Gotcha → Symptom → Fix" quick reference

---

## 10. Conclusion

- The Agent OS landscape is early. OpenFang (v0.1.0, February 2026) represents a new category — autonomous agents that run as OS-level daemons, not chatbot sessions.
- AWS provides the secure, scalable foundation these systems need: Bedrock for managed LLM access without GPU provisioning, IAM for credential-free authentication, VPC for network isolation, SSM for zero-port access.
- The LiteLLM sidecar pattern is reusable — any open-source agent framework that speaks the OpenAI API can use this approach to integrate with Bedrock.
- The WAF security review is a template for evaluating any agent deployment. Detection controls and incident response are where most teams underinvest.
- Call to action: Try the deployment (link to GitHub repo). Run your own WAF review. Contribute to OpenFang. Share what you build.

**Estimated word count:** 200–300

**Diagrams/tables:** None

---

## Appendix: Visual Assets Needed

| # | Asset | Type | Section |
|---|-------|------|---------|
| 1 | Agent OS vs. Framework comparison table | Table | Section 2 |
| 2 | OpenFang vs. OpenClaw comparison table | Table | Section 3 |
| 3 | Local vs. AWS comparison table | Table | Section 4 |
| 4 | Auth flow diagram (OpenFang → LiteLLM → IMDS → Bedrock) | Diagram | Section 5 |
| 5 | LiteLLM config code snippet | Code | Section 5 |
| 6 | Full VPC architecture diagram | Diagram | Section 6 |
| 7 | EC2 spec summary table | Table | Section 6 |
| 8 | WAF scores table (before/after) | Table | Section 7 |
| 9 | Findings + remediation table | Table | Section 7 |
| 10 | Cost breakdown table (Mode 1 vs Mode 2) | Table | Section 8 |
| 11 | Gotcha reference table | Table | Section 9 |
