
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
