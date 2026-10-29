'use strict';

const { getState, currentJobResult, logResult } = require('./lib');

async function run() {
  if (getState('logged') === 'true') return;

  let result;
  try {
    result = await currentJobResult();
  } catch (e) {
    console.log(`::warning title=log-workflow-result::Could not determine job result: ${e.message}`);
    result = 'unknown';
  }
  logResult(result);
}

run();
