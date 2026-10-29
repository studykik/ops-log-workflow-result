import aws_cdk as cdk
from aws_cdk import aws_iam as iam
from aws_cdk import aws_logs as logs
from constructs import Construct


class WorkflowResultsStack(cdk.Stack):
    """CloudWatch log group that GitHub workflows write their results to."""

    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        *,
        log_group_name: str,
        retention: str,
        **kwargs,
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)

        self.log_group = logs.LogGroup(
            self,
            "WorkflowResultsLogGroup",
            log_group_name=log_group_name,
            retention=logs.RetentionDays[retention],
            removal_policy=cdk.RemovalPolicy.RETAIN,
        )

        # Attach this to whatever role the workflows assume (e.g. via GitHub OIDC).
        self.writer_policy = iam.ManagedPolicy(
            self,
            "WorkflowResultsWriterPolicy",
            description="Allows writing GitHub workflow results to CloudWatch Logs",
            statements=[
                iam.PolicyStatement(
                    actions=["logs:CreateLogStream", "logs:PutLogEvents"],
                    resources=[f"{self.log_group.log_group_arn}:log-stream:*"],
                ),
            ],
        )

        cdk.CfnOutput(self, "LogGroupName", value=self.log_group.log_group_name)
        cdk.CfnOutput(self, "WriterPolicyArn", value=self.writer_policy.managed_policy_arn)

