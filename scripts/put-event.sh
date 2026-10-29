#!/usr/bin/env bash
# Sends $PAYLOAD as a single log event to $LOG_GROUP / $LOG_STREAM.
set -euo pipefail

if [[ -n "${INPUT_REGION:-}" ]]; then
  export AWS_REGION="${INPUT_REGION}"
fi

stream="${LOG_STREAM:-}"
if [[ -z "${stream}" ]]; then
  stream="${GH_REPO}/${GH_WORKFLOW}"
fi
# ':' and '*' are not allowed in log stream names.
stream="${stream//[:*]/_}"

if ! err=$(aws logs create-log-stream --log-group-name "${LOG_GROUP}" --log-stream-name "${stream}" 2>&1); then
  if [[ "${err}" != *ResourceAlreadyExistsException* ]]; then
    echo "::error::Failed to create log stream: ${err}"
    exit 1
  fi
fi

events=$(jq -cn --arg msg "${PAYLOAD}" --argjson ts "$(($(date +%s) * 1000))" \
  '[{timestamp: $ts, message: $msg}]')

aws logs put-log-events \
  --log-group-name "${LOG_GROUP}" \
  --log-stream-name "${stream}" \
  --log-events "${events}" \
  --output json > /dev/null

echo "Logged result to ${LOG_GROUP} / ${stream}"
