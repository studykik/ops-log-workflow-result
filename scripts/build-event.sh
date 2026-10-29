#!/usr/bin/env bash
# Builds the JSON log event describing the workflow/job result.
# Writes `result` and `payload` to $GITHUB_OUTPUT.
set -euo pipefail

jobs_json='{}'
if [[ -n "${INPUT_NEEDS:-}" && "${INPUT_NEEDS}" != "{}" ]]; then
  # Map of job id -> result, e.g. {"build":"success","test":"failure"}
  jobs_json=$(jq -c 'with_entries(.value = .value.result)' <<<"${INPUT_NEEDS}")
  # Overall result: any failure -> failure, else any cancelled -> cancelled,
  # else all skipped -> skipped, else success.
  result=$(jq -r '
    [.[]] as $r
    | if   ($r | index("failure"))   then "failure"
      elif ($r | index("cancelled")) then "cancelled"
      elif ($r | length > 0 and all(. == "skipped")) then "skipped"
      else "success" end' <<<"${jobs_json}")
elif [[ -n "${INPUT_STATUS:-}" ]]; then
  result="${INPUT_STATUS}"
else
  echo "::error::Either 'status' or 'needs' must be provided"
  exit 1
fi

payload=$(jq -cn \
  --arg result "${result}" \
  --argjson jobs "${jobs_json}" \
  --arg repository "${GH_REPO}" \
  --arg workflow "${GH_WORKFLOW}" \
  --arg job "${GH_JOB}" \
  --arg run_id "${GH_RUN_ID}" \
  --arg run_number "${GH_RUN_NUMBER}" \
  --arg run_attempt "${GH_RUN_ATTEMPT}" \
  --arg event "${GH_EVENT}" \
  --arg ref "${GH_REF}" \
  --arg sha "${GH_SHA}" \
  --arg actor "${GH_ACTOR}" \
  --arg run_url "${GH_SERVER_URL}/${GH_REPO}/actions/runs/${GH_RUN_ID}" \
  --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{result: $result, repository: $repository, workflow: $workflow, job: $job,
    run_id: $run_id, run_number: $run_number, run_attempt: $run_attempt,
    event: $event, ref: $ref, sha: $sha, actor: $actor, run_url: $run_url,
    timestamp: $timestamp}
   + (if $jobs == {} then {} else {jobs: $jobs} end)')

echo "Workflow result: ${result}"
echo "${payload}" | jq .

{
  echo "result=${result}"
  echo "payload=${payload}"
} >> "${GITHUB_OUTPUT}"
