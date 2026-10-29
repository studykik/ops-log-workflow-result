'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

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

// Finds the job this action is running in (matched on runner name) and
// derives its result from the steps completed so far.
async function currentJobResult() {
  const env = process.env;
  const token = getInput('github-token');
  const base = `${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    + `/attempts/${env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100`;

  for (let page = 1; ; page++) {
    const res = await fetch(`${base}&page=${page}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    const { jobs } = await res.json();
    if (jobs.length === 0) throw new Error(`No in-progress job found for runner ${env.RUNNER_NAME}`);
    const job = jobs.find((j) => j.status === 'in_progress' && j.runner_name === env.RUNNER_NAME);
    if (job) return resultFromSteps(job.steps || []);
  }
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
  const name = getInput('log-stream-name') || `${env.GITHUB_REPOSITORY}/${env.GITHUB_WORKFLOW}`;
  // ':' and '*' are not allowed in log stream names.
  return name.replace(/[:*]/g, '_');
}

function aws(args) {
  const env = { ...process.env };
  const region = getInput('aws-region');
  if (region) env.AWS_REGION = region;
  return execFileSync('aws', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function putEvent(payload) {
  const group = getInput('log-group-name');
  const stream = streamName();
  try {
    aws(['logs', 'create-log-stream', '--log-group-name', group, '--log-stream-name', stream]);
  } catch (e) {
    if (!String(e.stderr).includes('ResourceAlreadyExistsException')) throw new Error(String(e.stderr));
  }
  const events = JSON.stringify([{ timestamp: Date.now(), message: payload }]);
  aws(['logs', 'put-log-events', '--log-group-name', group, '--log-stream-name', stream,
    '--log-events', events]);
  console.log(`Logged result to ${group} / ${stream}`);
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
  getInput, saveState, getState, resultFromNeeds, resultFromSteps, currentJobResult,
  buildEvent, streamName, logResult,
};
