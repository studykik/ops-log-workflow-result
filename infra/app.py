#!/usr/bin/env python3
import os

import aws_cdk as cdk

from stacks.workflow_results_stack import WorkflowResultsStack

app = cdk.App()

WorkflowResultsStack(
    app,
    "WorkflowResultsStack",
    log_group_name=app.node.try_get_context("logGroupName"),
    retention=app.node.try_get_context("retention"),
    env=cdk.Environment(
        account=os.getenv("CDK_DEFAULT_ACCOUNT"),
        region=os.getenv("CDK_DEFAULT_REGION"),
    ),
)

app.synth()
