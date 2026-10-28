// Creates (or updates) the cron-job.org jobs that start the workflow on time. GitHub's own schedule runs hours
// late, but a workflow_dispatch starts within seconds. Run it locally, and again after changing the jobs below:
//
//   node scripts/cron-job-setup.mjs            create the jobs, or update the ones that already exist
//   node scripts/cron-job-setup.mjs --dry-run  show what would be sent, without the tokens
//
// Needs CRONJOB_ORG_API_TOKEN (cron-job.org → Settings → API) and GITHUB_DISPATCH_TOKEN (a fine-grained
// GitHub token for this repo only, with "Actions: Read and write") in .env. Needs Node.js 20.12+.
// cron-job.org keeps the GitHub token to send with each call. Besides starting workflows it can cancel or
// delete runs and their logs and artifacts, and switch workflows off, but it can't read secrets or change code.
import fs from 'node:fs';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const API_BASE = 'https://api.cron-job.org';
const REPO = process.env.GITHUB_REPOSITORY ?? 'balexandre/hourly-electricity-price';
const WORKFLOW = 'deploy.yml';
const BRANCH = 'master';

// Copenhagen time all year, so summer time needs no second set of hours.
// Each job runs at every listed minute of every listed hour; the tries after the first change nothing.
const JOBS = [
    // Tomorrow's prices come out around 13:00
    { title: 'Electricity prices', task: 'prices', hours: [13, 14], minutes: [15, 45] },
    // Switches the afternoon charging back off before it would start again at 12:00
    { title: 'Electricity car', task: 'car', hours: [7, 9], minutes: [0] }
];

const dryRun = process.argv.includes('--dry-run');

function requireEnv(name) {
    if (dryRun) return '<redacted>';
    if (!process.env[name]) throw new Error(`${name} is not set`);
    return process.env[name];
}

const githubToken = requireEnv('GITHUB_DISPATCH_TOKEN');

function jobFor({ title, task, hours, minutes }) {
    return {
        title,
        enabled: true,
        url: `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
        requestMethod: 1, // POST
        // GitHub answers 204 with no body, so only failures have anything worth keeping
        saveResponses: true,
        extendedData: {
            headers: {
                'Authorization': `Bearer ${githubToken}`,
                'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json',
                'User-Agent': 'hourly-electricity-price'
            },
            body: JSON.stringify({ ref: BRANCH, inputs: { task } })
        },
        schedule: { timezone: 'Europe/Copenhagen', expiresAt: 0, hours, minutes, mdays: [-1], months: [-1], wdays: [-1] },
        // Emails the cron-job.org account, e.g. once the GitHub token has expired
        notification: { onFailure: true, onFailureCount: 1, onSuccess: true, onDisable: true }
    };
}

if (dryRun) {
    for (const job of JOBS) console.log(JSON.stringify(jobFor(job), null, 2));
    process.exit(0);
}

const cronToken = requireEnv('CRONJOB_ORG_API_TOKEN');

async function cronJob(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: { 'Authorization': `Bearer ${cronToken}`, 'Content-Type': 'application/json' },
        body: body && JSON.stringify(body)
    });
    if (!response.ok) {
        throw new Error(`cron-job.org ${method} ${path} responded ${response.status}: ${await response.text()}`);
    }
    return response.json();
}

// Matched by title, so running this again updates the jobs instead of adding copies
const { jobs: existing } = await cronJob('/jobs');

for (const job of JOBS) {
    const match = existing.find(j => j.title === job.title);
    if (match) {
        await cronJob(`/jobs/${match.jobId}`, { method: 'PATCH', body: { job: jobFor(job) } });
        console.log(`Updated "${job.title}" (job ${match.jobId}).`);
    } else {
        const { jobId } = await cronJob('/jobs', { method: 'PUT', body: { job: jobFor(job) } });
        console.log(`Created "${job.title}" (job ${jobId}).`);
        // Job creation is limited to one a second
        await new Promise(resolve => setTimeout(resolve, 1100));
    }
}
