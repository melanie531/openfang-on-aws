
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
