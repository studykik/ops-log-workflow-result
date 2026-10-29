# ops-log-workflow-result

GitHub Action that logs the result of a workflow (or job) to an AWS CloudWatch log group.

Each run writes one JSON log event like:

```json
{"result":"failure","repository":"studykik/my-repo","workflow":"Deploy","job":"deploy",
 "run_id":"123","run_number":"45","run_attempt":"1","event":"push","ref":"refs/heads/master",
 "sha":"abc123","actor":"someone","run_url":"https://github.com/studykik/my-repo/actions/runs/123",
 "timestamp":"2026-10-29T16:27:43Z"}
```

to the log stream `<owner>/<repo>/<workflow>` (overridable) in the log group `/github/workflow-results` (overridable).

## Usage

The calling job must already have AWS credentials (e.g. via `aws-actions/configure-aws-credentials` with OIDC)
for a role with `logs:CreateLogStream` and `logs:PutLogEvents` on the log group — the `infra/` stack exports a
managed policy for this.

### As the last step of a job

```yaml
permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_ROLE_ARN }}
          aws-region: us-east-1
      # ... your steps ...
      - uses: studykik/ops-log-workflow-result@v1
        if: always()            # run even if earlier steps failed
        with:
          status: ${{ job.status }}
```

### As a final job summarising the whole workflow

```yaml
  log-result:
    needs: [build, test, deploy]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_ROLE_ARN }}
          aws-region: us-east-1
      - uses: studykik/ops-log-workflow-result@v1
        with:
          needs: ${{ toJSON(needs) }}
```

The overall result is `failure` if any job failed, else `cancelled` if any was cancelled, else `skipped`
if all were skipped, else `success`. Per-job results are included in the event under `jobs`.

### Inputs

| Input | Default | Description |
|---|---|---|
| `status` | | Result to log, usually `${{ job.status }}`. |
| `needs` | | `${{ toJSON(needs) }}`; takes precedence over `status`. |
| `log-group-name` | `/github/workflow-results` | Target log group (must exist). |
| `log-stream-name` | `<owner>/<repo>/<workflow>` | Target log stream (created if missing). |
| `aws-region` | env `AWS_REGION` | Region of the log group. |
| `dry-run` | `false` | Build and print the event without sending it. |

### Outputs

`result` — the result logged; `payload` — the JSON event.

## Infrastructure

`infra/` is a CDK (Python, uv) app creating the log group (retained on stack deletion) and a writer managed policy.
Settings live in `infra/cdk.json` context (`logGroupName`, `retention`).

```bash
cd infra
uv sync
uv run pytest
uv run cdk deploy
```

Requires CDK CLI >= 2.1146 for the current `aws-cdk-lib`.

## Tests

- `.github/workflows/test-action.yml` — runs on every push; exercises the action in dry-run mode
  (success, failure, and needs-based derivation). No AWS access needed.
- `.github/workflows/test-aws.yml` — manual (`workflow_dispatch`); sends a real event. Needs repo variables
  `AWS_ROLE_ARN` and `AWS_REGION`, and the infra stack deployed.

## Releasing

Releases are cut by semantic-release (`ops-version-and-release.yml`) on every push to `master`, based on
[conventional commit](https://www.conventionalcommits.org/) messages (`fix:` → patch, `feat:` → minor,
`feat!:` / `BREAKING CHANGE:` → major). After a release, run the **Add major tag** workflow
(`ops-add-major-release-tag.yml`) manually to move the `v1` tag to the latest commit.
