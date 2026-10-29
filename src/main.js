'use strict';

const { getInput, saveState, resultFromNeeds, logResult } = require('./lib');

// With `needs` the overall workflow result is logged now; otherwise the job
// result is logged by the post step (post.js) when the job finishes.
const needs = getInput('needs');

if (needs && needs !== '{}') {
  const { result, jobs } = resultFromNeeds(JSON.parse(needs));
  logResult(result, jobs);
  saveState('logged', 'true');
} else {
  console.log('Job result will be logged when the job completes (post step).');
}
