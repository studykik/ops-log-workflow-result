'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  resultFromNeeds, resultFromSteps, mainStepsCompleted, buildEvent, streamName,
} = require('../src/lib');

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

test('buildEvent', () => {
  const env = {
    GITHUB_REPOSITORY: 'o/r', GITHUB_WORKFLOW: 'wf', GITHUB_RUN_ID: '1', GITHUB_SERVER_URL: 'https://github.com',
  };
  const event = buildEvent('success', {}, env);
  assert.strictEqual(event.run_url, 'https://github.com/o/r/actions/runs/1');
  assert.ok(!('jobs' in event));
  assert.deepStrictEqual(buildEvent('failure', { a: 'failure' }, env).jobs, { a: 'failure' });
});

test('streamName is repo/workflow with invalid characters replaced', () => {
  assert.strictEqual(streamName({ GITHUB_REPOSITORY: 'o/r', GITHUB_WORKFLOW: 'Deploy: prod*' }), 'o/r/Deploy_ prod_');
});
