import aws_cdk as cdk
from aws_cdk.assertions import Template

from stacks.workflow_results_stack import WorkflowResultsStack


def _template() -> Template:
    app = cdk.App()
    stack = WorkflowResultsStack(
        app, "Test", log_group_name="/github/workflow-results", retention="ONE_YEAR"
    )
    return Template.from_stack(stack)


def test_log_group_created():
    _template().has_resource(
        "AWS::Logs::LogGroup",
        {
            "Properties": {"LogGroupName": "/github/workflow-results", "RetentionInDays": 365},
            "DeletionPolicy": "Retain",
        },
    )


def test_writer_policy_created():
    _template().resource_count_is("AWS::IAM::ManagedPolicy", 1)
