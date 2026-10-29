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

The job needs AWS credentials (e.g. via `aws-actions/configure-aws-credentials` with OIDC) for a role with
`logs:CreateLogStream` and `logs:PutLogEvents` on the log group — the `infra/` stack exports a managed policy for this.
Failing to write the log only produces a warning; it never changes the result of the job.

### As a post step (recommended for single jobs)

Add the action once, **after** the credentials step. It does nothing up front; when the job finishes — whether it
succeeded, failed or was cancelled — its post step looks up the job's step results via the GitHub API and logs them.

```yaml
permissions:
  id-token: write
  contents: read
  actions: read          # lets the post step read the job's step results

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_ROLE_ARN }}
          aws-region: us-west-2
      - uses: studykik/ops-log-workflow-result@v1
      # ... your steps ...
```

Post steps run in reverse order, so placing it after `configure-aws-credentials` means it runs before that
action's own cleanup and still has credentials.

### As an explicit last step

```yaml
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
          aws-region: us-west-2
      - uses: studykik/ops-log-workflow-result@v1
        with:
          needs: ${{ toJSON(needs) }}
```

The overall result is `failure` if any job failed, else `cancelled` if any was cancelled, else `skipped`
if all were skipped, else `success`. Per-job results are included in the event under `jobs`.

### Inputs

| Input | Default | Description |
|---|---|---|
| `status` | | Log this result immediately, usually `${{ job.status }}`. |
| `needs` | | `${{ toJSON(needs) }}`; takes precedence over `status`. |
| _(neither)_ | | Log the job result in the post step. |
| `log-group-name` | `/github/workflow-results` | Target log group (must exist). |
| `log-stream-name` | `<owner>/<repo>/<workflow>` | Target log stream (created if missing). |
| `aws-region` | env `AWS_REGION` | Region of the log group. |
| `github-token` | `${{ github.token }}` | Used by the post step to read step results (`actions: read`). |
| `dry-run` | `false` | Build and print the event without sending it. |

### Outputs

`result` and `payload` (the JSON event) — set only when `status` or `needs` is given, since a post step can't
set outputs. Every mode also adds a `log-workflow-result` notice annotation with the result to the run.

## Infrastructure

`infra/` is a CDK (Python, uv) app creating the log group (retained on stack deletion) and a writer managed policy.
Settings live in `infra/cdk.json` context (`logGroupName`, `retention`, `region`). The stack deploys to `us-west-2` (QA).

```bash
cd infra
uv sync
uv run pytest
uv run cdk deploy
```

Requires CDK CLI >= 2.1146 for the current `aws-cdk-lib`.

## Tests

- `node --test` — unit tests for the result/event logic.
- `.github/workflows/test-action.yml` — runs on every push; unit tests plus all three modes in dry-run
  (post-step success/failure is asserted from the run's annotations). No AWS access needed.
- `.github/workflows/test-aws.yml` — manual (`workflow_dispatch`); sends a real event. Needs repo variables
  `AWS_ROLE_ARN` and `AWS_REGION`, and the infra stack deployed.

## Releasing

Releases are cut by semantic-release (`ops-version-and-release.yml`) on every push to `master`, based on
[conventional commit](https://www.conventionalcommits.org/) messages (`fix:` → patch, `feat:` → minor,
`feat!:` / `BREAKING CHANGE:` → major). After a release, run the **Add major tag** workflow
(`ops-add-major-release-tag.yml`) manually to move the `v1` tag to the latest commit.
