# ops-log-workflow-result

GitHub Action that logs the result of a workflow (or job) to AWS CloudWatch Logs.

Each run writes one JSON log event like:

```json
{"result":"failure","repository":"studykik/my-repo","workflow":"Deploy","job":"deploy",
 "run_id":"123","run_number":"45","run_attempt":"1","event":"push","ref":"refs/heads/master",
 "sha":"abc123","actor":"someone","run_url":"https://github.com/studykik/my-repo/actions/runs/123",
 "timestamp":"2026-10-29T16:27:43Z"}
```

to the log group `/github/workflow-results` in the **region of the job's AWS credentials**, log stream
`<owner>/<repo>/<workflow>`. There is nothing to configure: deploy the `infra/` stack to each region you use
(e.g. `us-west-2` for QA) and the action writes to the group in whichever region the workflow authenticates to.

## Usage

Add the action once, **after** the AWS credentials step. It does nothing up front; when the job finishes —
whether it succeeded, failed or was cancelled — its post step works out the result and logs it.

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

The role needs `logs:CreateLogStream` and `logs:PutLogEvents` on the log group — the `infra/` stack exports a
managed policy for this. Failing to write the log only produces a warning; it never changes the job's result.

### How the result is determined

A post step can't read the `job` context (`job.status`), so it reads the current job's step results from the
GitHub API — hence `actions: read`. It waits until the API shows every step of the job as completed, then
logs `failure` if any step failed, `cancelled` if any was cancelled, otherwise `success`. Each run also gets a
`log-workflow-result` notice annotation showing the result.

Post steps run in reverse order, so placing the action after `configure-aws-credentials` means it runs before
that action's own cleanup and still has credentials.

### Multi-job workflows

The post step logs the result of the job it is in. To log one result for the whole workflow, use it in a final
job and pass `needs`:

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

### Inputs (all optional)

| Input | Default | Description |
|---|---|---|
| `needs` | | `${{ toJSON(needs) }}` — log the overall workflow result immediately instead of the job result. |
| `github-token` | `${{ github.token }}` | Used by the post step to read step results (`actions: read`). |
| `dry-run` | `false` | Build and print the event without sending it. |

Outputs `result` and `payload` are set only when `needs` is given, since a post step can't set outputs.

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
- `.github/workflows/test-action.yml` — runs on every push; unit tests plus both modes in dry-run
  (post-step success/failure is asserted from the run's annotations). No AWS access needed.
- `.github/workflows/test-aws.yml` — manual (`workflow_dispatch`); sends a real event. Needs repo variables
  `AWS_ROLE_ARN` and `AWS_REGION`, and the infra stack deployed.

## Releasing

Releases are cut by semantic-release (`ops-version-and-release.yml`) on every push to `master`, based on
[conventional commit](https://www.conventionalcommits.org/) messages (`fix:` → patch, `feat:` → minor,
`feat!:` / `BREAKING CHANGE:` → major). After a release, run the **Add major tag** workflow
(`ops-add-major-release-tag.yml`) manually to move the `v1` tag to the latest commit.
