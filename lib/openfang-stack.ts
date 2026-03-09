import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cw_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as fs from "fs";
import * as path from "path";

export class OpenFangStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, { ...props, terminationProtection: true });

    // ── Context variables ──────────────────────────────────────────
    const existingVpcId = this.node.tryGetContext("vpcId") as
      | string
      | undefined;
    const instanceType =
      (this.node.tryGetContext("instanceType") as string) ?? "t3.xlarge";
    const bedrockRegion =
      (this.node.tryGetContext("bedrockRegion") as string) ?? "us-west-2";

    // ── Alert email parameter ────────────────────────────────────
    const alertEmailParam = new cdk.CfnParameter(this, "AlertEmail", {
      type: "String",
      description:
        "Email address for CloudWatch alarm notifications (leave empty to skip)",
      default: "",
    });

    // ── VPC: create new or use existing ────────────────────────────
    let vpc: ec2.IVpc;

    if (existingVpcId) {
      vpc = ec2.Vpc.fromLookup(this, "Vpc", { vpcId: existingVpcId });
    } else {
      vpc = new ec2.Vpc(this, "Vpc", {
        ipAddresses: ec2.IpAddresses.cidr("10.0.0.0/16"),
        maxAzs: 2,
        natGateways: 1,
        subnetConfiguration: [
          {
            name: "Public",
            subnetType: ec2.SubnetType.PUBLIC,
            cidrMask: 24,
          },
          {
            name: "Private",
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            cidrMask: 24,
          },
        ],
      });
    }

    // ── VPC Flow Logs ──────────────────────────────────────────────
    const flowLogGroup = new logs.LogGroup(this, "VpcFlowLogGroup", {
      logGroupName: "/openfang/vpc-flow-logs",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const flowLogRole = new iam.Role(this, "VpcFlowLogRole", {
      assumedBy: new iam.ServicePrincipal("vpc-flow-logs.amazonaws.com"),
      description:
        "IAM role for VPC Flow Logs to publish to CloudWatch Logs",
    });

    flowLogGroup.grantWrite(flowLogRole);

    new ec2.FlowLog(this, "VpcFlowLog", {
      resourceType: ec2.FlowLogResourceType.fromVpc(vpc),
      trafficType: ec2.FlowLogTrafficType.ALL,
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        flowLogGroup,
        flowLogRole
      ),
    });

    // ── Security Group ─────────────────────────────────────────────
    const sg = new ec2.SecurityGroup(this, "OpenFangSg", {
      vpc,
      description: "OpenFang EC2 - no inbound, restricted outbound",
      allowAllOutbound: false,
    });

    // Outbound: HTTPS (Bedrock, SSM, web_search, web_fetch)
    sg.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "HTTPS - Bedrock SSM web_search web_fetch"
    );

    // Outbound: HTTP (some web_fetch targets)
    sg.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "HTTP - web_fetch fallback"
    );

    // Outbound: DNS (UDP + TCP)
    sg.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udp(53),
      "DNS resolution (UDP)"
    );
    sg.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(53),
      "DNS resolution (TCP)"
    );

    // ── IAM Role ───────────────────────────────────────────────────
    const role = new iam.Role(this, "OpenFangRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "OpenFang EC2 instance role - Bedrock and SSM",
    });

    // SSM Session Manager
    role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "AmazonSSMManagedInstanceCore"
      )
    );

    // Bedrock invoke — least privilege, inference profiles + foundation models
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "BedrockInvokeModels",
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ],
        resources: [
          // Foundation models - all regions (LiteLLM cross-region routing)
          "arn:aws:bedrock:*::foundation-model/anthropic.claude-*",
          "arn:aws:bedrock:*::foundation-model/amazon.nova-*",
          // Cross-region inference profiles
          `arn:aws:bedrock:*:${this.account}:inference-profile/us.anthropic.claude-*`,
          `arn:aws:bedrock:*:${this.account}:inference-profile/us.amazon.nova-*`,
        ],
      })
    );

    // ── EC2 Instance ───────────────────────────────────────────────
    const userData = ec2.UserData.forLinux();
    const userDataScript = fs.readFileSync(
      path.join(__dirname, "user-data.sh"),
      "utf8"
    );
    userData.addCommands(userDataScript);

    const instance = new ec2.Instance(this, "OpenFangInstance", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: new ec2.InstanceType(instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.X86_64,
      }),
      securityGroup: sg,
      role,
      userData,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(30, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
      requireImdsv2: true,
      propagateTagsToVolumeOnCreation: true,
    });

    // Set IMDSv2 hop limit to 2 for Docker container metadata access
    const cfnInstance = instance.node.defaultChild as ec2.CfnInstance;
    cfnInstance.addPropertyOverride(
      "MetadataOptions.HttpPutResponseHopLimit",
      2
    );

    // ── SNS Topic for Alerts ────────────────────────────────────────
    const alertTopic = new sns.Topic(this, "OpenFangAlerts", {
      topicName: "OpenFangAlerts",
      displayName: "OpenFang Alerts",
    });

    // ── CloudWatch Alarm: StatusCheckFailed ──────────────────────────
    const statusCheckAlarm = new cloudwatch.Alarm(
      this,
      "StatusCheckFailedAlarm",
      {
        alarmName: "OpenFang-StatusCheckFailed",
        alarmDescription: "EC2 instance status check has failed",
        metric: new cloudwatch.Metric({
          namespace: "AWS/EC2",
          metricName: "StatusCheckFailed",
          dimensionsMap: {
            InstanceId: instance.instanceId,
          },
          period: cdk.Duration.seconds(60),
          statistic: "Maximum",
        }),
        threshold: 1,
        evaluationPeriods: 2,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      }
    );
    statusCheckAlarm.addAlarmAction(new cw_actions.SnsAction(alertTopic));

    // ── CloudWatch Alarm: High CPU ──────────────────────────────────
    const cpuAlarm = new cloudwatch.Alarm(this, "HighCpuAlarm", {
      alarmName: "OpenFang-HighCPU",
      alarmDescription: "EC2 CPU utilization exceeds 80 percent",
      metric: new cloudwatch.Metric({
        namespace: "AWS/EC2",
        metricName: "CPUUtilization",
        dimensionsMap: {
          InstanceId: instance.instanceId,
        },
        period: cdk.Duration.seconds(300),
        statistic: "Average",
      }),
      threshold: 80,
      evaluationPeriods: 3,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.MISSING,
    });
    cpuAlarm.addAlarmAction(new cw_actions.SnsAction(alertTopic));

    // ── Tags ───────────────────────────────────────────────────────
    cdk.Tags.of(instance).add("Project", "openfang");
    cdk.Tags.of(instance).add("Component", "agent-os");

    // ── Outputs ────────────────────────────────────────────────────
    new cdk.CfnOutput(this, "InstanceId", {
      value: instance.instanceId,
      description: "OpenFang EC2 instance ID (use with SSM Session Manager)",
    });

    new cdk.CfnOutput(this, "SSMConnectCommand", {
      value: `aws ssm start-session --target ${instance.instanceId} --region ${this.region}`,
      description: "Command to connect via SSM Session Manager",
    });

    new cdk.CfnOutput(this, "SSMPortForwardCommand", {
      value: [
        "aws ssm start-session",
        `--target ${instance.instanceId}`,
        "--document-name AWS-StartPortForwardingSession",
        `--parameters '{"portNumber":["4200"],"localPortNumber":["4200"]}'`,
        `--region ${this.region}`,
      ].join(" "),
      description:
        "Command to port-forward OpenFang dashboard to localhost:4200",
    });

    if (!existingVpcId) {
      new cdk.CfnOutput(this, "VpcId", {
        value: vpc.vpcId,
        description: "VPC ID (created by this stack)",
      });
    }
  }
}
