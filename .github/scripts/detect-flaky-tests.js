import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const N = 5;
const results = {};

console.log(`Starting flaky test detection. Running test suite ${N} times...`);

for (let i = 0; i < N; i++) {
  console.log(`\n--- Iteration ${i + 1}/${N} ---`);
  try {
    execSync('npm run test -- --reporter=json --outputFile=test-out.json', { stdio: 'inherit' });
  } catch (err) {
    // Tests failed, which is expected for flaky tests. We'll parse the JSON.
    console.log('Test suite had failures in this iteration.');
  }
  
  if (!fs.existsSync('test-out.json')) {
    console.error('test-out.json not found!');
    continue;
  }
  
  const out = JSON.parse(fs.readFileSync('test-out.json', 'utf8'));
  
  if (!out.testResults) {
    console.error('Invalid test-out.json format');
    continue;
  }

  out.testResults.forEach(suite => {
    // Vitest JSON reporter structure
    const assertions = suite.assertionResults || [];
    assertions.forEach(assertion => {
      const testName = [...assertion.ancestorTitles, assertion.title].join(' > ');
      if (!results[testName]) {
        results[testName] = { passes: 0, failures: 0 };
      }
      if (assertion.status === 'passed') {
        results[testName].passes++;
      } else if (assertion.status === 'failed') {
        results[testName].failures++;
      }
    });
  });
}

let flakyFound = false;
let summary = '### ⚠️ Flaky Tests Detected\n\n';
summary += 'The following tests exhibited flaky behavior (both passing and failing in the same run suite):\n\n';

for (const [testName, counts] of Object.entries(results)) {
  if (counts.passes > 0 && counts.failures > 0) {
    flakyFound = true;
    summary += `- **\${testName}**: Passed ${counts.passes} times, Failed ${counts.failures} times.\n`;
    console.log(`FLAKY TEST DETECTED: ${testName} (Passes: ${counts.passes}, Failures: ${counts.failures})`);
  }
}

if (!flakyFound) {
  summary = '### ✅ No Flaky Tests Detected\n\nAll tests passed consistently across all iterations.\n';
  console.log('\nNo flaky tests detected.');
}

// Write the summary to GitHub step summary
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
}

// Write the summary to a file for later steps
fs.writeFileSync('flaky-report.md', summary);

// If running in GitHub Actions, set output
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `flaky_found=${flakyFound ? 'true' : 'false'}\n`);
}

if (flakyFound) {
  process.exit(0); // Exit successfully so we don't fail the workflow, but we detected flaky tests
} else {
  process.exit(0);
}
