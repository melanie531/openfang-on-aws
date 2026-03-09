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
