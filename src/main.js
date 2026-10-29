'use strict';

const {
  getInput, saveState, resultFromNeeds, runEnvironments, deploymentGroup, logResult,
} = require('./lib');

// With `needs` the overall workflow result is logged now; otherwise the job
// result is logged by the post step (post.js) when the job finishes.
async function run() {
  const needs = getInput('needs');
  if (!needs || needs === '{}') {
    console.log('Job result will be logged when the job completes (post step).');
    return;
  }

  const { result, jobs } = resultFromNeeds(JSON.parse(needs));
  const environments = [...new Set((await runEnvironments()).map((e) => e.environment))];
  logResult(result, {
    jobs,
    environment: environments.join(','),
    deployment_group: deploymentGroup(),
  });
  saveState('logged', 'true');
}

run();
