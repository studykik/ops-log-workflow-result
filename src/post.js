'use strict';

const {
  getState, currentJob, runEnvironments, deploymentGroup, logResult,
} = require('./lib');

async function run() {
  if (getState('logged') === 'true') return;

  let job = { result: 'unknown' };
  try {
    job = await currentJob();
  } catch (e) {
    console.log(`::warning title=log-workflow-result::Could not determine job result: ${e.message}`);
  }
  const deployment = job.id && (await runEnvironments()).find((e) => e.jobId === job.id);
  logResult(job.result, {
    environment: deployment && deployment.environment,
    deployment_group: deploymentGroup(),
  });
}

run();
