// Validate the GitHub Actions workflow the way GitHub parses it.
//
// GitHub rejects the whole file with "Invalid workflow file ... you have an error
// in your yaml syntax" when a value such as a step name contains ": ", and the
// run is then reported as a failure with no jobs at all. That is easy to miss
// locally, so this check parses the workflow and verifies the parts of the
// structure the project depends on.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workflowPath = path.join(root, '.github', 'workflows', 'tests.yml')

const problems = []
const fail = (message) => problems.push(message)

let document
try {
  document = yaml.load(fs.readFileSync(workflowPath, 'utf8'))
} catch (error) {
  console.error(`invalid YAML in ${path.relative(root, workflowPath)}:`)
  console.error(String(error.message))
  process.exit(1)
}

if (!document || typeof document !== 'object') {
  console.error('the workflow file does not contain a YAML mapping')
  process.exit(1)
}

// js-yaml follows YAML 1.2, where `on` stays a string; guard against a parser
// that resolves it as the boolean `true`.
const triggers = document.on ?? document[true]
if (!triggers || typeof triggers !== 'object') {
  fail('the workflow has no `on:` triggers')
} else {
  for (const required of ['push', 'pull_request', 'workflow_dispatch']) {
    if (!(required in triggers)) fail(`missing trigger: ${required}`)
  }
  const pullRequest = triggers.pull_request
  if (pullRequest && pullRequest.branches && !pullRequest.branches.includes('master')) {
    fail('pull_request does not target master')
  }
}

const jobs = document.jobs
if (!jobs || typeof jobs !== 'object' || Object.keys(jobs).length === 0) {
  fail('the workflow declares no jobs')
}

/** Jobs the documentation promises, and the steps that must run tests. */
const expectedJobs = ['unit', 'windows-integration', 'macos-real-capture']
const testStepPattern = /test|integration/i

for (const jobId of expectedJobs) {
  if (!jobs || !(jobId in jobs)) fail(`missing job: ${jobId}`)
}

for (const [jobId, job] of Object.entries(jobs ?? {})) {
  const where = `job ${jobId}`
  if (typeof job['runs-on'] !== 'string' || job['runs-on'].length === 0) {
    fail(`${where}: missing runs-on`)
  }
  if (!Array.isArray(job.steps) || job.steps.length === 0) {
    fail(`${where}: has no steps`)
    continue
  }

  for (const [index, step] of job.steps.entries()) {
    const label = `${where} step ${index + 1}${step.name ? ` (${step.name})` : ''}`
    if (typeof step.name !== 'string' || step.name.trim().length === 0) {
      fail(`${label}: missing name`)
    }
    const hasUses = typeof step.uses === 'string'
    const hasRun = typeof step.run === 'string'
    if (hasUses === hasRun) {
      fail(`${label}: must have exactly one of uses or run`)
    }
    // A test step must never be allowed to fail silently.
    if (hasRun && testStepPattern.test(step.run) && step['continue-on-error'] === true) {
      fail(`${label}: a test step must not set continue-on-error`)
    }
  }
}

// The real-capture jobs must build the helper and must not skip their assertions.
const macosJob = jobs?.['macos-real-capture']
if (macosJob) {
  const runs = (macosJob.steps ?? []).map((step) => step.run ?? '').join('\n')
  if (!runs.includes('build:native:macos')) {
    fail('job macos-real-capture: does not build the native helper')
  }
  if (!runs.includes('test:integration')) {
    fail('job macos-real-capture: does not run the integration tests')
  }
}

const windowsJob = jobs?.['windows-integration']
if (windowsJob) {
  const runs = (windowsJob.steps ?? []).map((step) => step.run ?? '').join('\n')
  if (!runs.includes('test:integration')) {
    fail('job windows-integration: does not run the integration tests')
  }
}

if (problems.length > 0) {
  console.error(`workflow check failed (${problems.length} problem(s)):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

const summary = Object.entries(jobs)
  .map(([jobId, job]) => `${jobId}: ${job.steps.length} steps`)
  .join(', ')
console.log(`workflow ok: ${Object.keys(jobs).length} jobs (${summary})`)
