const { execFile } = require('child_process');
const path = require('path');
const { parseDiffRaw, parseGitHubRemote } = require('./model');

// The extension host has no terminal: fail fast instead of waiting for a credential prompt.
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: ENV, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

async function exists(root, ref, relPath) {
  try {
    await git(root, ['cat-file', '-e', `${ref}:${relPath}`]);
    return true;
  } catch {
    return false;
  }
}

async function hasCommit(root, sha) {
  try {
    await git(root, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function mergeBase(root, base, head) {
  return (await git(root, ['merge-base', base, head])).trim();
}

async function diffFiles(root, base, head) {
  const from = await mergeBase(root, base, head);
  const args = ['diff', '--raw', '-z', '-M', '--no-abbrev', '--no-color', '--no-ext-diff', from, head];
  return parseDiffRaw(await git(root, args));
}

// Worktrees share objects and refs with the main checkout, and the main checkout outlives them.
async function repoRoot(dir) {
  const out = await git(dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']);
  const [top, common] = out.trim().split('\n');
  return path.basename(common) === '.git' ? path.dirname(common) : top;
}

async function remotes(root) {
  const list = [];
  for (const line of (await git(root, ['remote', '-v'])).split('\n')) {
    const m = /^(\S+)\t(\S+) \(fetch\)$/.exec(line);
    const slug = m && parseGitHubRemote(m[2]);
    if (slug) list.push({ name: m[1], slug });
  }
  return list;
}

module.exports = { git, exists, hasCommit, mergeBase, diffFiles, repoRoot, remotes };
