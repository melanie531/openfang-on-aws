#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { OpenFangStack } from "../lib/openfang-stack";

const app = new cdk.App();

new OpenFangStack(app, "OpenFangStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-west-2",
  },
  description: "OpenFang Agent OS on EC2 with Bedrock via LiteLLM proxy",
});
