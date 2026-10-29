'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  resultFromNeeds, resultFromSteps, mainStepsCompleted, jobFromDeploymentUrl, deploymentGroup, buildEvent,
  streamName,
} = require('../src/lib');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('resultFromNeeds', () => {
  const needs = (results) => Object.fromEntries(results.map((r, i) => [`j${i}`, { result: r, outputs: {} }]));
  assert.strictEqual(resultFromNeeds(needs(['success', 'skipped'])).result, 'success');
  assert.strictEqual(resultFromNeeds(needs(['success', 'failure', 'cancelled'])).result, 'failure');
  assert.strictEqual(resultFromNeeds(needs(['cancelled', 'success'])).result, 'cancelled');
  assert.strictEqual(resultFromNeeds(needs(['skipped'])).result, 'skipped');
  assert.deepStrictEqual(resultFromNeeds(needs(['success', 'failure'])).jobs, { j0: 'success', j1: 'failure' });
});

test('resultFromSteps ignores steps still running', () => {
  const step = (status, conclusion) => ({ status, conclusion });
  assert.strictEqual(resultFromSteps([step('completed', 'success'), step('in_progress', null)]), 'success');
  assert.strictEqual(resultFromSteps([step('completed', 'skipped'), step('completed', 'failure')]), 'failure');
  assert.strictEqual(resultFromSteps([step('completed', 'cancelled')]), 'cancelled');
});

test('mainStepsCompleted waits for main steps but not post steps', () => {
  const step = (name, status) => ({ name, status });
  assert.strictEqual(mainStepsCompleted([]), false);
  assert.strictEqual(mainStepsCompleted([step('Run exit 1', 'in_progress'), step('Post Run ./', 'queued')]), false);
  assert.strictEqual(mainStepsCompleted([
    step('Set up job', 'completed'), step('Run exit 1', 'completed'),
    step('Post Run ./', 'in_progress'), step('Complete job', 'queued'),
  ]), true);
});

test('buildEvent includes non-empty details only', () => {
  const env = {
    GITHUB_REPOSITORY: 'o/r', GITHUB_WORKFLOW: 'wf', GITHUB_RUN_ID: '1', GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_TRIGGERING_ACTOR: 'someone',
  };
  const event = buildEvent('success', { jobs: {}, environment: '', deployment_group: undefined }, env);
  assert.strictEqual(event.run_url, 'https://github.com/o/r/actions/runs/1');
  assert.strictEqual(event.triggered_by, 'someone');
  for (const key of ['jobs', 'environment', 'deployment_group']) assert.ok(!(key in event), key);

  const full = buildEvent('failure', { jobs: { a: 'failure' }, environment: 'qa', deployment_group: 'qa-v2' }, env);
  assert.deepStrictEqual(full.jobs, { a: 'failure' });
  assert.strictEqual(full.environment, 'qa');
  assert.strictEqual(full.deployment_group, 'qa-v2');
});

test('jobFromDeploymentUrl', () => {
  assert.deepStrictEqual(
    jobFromDeploymentUrl('https://github.com/o/r/actions/runs/40918722989/job/123605840151'),
    { runId: '40918722989', jobId: 123605840151 },
  );
  assert.strictEqual(jobFromDeploymentUrl('https://example.com/deploy'), null);
  assert.strictEqual(jobFromDeploymentUrl(undefined), null);
});

test('deploymentGroup: action input, then SK_DEPLOYMENT_GROUP, then dispatch inputs', () => {
  const eventPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lwr-')), 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify({ inputs: { deploymentGroupName: 'from-dispatch' } }));
  const saved = process.env['INPUT_DEPLOYMENT-GROUP'];
  try {
    delete process.env['INPUT_DEPLOYMENT-GROUP'];
    assert.strictEqual(deploymentGroup({ GITHUB_EVENT_PATH: eventPath }), 'from-dispatch');
    assert.strictEqual(deploymentGroup({ GITHUB_EVENT_PATH: eventPath, SK_DEPLOYMENT_GROUP: 'from-env' }), 'from-env');
    process.env['INPUT_DEPLOYMENT-GROUP'] = 'from-input';
    assert.strictEqual(deploymentGroup({ GITHUB_EVENT_PATH: eventPath, SK_DEPLOYMENT_GROUP: 'from-env' }), 'from-input');
    delete process.env['INPUT_DEPLOYMENT-GROUP'];
    assert.strictEqual(deploymentGroup({ GITHUB_EVENT_PATH: '/nonexistent' }), undefined);
  } finally {
    if (saved === undefined) delete process.env['INPUT_DEPLOYMENT-GROUP'];
    else process.env['INPUT_DEPLOYMENT-GROUP'] = saved;
  }
});

test('streamName is repo/workflow with invalid characters replaced', () => {
  assert.strictEqual(streamName({ GITHUB_REPOSITORY: 'o/r', GITHUB_WORKFLOW: 'Deploy: prod*' }), 'o/r/Deploy_ prod_');
});
