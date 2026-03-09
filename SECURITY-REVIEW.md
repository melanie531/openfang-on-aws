# AWS Well-Architected Security Pillar Review — OpenFang Agent OS Deployment

**Review Date:** 2026-03-09
**Reviewer:** Automated WAF Security Review
**Scope:** CDK Stack (`lib/openfang-stack.ts`), EC2 Bootstrap (`lib/user-data.sh`), Architecture Documentation
**Target Environment:** Dev/Test
**Overall Risk Rating:** MEDIUM

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Security Posture Scores](#security-posture-scores)
3. [Identity and Access Management](#1-identity-and-access-management)
4. [Detection Controls](#2-detection-controls)
5. [Infrastructure Protection](#3-infrastructure-protection)
6. [Data Protection](#4-data-protection)
7. [Incident Response](#5-incident-response)
8. [Summary of Findings by Severity](#summary-of-findings-by-severity)
9. [Prioritized Remediation Roadmap](#prioritized-remediation-roadmap)

---

## Executive Summary

This review evaluates the OpenFang Agent OS deployment on AWS EC2 against the AWS Well-Architected Framework Security Pillar. The deployment consists of a CDK TypeScript stack that provisions an EC2 instance in a private subnet running two Docker containers (OpenFang and LiteLLM proxy) with Amazon Bedrock as the LLM backend.

**Key strengths:**
- Zero inbound ports with SSM Session Manager for access
- IMDSv2 enforced with appropriate hop limit for Docker
- Instance profile for AWS credentials (no static keys)
- Least-privilege Bedrock IAM policy scoped to specific actions and model families
- EBS encryption at rest enabled
- Docker ports bound to localhost only

**Key gaps:**
- No centralized logging (no CloudWatch Logs, no VPC Flow Logs)
- Hardcoded LiteLLM master key across multiple files
- No monitoring or alerting infrastructure
- No backup or recovery procedures
- Unpinned container images and unverified software downloads
- User data script secrets visible in EC2 instance attributes

---

## Security Posture Scores

| Security Area | Score | Rating |
|---|:---:|---|
| 1. Identity and Access Management | **7 / 10** | Good |
| 2. Detection Controls | **3 / 10** | Poor |
| 3. Infrastructure Protection | **7 / 10** | Good |
| 4. Data Protection | **5 / 10** | Moderate |
| 5. Incident Response | **2 / 10** | Critical Gap |
| **Overall** | **4.8 / 10** | **Below Target** |

---

## 1. Identity and Access Management

**Score: 7/10 — Good**

### Finding IAM-01: Bedrock IAM Policy Uses Wildcard Regions

- **Severity:** MEDIUM
- **Current State:** The Bedrock policy at `lib/openfang-stack.ts:101-108` uses `arn:aws:bedrock:*::foundation-model/...` allowing model invocation in any AWS region.
- **Risk:** If an attacker gains access to the instance role, they can invoke models in any region, potentially bypassing region-specific controls or generating unexpected costs. Cross-region invocation also complicates audit trail analysis.
- **Recommendation:** Restrict to the specific Bedrock region(s) being used. If cross-region inference profiles are intentional, enumerate the specific regions.
- **WAF Reference:** SEC03-BP02 — Grant least privilege access

```typescript
// Before (current)
resources: [
  "arn:aws:bedrock:*::foundation-model/anthropic.claude-*",
  "arn:aws:bedrock:*::foundation-model/amazon.nova-*",
  `arn:aws:bedrock:*:${this.account}:inference-profile/us.anthropic.claude-*`,
  `arn:aws:bedrock:*:${this.account}:inference-profile/us.amazon.nova-*`,
],

// After (recommended)
resources: [
  `arn:aws:bedrock:${bedrockRegion}::foundation-model/anthropic.claude-*`,
  `arn:aws:bedrock:${bedrockRegion}::foundation-model/amazon.nova-*`,
  `arn:aws:bedrock:us-east-1:${this.account}:inference-profile/us.anthropic.claude-*`,
  `arn:aws:bedrock:us-east-1:${this.account}:inference-profile/us.amazon.nova-*`,
  `arn:aws:bedrock:us-west-2:${this.account}:inference-profile/us.anthropic.claude-*`,
  `arn:aws:bedrock:us-west-2:${this.account}:inference-profile/us.amazon.nova-*`,
],
```

### Finding IAM-02: No IAM Permissions Boundary

- **Severity:** LOW
- **Current State:** The EC2 instance role (`lib/openfang-stack.ts:80-83`) has no permissions boundary attached.
- **Risk:** Without a boundary, any future policy changes to the role are unconstrained. A misconfigured policy addition could grant broader permissions than intended.
- **Recommendation:** Attach a permissions boundary that caps the maximum allowable permissions for workload roles.
- **WAF Reference:** SEC03-BP04 — Reduce permissions continuously

```typescript
const permissionsBoundary = new iam.ManagedPolicy(this, 'OpenFangBoundary', {
  statements: [
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'ssm:UpdateInstanceInformation',
        'ssmmessages:*',
        'ec2messages:*',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'logs:DescribeLogGroups',
      ],
      resources: ['*'],
    }),
  ],
});

const role = new iam.Role(this, 'OpenFangRole', {
  assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
  permissionsBoundary,
});
```

### Finding IAM-03: No Condition Keys on Bedrock Policy

- **Severity:** LOW
- **Current State:** The Bedrock policy has no condition keys restricting invocation context.
- **Risk:** The policy allows model invocation from any source that can assume the role, without additional constraints such as source VPC or IP.
- **Recommendation:** Add `aws:SourceVpc` or `aws:ViaAWSService` condition keys for defense in depth.
- **WAF Reference:** SEC03-BP02 — Grant least privilege access

```typescript
role.addToPolicy(
  new iam.PolicyStatement({
    sid: 'BedrockInvokeModels',
    effect: iam.Effect.ALLOW,
    actions: [
      'bedrock:InvokeModel',
      'bedrock:InvokeModelWithResponseStream',
    ],
    resources: [/* ... */],
    conditions: {
      StringEquals: {
        'aws:SourceVpc': vpc.vpcId,
      },
    },
  })
);
```

### Finding IAM-04: Broad Model Family Wildcards

- **Severity:** LOW
- **Current State:** Resource ARNs use `anthropic.claude-*` and `amazon.nova-*` wildcards (`lib/openfang-stack.ts:103-107`).
- **Risk:** These wildcards match all current and future models in each family, including expensive frontier models (e.g., Claude Opus). An attacker or misconfiguration could invoke high-cost models.
- **Recommendation:** For tighter cost control, enumerate the specific model IDs actually configured in LiteLLM. Acceptable risk for dev/test.
- **WAF Reference:** SEC03-BP02 — Grant least privilege access

### Positive Observations (IAM)

- **Instance profile used** — No static AWS credentials anywhere in the deployment. LiteLLM obtains temporary credentials via IMDS. *(SEC03-BP06)*
- **SSM Managed Instance Core** — Standard managed policy for Session Manager, well-understood scope. *(SEC03-BP01)*
- **Scoped Bedrock actions** — Only `InvokeModel` and `InvokeModelWithResponseStream`, not `bedrock:*`. *(SEC03-BP02)*
- **Service principal trust** — Role can only be assumed by `ec2.amazonaws.com`. *(SEC03-BP01)*

---

## 2. Detection Controls

**Score: 3/10 — Poor**

### Finding DET-01: No VPC Flow Logs

- **Severity:** HIGH
- **Current State:** The VPC created in `lib/openfang-stack.ts:27-44` has no flow logs enabled.
- **Risk:** No network traffic visibility. Cannot detect anomalous outbound connections, data exfiltration attempts, or lateral movement. This is a critical observability gap for any workload running agent AI with `shell_exec` and `web_fetch` capabilities.
- **Recommendation:** Enable VPC Flow Logs to CloudWatch Logs or S3.
- **WAF Reference:** SEC04-BP01 — Configure service and application logging

```typescript
import * as logs from 'aws-cdk-lib/aws-logs';

const flowLogGroup = new logs.LogGroup(this, 'VpcFlowLogGroup', {
  logGroupName: '/openfang/vpc-flow-logs',
  retention: logs.RetentionDays.THIRTY_DAYS,
  removalPolicy: cdk.RemovalPolicy.DESTROY,
});

vpc.addFlowLog('FlowLog', {
  destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
  trafficType: ec2.FlowLogTrafficType.ALL,
});
```

### Finding DET-02: No Centralized Application Logging

- **Severity:** HIGH
- **Current State:** Container logs are only accessible via `docker compose logs` on the instance. The setup script logs to `/var/log/openfang-setup.log` on the local filesystem (`lib/user-data.sh:2`). No CloudWatch Logs agent is installed or configured.
- **Risk:** If the instance is compromised or terminated, all application logs are lost. Cannot set up log-based alarms or perform centralized analysis. For an AI agent with autonomous web access and shell execution, this is a significant blind spot.
- **Recommendation:** Install the CloudWatch Logs agent and ship container logs plus system logs to CloudWatch.
- **WAF Reference:** SEC04-BP01 — Configure service and application logging

```typescript
// Add CloudWatch Logs policy to the role
role.addToPolicy(
  new iam.PolicyStatement({
    sid: 'CloudWatchLogs',
    effect: iam.Effect.ALLOW,
    actions: [
      'logs:CreateLogGroup',
      'logs:CreateLogStream',
      'logs:PutLogEvents',
      'logs:DescribeLogGroups',
      'logs:DescribeLogStreams',
    ],
    resources: [
      `arn:aws:logs:${this.region}:${this.account}:log-group:/openfang/*`,
    ],
  })
);
```

Add to `lib/user-data.sh`:
```bash
# Install and configure CloudWatch agent
dnf install -y amazon-cloudwatch-agent

cat > /opt/aws/amazon-cloudwatch-agent/etc/config.json << 'CW_EOF'
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/openfang-setup.log",
            "log_group_name": "/openfang/setup",
            "log_stream_name": "{instance_id}"
          }
        ]
      }
    }
  }
}
CW_EOF

# Also configure Docker logging driver to send to CloudWatch
# (add to docker-compose.yml for each service)
```

### Finding DET-03: No CloudWatch Alarms or Monitoring

- **Severity:** HIGH
- **Current State:** No CloudWatch Alarms are defined in the stack. Only basic EC2 monitoring (5-minute intervals) is active by default.
- **Risk:** No alerting on instance health failures, high CPU (which could indicate cryptomining), unusual network traffic patterns, or Bedrock API errors. Operational issues and security incidents will go undetected until manually observed.
- **Recommendation:** Add alarms for key metrics.
- **WAF Reference:** SEC04-BP02 — Analyze logs, findings, and metrics centrally

```typescript
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';

const alertTopic = new sns.Topic(this, 'OpenFangAlerts', {
  displayName: 'OpenFang Security Alerts',
});

// CPU utilization alarm (potential cryptomining detection)
new cloudwatch.Alarm(this, 'HighCpuAlarm', {
  metric: new cloudwatch.Metric({
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    dimensionsMap: { InstanceId: instance.instanceId },
    statistic: 'Average',
    period: cdk.Duration.minutes(5),
  }),
  threshold: 80,
  evaluationPeriods: 3,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
  alarmDescription: 'OpenFang EC2 CPU > 80% for 15 minutes',
});

// Instance status check alarm
new cloudwatch.Alarm(this, 'StatusCheckAlarm', {
  metric: new cloudwatch.Metric({
    namespace: 'AWS/EC2',
    metricName: 'StatusCheckFailed',
    dimensionsMap: { InstanceId: instance.instanceId },
    statistic: 'Maximum',
    period: cdk.Duration.minutes(5),
  }),
  threshold: 1,
  evaluationPeriods: 2,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
  alarmDescription: 'OpenFang EC2 instance status check failed',
});
```

### Finding DET-04: No SSM Session Manager Logging

- **Severity:** MEDIUM
- **Current State:** SSM Session Manager is used for access, but no session logging to S3 or CloudWatch Logs is configured.
- **Risk:** While CloudTrail records session start/stop events, the actual commands run during sessions are not captured. This creates an audit gap for operator actions on the instance.
- **Recommendation:** Configure SSM Session Manager preferences to log session data to S3 or CloudWatch Logs.
- **WAF Reference:** SEC04-BP01 — Configure service and application logging

### Finding DET-05: No GuardDuty Integration

- **Severity:** MEDIUM
- **Current State:** No mention of Amazon GuardDuty in the deployment.
- **Risk:** Missing automated threat detection for the AWS account. GuardDuty would detect compromised instance credentials, unusual API calls, and cryptocurrency mining.
- **Recommendation:** Enable GuardDuty at the account level (not stack-scoped, but should be verified as a prerequisite).
- **WAF Reference:** SEC04-BP03 — Automate response to events

---

## 3. Infrastructure Protection

**Score: 7/10 — Good**

### Finding INF-01: Unpinned LiteLLM Container Image

- **Severity:** HIGH
- **Current State:** The docker-compose.yml in `lib/user-data.sh:107` uses `ghcr.io/berriai/litellm:main-latest`, a mutable tag that tracks the latest build of the main branch.
- **Risk:** Supply chain attack vector. The `main-latest` tag can change at any time. A compromised or buggy LiteLLM release would be automatically pulled on next container restart or instance rebuild. LiteLLM has full access to the instance profile credentials (for Bedrock SigV4 signing), making this a high-impact risk.
- **Recommendation:** Pin to a specific image digest or immutable version tag.
- **WAF Reference:** SEC06-BP02 — Reduce attack surface

```yaml
# Before (current)
image: ghcr.io/berriai/litellm:main-latest

# After (recommended) — pin to specific version
image: ghcr.io/berriai/litellm:main-v1.63.2

# Best — pin to digest
image: ghcr.io/berriai/litellm@sha256:<digest>
```

### Finding INF-02: OpenFang Source Cloned from Unpinned HEAD

- **Severity:** MEDIUM
- **Current State:** `lib/user-data.sh:33` runs `git clone --depth 1 https://github.com/RightNow-AI/openfang.git source` without pinning to a specific commit or tag.
- **Risk:** The cloned source follows the latest `HEAD` of the default branch. A malicious commit or force-push to the OpenFang repository would be built and executed on the next deployment. The Dockerfile is then further modified by `sed` (`lib/user-data.sh:37-38`).
- **Recommendation:** Pin to a specific commit hash or tag.
- **WAF Reference:** SEC06-BP02 — Reduce attack surface

```bash
# Pin to specific commit
git clone --depth 1 https://github.com/RightNow-AI/openfang.git source
cd source && git checkout <known-good-commit-hash> && cd ..
```

### Finding INF-03: Docker Compose Binary Downloaded Without Checksum Verification

- **Severity:** MEDIUM
- **Current State:** `lib/user-data.sh:25-27` downloads Docker Compose from GitHub without verifying the checksum.
- **Risk:** Man-in-the-middle attack during download (though HTTPS mitigates this), or a compromised GitHub release, could inject a malicious binary that would run as root.
- **Recommendation:** Verify the SHA256 checksum after download.
- **WAF Reference:** SEC06-BP02 — Reduce attack surface

```bash
COMPOSE_VERSION="v2.32.4"
COMPOSE_SHA256="<expected-sha256-hash>"
curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
echo "${COMPOSE_SHA256}  /usr/local/lib/docker/cli-plugins/docker-compose" | sha256sum -c -
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
```

### Finding INF-04: Outbound Security Group Could Be Tighter

- **Severity:** LOW
- **Current State:** Outbound rules (`lib/openfang-stack.ts:54-77`) allow HTTPS and HTTP to `0.0.0.0/0`.
- **Risk:** An AI agent with `web_fetch` and `shell_exec` tools inherently needs broad outbound access for research. However, the Bedrock and SSM traffic could be routed through VPC endpoints to reduce the attack surface for exfiltrating data via these specific service paths.
- **Recommendation:** Add VPC endpoints for Bedrock Runtime, SSM, SSMMessages, and EC2Messages. This is an enhancement for production rather than a fix.
- **WAF Reference:** SEC05-BP02 — Control traffic at all layers

```typescript
// VPC Endpoints for reduced NAT dependency and tighter control
vpc.addInterfaceEndpoint('BedrockEndpoint', {
  service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
  subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
});

vpc.addInterfaceEndpoint('SsmEndpoint', {
  service: ec2.InterfaceVpcEndpointAwsService.SSM,
  subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
});

vpc.addInterfaceEndpoint('SsmMessagesEndpoint', {
  service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
  subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
});

vpc.addInterfaceEndpoint('Ec2MessagesEndpoint', {
  service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
  subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
});
```

### Finding INF-05: No Network Policy Between Containers

- **Severity:** LOW
- **Current State:** OpenFang and LiteLLM containers share the default Docker Compose network with unrestricted inter-container communication.
- **Risk:** If the OpenFang container is compromised (e.g., via a malicious agent tool execution), it has full network access to LiteLLM, including its management endpoints. LiteLLM has access to AWS credentials via IMDS.
- **Recommendation:** For production, use Docker network policies or separate networks with explicit allowlisting. Acceptable risk for dev/test given both containers are on localhost.
- **WAF Reference:** SEC05-BP02 — Control traffic at all layers

### Positive Observations (Infrastructure)

- **Private subnet placement** — EC2 instance has no public IP and is in a private subnet. *(SEC05-BP01)*
- **Zero inbound ports** — Security group has no inbound rules; all access is via SSM. *(SEC05-BP02)*
- **IMDSv2 enforced** — `requireImdsv2: true` with hop limit 2 for Docker. Prevents SSRF-based credential theft via IMDSv1. *(SEC06-BP04)*
- **No SSH key pairs** — Eliminates key management risk entirely. *(SEC02-BP05)*
- **Docker ports bound to localhost** — Both `127.0.0.1:4200` and `127.0.0.1:4000` are not exposed on the network interface. *(SEC05-BP02)*
- **Restricted outbound** — Only ports 443, 80, and 53 are allowed outbound, not all traffic. *(SEC05-BP02)*
- **`restrictDefaultSecurityGroup: true`** — CDK context flag in `cdk.json` removes rules from the default VPC security group. *(SEC05-BP02)*

---

## 4. Data Protection

**Score: 5/10 — Moderate**

### Finding DAT-01: Hardcoded LiteLLM Master Key

- **Severity:** HIGH
- **Current State:** The LiteLLM master key `sk-litellm-openfang-internal` is hardcoded in four locations:
  1. `lib/user-data.sh:42` — variable assignment
  2. `lib/user-data.sh:65` — litellm_config.yaml `general_settings.master_key`
  3. `lib/user-data.sh:96` — docker-compose.yml `LITELLM_API_KEY` env var
  4. `lib/user-data.sh:115` — docker-compose.yml `LITELLM_MASTER_KEY` env var
- **Risk:** The key is a static, predictable string that never rotates. It's stored in the CDK source code repository, the EC2 user data (visible via `aws ec2 describe-instance-attribute --attribute userData`), and on disk. Anyone with EC2 describe permissions or instance access can extract it.
- **Recommendation:** Generate the key dynamically (like the OpenFang API key) or store it in AWS Secrets Manager / SSM Parameter Store SecureString.
- **WAF Reference:** SEC08-BP02 — Enforce encryption in transit; SEC09-BP01 — Implement secure key management

```bash
# In user-data.sh — generate dynamically instead of hardcoding
LITELLM_KEY=$(openssl rand -hex 32)
# Then use ${LITELLM_KEY} everywhere instead of the static string
```

For production, use Secrets Manager:
```typescript
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

const litellmSecret = new secretsmanager.Secret(this, 'LiteLLMKey', {
  description: 'LiteLLM master key for OpenFang proxy',
  generateSecretString: {
    excludePunctuation: true,
    passwordLength: 64,
  },
});

// Grant the instance role read access
litellmSecret.grantRead(role);
```

### Finding DAT-02: User Data Script Exposes Secrets in EC2 Metadata

- **Severity:** HIGH
- **Current State:** The user data script (`lib/user-data.sh`) generates the OpenFang API key and writes it inline. The entire user data is base64-encoded and stored as an EC2 instance attribute.
- **Risk:** Any IAM principal with `ec2:DescribeInstanceAttribute` permission can retrieve the full user data, which contains the dynamically generated API key and the hardcoded LiteLLM key. This is a known AWS anti-pattern for secrets.
- **Recommendation:** Retrieve secrets from Secrets Manager or SSM Parameter Store at runtime within the user data script, rather than generating them inline.
- **WAF Reference:** SEC09-BP02 — Enforce encryption at rest

```bash
# In user-data.sh — fetch from Secrets Manager at runtime
OPENFANG_API_KEY=$(aws secretsmanager get-secret-value \
  --secret-id openfang/api-key \
  --query SecretString --output text \
  --region us-west-2)
```

### Finding DAT-03: No TLS Between OpenFang and LiteLLM

- **Severity:** LOW
- **Current State:** OpenFang communicates with LiteLLM over `http://litellm:4000/v1` (plaintext HTTP) on the Docker internal network (`lib/user-data.sh:75`).
- **Risk:** Traffic between containers is unencrypted. In the current single-host Docker deployment, this traffic stays within the Docker bridge network and never traverses a physical network. Risk is minimal for the current architecture but would become significant if containers are ever separated across hosts.
- **Recommendation:** Acceptable for dev/test on a single host. For production or multi-host deployments, enable TLS on LiteLLM.
- **WAF Reference:** SEC08-BP02 — Enforce encryption in transit

### Finding DAT-04: No EBS Snapshot Policy or Backup

- **Severity:** MEDIUM
- **Current State:** The EBS volume is encrypted (`lib/openfang-stack.ts:133-136`) but there is no snapshot policy, AWS Backup plan, or data retention configuration.
- **Risk:** If the instance or volume is lost (accidental termination, AZ failure, EBS failure), all OpenFang data (knowledge graph, research history, agent state) is permanently lost.
- **Recommendation:** Add an AWS Backup plan or EBS snapshot lifecycle policy.
- **WAF Reference:** SEC09-BP03 — Automate data at rest protection

### Finding DAT-05: OpenFang API Key Stored in Plaintext on Disk

- **Severity:** MEDIUM
- **Current State:** The generated OpenFang API key is written to `/opt/openfang/.env` with `chmod 600` (`lib/user-data.sh:130-133`). It is also embedded in `config.toml` on disk.
- **Risk:** Any process running as root on the instance (including Docker containers with host access) can read the key. The `chmod 600` restricts access to the root user, but root access is the default for SSM sessions and Docker.
- **Recommendation:** For dev/test, the current approach is acceptable with `chmod 600`. For production, store in Secrets Manager and inject at runtime.
- **WAF Reference:** SEC09-BP01 — Implement secure key management

### Positive Observations (Data Protection)

- **EBS encryption at rest** — Root volume uses encrypted gp3 with default AWS-managed key. *(SEC08-BP01)*
- **IMDSv2 required** — Prevents SSRF-based credential theft from the metadata service. *(SEC08-BP03)*
- **Config files mounted read-only** — Both `config.toml:ro` and `litellm_config.yaml:ro` are read-only mounts. *(SEC08-BP01)*
- **OpenFang API key auto-generated** — Uses `openssl rand -hex 32` (256-bit entropy). *(SEC09-BP01)*
- **`.env` file permissions** — `chmod 600` restricts to owner only. *(SEC09-BP01)*
- **Propagate tags to volumes** — `propagateTagsToVolumeOnCreation: true` ensures EBS volumes inherit instance tags for governance. *(SEC08-BP01)*

---

## 5. Incident Response

**Score: 2/10 — Critical Gap**

### Finding IR-01: No Alerting Infrastructure

- **Severity:** CRITICAL
- **Current State:** No SNS topics, CloudWatch Alarms, or notification channels are configured in the stack.
- **Risk:** Security incidents (instance compromise, credential abuse, data exfiltration) will go completely undetected until someone manually inspects the instance. For an AI agent with autonomous internet access and shell execution, the window between compromise and detection could be indefinitely long.
- **Recommendation:** Add SNS topic with email subscription and CloudWatch Alarms for critical metrics.
- **WAF Reference:** SEC10-BP01 — Identify key personnel and external resources; SEC10-BP03 — Prepare forensic capabilities

```typescript
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';

const alertTopic = new sns.Topic(this, 'OpenFangAlerts', {
  displayName: 'OpenFang Security & Ops Alerts',
});

// Add email subscription (parameterize the email)
const alertEmail = this.node.tryGetContext('alertEmail') as string;
if (alertEmail) {
  alertTopic.addSubscription(
    new subscriptions.EmailSubscription(alertEmail)
  );
}
```

### Finding IR-02: No Instance Termination Protection

- **Severity:** MEDIUM
- **Current State:** The EC2 instance at `lib/openfang-stack.ts:120-141` does not set `disableApiTermination`.
- **Risk:** Accidental `cdk destroy` or an IAM principal with `ec2:TerminateInstances` could destroy the instance and its data. No safeguard exists against accidental deletion.
- **Recommendation:** Enable termination protection for production.
- **WAF Reference:** SEC10-BP04 — Develop and test incident response plans

### Finding IR-03: No Automated Recovery

- **Severity:** MEDIUM
- **Current State:** If the instance fails a status check, no automated recovery action is configured.
- **Risk:** A hardware failure or instance health issue requires manual intervention to recover. Downtime is unbounded.
- **Recommendation:** Add an EC2 auto-recovery alarm or use an Auto Scaling Group with min/max/desired of 1.
- **WAF Reference:** SEC10-BP05 — Run game days

```typescript
// Auto-recovery via CloudWatch action
new cloudwatch.Alarm(this, 'AutoRecoveryAlarm', {
  metric: new cloudwatch.Metric({
    namespace: 'AWS/EC2',
    metricName: 'StatusCheckFailed_System',
    dimensionsMap: { InstanceId: instance.instanceId },
    statistic: 'Maximum',
    period: cdk.Duration.minutes(1),
  }),
  threshold: 1,
  evaluationPeriods: 2,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
  alarmDescription: 'Auto-recover OpenFang instance on system status check failure',
  // Note: EC2 auto-recovery action via CfnAlarm or AWS SDK
});
```

### Finding IR-04: No Documented Runbooks

- **Severity:** LOW
- **Current State:** No runbook documentation exists for security incident response, instance recovery, or secret rotation.
- **Risk:** When an incident occurs, responders will have no established procedures, leading to slower response times and potential mistakes.
- **Recommendation:** Document runbooks covering: (1) instance compromise response, (2) credential rotation, (3) data recovery from backups, (4) container image rollback.
- **WAF Reference:** SEC10-BP02 — Develop incident management plans

### Finding IR-05: No AWS Backup Plan

- **Severity:** MEDIUM
- **Current State:** No AWS Backup vault or backup plan is configured. The EBS volume is the sole copy of all OpenFang data.
- **Risk:** Data loss from volume failure, accidental deletion, or ransomware has no recovery path.
- **Recommendation:** Configure AWS Backup with daily snapshots and a 7-day retention policy.
- **WAF Reference:** SEC09-BP03 — Automate data at rest protection

```typescript
import * as backup from 'aws-cdk-lib/aws-backup';

const vault = new backup.BackupVault(this, 'OpenFangBackupVault', {
  backupVaultName: 'openfang-backup-vault',
  removalPolicy: cdk.RemovalPolicy.RETAIN,
});

const plan = new backup.BackupPlan(this, 'OpenFangBackupPlan', {
  backupVault: vault,
});

plan.addRule(backup.BackupPlanRule.daily());

plan.addSelection('OpenFangInstance', {
  resources: [backup.BackupResource.fromEc2Instance(instance)],
});
```

---

## Summary of Findings by Severity

### CRITICAL (1)

| ID | Finding | Area |
|---|---|---|
| IR-01 | No alerting infrastructure | Incident Response |

### HIGH (5)

| ID | Finding | Area |
|---|---|---|
| DET-01 | No VPC Flow Logs | Detection |
| DET-02 | No centralized application logging | Detection |
| DET-03 | No CloudWatch Alarms or monitoring | Detection |
| INF-01 | Unpinned LiteLLM container image | Infrastructure |
| DAT-01 | Hardcoded LiteLLM master key | Data Protection |
| DAT-02 | User data script exposes secrets in EC2 metadata | Data Protection |

### MEDIUM (7)

| ID | Finding | Area |
|---|---|---|
| IAM-01 | Bedrock IAM policy uses wildcard regions | IAM |
| DET-04 | No SSM Session Manager logging | Detection |
| DET-05 | No GuardDuty integration | Detection |
| INF-02 | OpenFang source cloned from unpinned HEAD | Infrastructure |
| INF-03 | Docker Compose binary without checksum verification | Infrastructure |
| DAT-04 | No EBS snapshot policy or backup | Data Protection |
| DAT-05 | OpenFang API key in plaintext on disk | Data Protection |
| IR-02 | No instance termination protection | Incident Response |
| IR-03 | No automated recovery | Incident Response |
| IR-05 | No AWS Backup plan | Incident Response |

### LOW (6)

| ID | Finding | Area |
|---|---|---|
| IAM-02 | No IAM permissions boundary | IAM |
| IAM-03 | No condition keys on Bedrock policy | IAM |
| IAM-04 | Broad model family wildcards | IAM |
| INF-04 | Outbound security group could be tighter with VPC endpoints | Infrastructure |
| INF-05 | No network policy between containers | Infrastructure |
| DAT-03 | No TLS between containers | Data Protection |
| IR-04 | No documented runbooks | Incident Response |

---

## Prioritized Remediation Roadmap

### Phase 1 — Immediate (Before Next Deployment)

These are low-effort, high-impact changes:

1. **Pin LiteLLM image** to a specific version tag (INF-01)
2. **Pin OpenFang git clone** to a specific commit hash (INF-02)
3. **Generate LiteLLM key dynamically** with `openssl rand` instead of hardcoding (DAT-01)
4. **Add VPC Flow Logs** to CloudWatch (DET-01)
5. **Verify Docker Compose download** checksum (INF-03)

### Phase 2 — Short-term (Within 2 Weeks)

These require moderate CDK changes:

6. **Add CloudWatch Logs** agent for container and system logs (DET-02)
7. **Add CloudWatch Alarms** for CPU, status checks, and auto-recovery (DET-03, IR-03)
8. **Add SNS alerting** topic with email subscription (IR-01)
9. **Scope Bedrock IAM policy** to specific regions (IAM-01)
10. **Add AWS Backup plan** for daily EBS snapshots (IR-05, DAT-04)

### Phase 3 — Medium-term (Production Readiness)

These are architectural improvements:

11. **Migrate secrets to Secrets Manager** (DAT-01, DAT-02, DAT-05)
12. **Add VPC endpoints** for Bedrock, SSM, and SSMMessages (INF-04)
13. **Configure SSM Session logging** to S3 (DET-04)
14. **Enable GuardDuty** at account level (DET-05)
15. **Add permissions boundary** to instance role (IAM-02)
16. **Add instance termination protection** (IR-02)
17. **Document incident response runbooks** (IR-04)

---

*This review was conducted against the AWS Well-Architected Framework Security Pillar (2024). Findings are assessed in the context of a dev/test deployment. Production deployments should address all HIGH and CRITICAL findings before go-live.*
