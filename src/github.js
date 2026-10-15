const { execFile } = require('child_process');
const { git, hasCommit } = require('./git');

const PR_FIELDS = [
  'number', 'title', 'url', 'state', 'isDraft', 'author', 'isCrossRepository',
  'headRefName', 'headRefOid', 'baseRefName', 'baseRefOid',
].join(',');

function gh(args) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GH_PROMPT_DISABLED: '1' };
    execFile('gh', args, { env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') reject(new Error('gh is not installed or not on PATH'));
      else if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

async function listPrs(slug, { search, state = 'open', limit = 50 } = {}) {
  const args = ['pr', 'list', '--repo', slug, '--state', state, '--limit', String(limit), '--json', PR_FIELDS];
  if (search) args.push('--search', search);
  return JSON.parse(await gh(args));
}

async function viewPr(slug, number) {
  return JSON.parse(await gh(['pr', 'view', String(number), '--repo', slug, '--json', PR_FIELDS]));
}

// Heads pushed by someone else are not in local refs until fetched.
async function ensureCommits(root, remote, pr) {
  if ((await hasCommit(root, pr.headRefOid)) && (await hasCommit(root, pr.baseRefOid))) return;
  const head = `refs/pull/${pr.number}/head`;
  try {
    await git(root, ['fetch', '--no-tags', remote, head, pr.baseRefName]);
  } catch {
    // The base branch may be deleted after the merge, the pull ref stays.
    await git(root, ['fetch', '--no-tags', remote, head]);
  }
}

module.exports = { gh, listPrs, viewPr, ensureCommits };
