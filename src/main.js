'use strict';

const { getInput, saveState, resultFromNeeds, logResult } = require('./lib');

// With `status` or `needs` the result is logged now; otherwise it is logged
// by the post step (post.js) when the job finishes.
const needs = getInput('needs');
const status = getInput('status');

if (needs && needs !== '{}') {
  const { result, jobs } = resultFromNeeds(JSON.parse(needs));
  logResult(result, jobs);
  saveState('logged', 'true');
} else if (status) {
  logResult(status);
  saveState('logged', 'true');
} else {
  console.log('Job result will be logged when the job completes (post step).');
}
