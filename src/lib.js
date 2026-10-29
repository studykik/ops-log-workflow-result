'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Same log group name in every region; the region comes from the AWS
// credentials (AWS_REGION, as set by aws-actions/configure-aws-credentials).
const LOG_GROUP = '/github/workflow-results';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getInput(name) {
  return (process.env[`INPUT_${name.toUpperCase()}`] || '').trim();
}

function appendFileCommand(envVar, key, value) {
  const file = process.env[envVar];
  if (file) fs.appendFileSync(file, `${key}=${value}\n`);
}

const setOutput = (key, value) => appendFileCommand('GITHUB_OUTPUT', key, value);
const saveState = (key, value) => appendFileCommand('GITHUB_STATE', key, value);
const getState = (key) => process.env[`STATE_${key}`] || '';

// Overall result from `toJSON(needs)`: any failure -> failure, else any
// cancelled -> cancelled, else all skipped -> skipped, else success.
function resultFromNeeds(needs) {
  const jobs = Object.fromEntries(Object.entries(needs).map(([id, job]) => [id, job.result]));
  const results = Object.values(jobs);
  let result = 'success';
  if (results.includes('failure')) result = 'failure';
  else if (results.includes('cancelled')) result = 'cancelled';
  else if (results.length > 0 && results.every((r) => r === 'skipped')) result = 'skipped';
  return { result, jobs };
}

// Job result from the step list returned by the GitHub jobs API.
function resultFromSteps(steps) {
  const conclusions = steps.filter((s) => s.status === 'completed').map((s) => s.conclusion);
  if (conclusions.includes('failure')) return 'failure';
  if (conclusions.includes('cancelled')) return 'cancelled';
  return 'success';
}

// The jobs API lags behind the runner, so wait until it shows every main
// step of the job as completed (post steps and "Complete job" run later).
function mainStepsCompleted(steps) {
  return steps.length > 0 && steps
    .filter((s) => !s.name.startsWith('Post ') && s.name !== 'Complete job')
    .every((s) => s.status === 'completed');
}

async function githubGet(urlPath) {
  const res = await fetch(`${process.env.GITHUB_API_URL}/repos/${process.env.GITHUB_REPOSITORY}/${urlPath}`, {
    headers: { Authorization: `Bearer ${getInput('github-token')}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchJobs() {
  const env = process.env;
  const jobs = [];
  for (let page = 1; ; page++) {
    const body = await githubGet(
      `actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100&page=${page}`,
    );
    jobs.push(...body.jobs);
    if (jobs.length >= body.total_count || body.jobs.length === 0) return jobs;
  }
}

// Finds the job this action is running in (matched on runner name) and
// derives its result from its steps.
async function currentJob({ attempts = 30, delayMs = 2000 } = {}) {
  let steps = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const job = (await fetchJobs())
      .find((j) => j.status === 'in_progress' && j.runner_name === process.env.RUNNER_NAME);
    steps = (job && job.steps) || [];
    if (mainStepsCompleted(steps)) return { id: job.id, result: resultFromSteps(steps) };
    await sleep(delayMs);
  }
  throw new Error(`Timed out waiting for job steps to complete: ${JSON.stringify(steps)}`);
}

// Parses ".../actions/runs/<run id>/job/<job id>" from a deployment status URL.
function jobFromDeploymentUrl(url) {
  const match = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(url || '');
  return match ? { runId: match[1], jobId: Number(match[2]) } : null;
}

// GitHub environments used by jobs in this run, as [{ environment, jobId }].
// The environment isn't exposed to the job itself, but GitHub creates a
// deployment for each job that uses one, whose status links back to the job.
// Needs the `deployments: read` permission; returns [] if unavailable.
async function runEnvironments() {
  try {
    const deployments = await githubGet(`deployments?sha=${process.env.GITHUB_SHA}&per_page=100`);
    const found = [];
    for (const deployment of deployments) {
      const [status] = await githubGet(`deployments/${deployment.id}/statuses?per_page=1`);
      const job = jobFromDeploymentUrl(status && status.log_url);
      if (job && job.runId === process.env.GITHUB_RUN_ID) {
        found.push({ environment: deployment.environment, jobId: job.jobId });
      }
    }
    return found;
  } catch (e) {
    console.log(`Could not look up GitHub environment: ${e.message}`);
    return [];
  }
}

const DEPLOYMENT_GROUP_INPUTS = ['deployment_group', 'deploymentGroupName', 'groupName', 'deploy_group'];

// Deployment group from the action input, else the SK_DEPLOYMENT_GROUP
// environment variable, else a workflow_dispatch input with a known name.
function deploymentGroup(env = process.env) {
  const fromAction = getInput('deployment-group') || env.SK_DEPLOYMENT_GROUP;
  if (fromAction) return fromAction;
  try {
    const inputs = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')).inputs || {};
    const name = DEPLOYMENT_GROUP_INPUTS.find((n) => inputs[n]);
    return name ? String(inputs[name]) : undefined;
  } catch {
    return undefined;
  }
}

// `details` holds optional fields (jobs, environment, deployment_group);
// empty ones are left out of the event.
function buildEvent(result, details = {}, env = process.env) {
  const event = {
    result,
    repository: env.GITHUB_REPOSITORY,
    workflow: env.GITHUB_WORKFLOW,
    job: env.GITHUB_JOB,
    run_id: env.GITHUB_RUN_ID,
    run_number: env.GITHUB_RUN_NUMBER,
    run_attempt: env.GITHUB_RUN_ATTEMPT,
    event: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    sha: env.GITHUB_SHA,
    actor: env.GITHUB_ACTOR,
    triggered_by: env.GITHUB_TRIGGERING_ACTOR,
    run_url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    timestamp: new Date().toISOString(),
  };
  for (const [key, value] of Object.entries(details)) {
    const empty = value === undefined || value === null || value === ''
      || (typeof value === 'object' && Object.keys(value).length === 0);
    if (!empty) event[key] = value;
  }
  return event;
}

function streamName(env = process.env) {
  // ':' and '*' are not allowed in log stream names.
  return `${env.GITHUB_REPOSITORY}/${env.GITHUB_WORKFLOW}`.replace(/[:*]/g, '_');
}

function aws(args) {
  return execFileSync('aws', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function putEvent(payload) {
  const stream = streamName();
  try {
    aws(['logs', 'create-log-stream', '--log-group-name', LOG_GROUP, '--log-stream-name', stream]);
  } catch (e) {
    if (!String(e.stderr).includes('ResourceAlreadyExistsException')) throw new Error(String(e.stderr));
  }
  const events = JSON.stringify([{ timestamp: Date.now(), message: payload }]);
  aws(['logs', 'put-log-events', '--log-group-name', LOG_GROUP, '--log-stream-name', stream,
    '--log-events', events]);
  console.log(`Logged result to ${LOG_GROUP} / ${stream}`);
}

// Logs the result. Never throws: a logging problem is reported as a warning
// so it can't change the outcome of the job being logged.
function logResult(result, details) {
  const payload = JSON.stringify(buildEvent(result, details));
  console.log(`Workflow result: ${result}`);
  console.log(JSON.stringify(JSON.parse(payload), null, 2));
  console.log(`::notice title=log-workflow-result::${result}`);
  setOutput('result', result);
  setOutput('payload', payload);

  if (getInput('dry-run') === 'true') {
    if (process.env.RUNNER_TEMP) {
      fs.writeFileSync(path.join(process.env.RUNNER_TEMP, 'log-workflow-result.json'), payload);
    }
    return;
  }
  try {
    putEvent(payload);
  } catch (e) {
    console.log(`::warning title=log-workflow-result::Failed to log result to CloudWatch: ${e.message}`);
  }
}

module.exports = {
  getInput, saveState, getState, resultFromNeeds, resultFromSteps, mainStepsCompleted, currentJob,
  jobFromDeploymentUrl, runEnvironments, deploymentGroup, buildEvent, streamName, logResult,
};
