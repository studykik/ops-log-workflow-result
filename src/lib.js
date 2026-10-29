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

async function fetchJobs() {
  const env = process.env;
  const base = `${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    + `/attempts/${env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100`;
  const jobs = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`${base}&page=${page}`, {
      headers: { Authorization: `Bearer ${getInput('github-token')}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    const body = await res.json();
    jobs.push(...body.jobs);
    if (jobs.length >= body.total_count || body.jobs.length === 0) return jobs;
  }
}

// Finds the job this action is running in (matched on runner name) and
// derives its result from its steps.
async function currentJobResult({ attempts = 30, delayMs = 2000 } = {}) {
  let steps = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const job = (await fetchJobs())
      .find((j) => j.status === 'in_progress' && j.runner_name === process.env.RUNNER_NAME);
    steps = (job && job.steps) || [];
    if (mainStepsCompleted(steps)) return resultFromSteps(steps);
    await sleep(delayMs);
  }
  throw new Error(`Timed out waiting for job steps to complete: ${JSON.stringify(steps)}`);
}

function buildEvent(result, jobs, env = process.env) {
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
    run_url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    timestamp: new Date().toISOString(),
  };
  if (jobs && Object.keys(jobs).length > 0) event.jobs = jobs;
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
function logResult(result, jobs) {
  const payload = JSON.stringify(buildEvent(result, jobs));
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
  getInput, saveState, getState, resultFromNeeds, resultFromSteps, mainStepsCompleted, currentJobResult,
  buildEvent, streamName, logResult,
};
