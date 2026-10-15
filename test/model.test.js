const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseGitHubRemote,
  parsePrUrl,
  prKey,
  parseDiffRaw,
  buildFileTree,
  filesUnder,
  isViewed,
  isProtected,
} = require('../src/model');

test('parseGitHubRemote reads ssh and https remotes', () => {
  assert.equal(parseGitHubRemote('git@github.com:App-Rents/epicbot.git'), 'App-Rents/epicbot');
  assert.equal(parseGitHubRemote('git@github.com:App-Rents/epicbot'), 'App-Rents/epicbot');
  assert.equal(parseGitHubRemote('ssh://git@github.com/owner/repo.git'), 'owner/repo');
  assert.equal(parseGitHubRemote('ssh://git@github.com:22/owner/repo'), 'owner/repo');
  assert.equal(parseGitHubRemote('https://github.com/fallenreds/vscode-pr-diff-links.git'), 'fallenreds/vscode-pr-diff-links');
  assert.equal(parseGitHubRemote('https://github.com/fallenreds/vscode-pr-diff-links'), 'fallenreds/vscode-pr-diff-links');
  assert.equal(parseGitHubRemote('https://token@github.com/owner/repo.git/'), 'owner/repo');
  assert.equal(parseGitHubRemote('  git@github.com:owner/my.repo.git\n'), 'owner/my.repo');
});

test('parseGitHubRemote returns null for other hosts', () => {
  assert.equal(parseGitHubRemote('git@gitlab.com:owner/repo.git'), null);
  assert.equal(parseGitHubRemote('https://bitbucket.org/owner/repo'), null);
  assert.equal(parseGitHubRemote('https://github.com.evil.io/owner/repo'), null);
  assert.equal(parseGitHubRemote('/srv/git/repo.git'), null);
  assert.equal(parseGitHubRemote(''), null);
  assert.equal(parseGitHubRemote(undefined), null);
});

test('parsePrUrl and prKey', () => {
  assert.deepEqual(parsePrUrl('https://github.com/App-Rents/epicbot/pull/88'), { slug: 'App-Rents/epicbot', number: 88 });
  assert.deepEqual(parsePrUrl('https://github.com/o/r/pull/7/files#diff-abc'), { slug: 'o/r', number: 7 });
  assert.equal(parsePrUrl('https://github.com/o/r/issues/7'), null);
  assert.equal(parsePrUrl(undefined), null);
  assert.equal(prKey('App-Rents/epicbot', 88), 'app-rents/epicbot#88');
});

const z = (...records) => records.join('\0') + '\0';
const BLOB_A = 'a'.repeat(40);
const BLOB_B = 'b'.repeat(40);
const ZERO = '0'.repeat(40);

test('parseDiffRaw reads added, modified, deleted and renamed files', () => {
  const out = z(
    `:000000 100644 ${ZERO} ${BLOB_A} A`, 'api/new file.py',
    `:100644 100644 ${BLOB_A} ${BLOB_B} M`, 'api/app/models.py',
    `:100644 000000 ${BLOB_B} ${ZERO} D`, 'docs/old.md',
    `:100644 100644 ${BLOB_A} ${BLOB_B} R087`, 'src/before name.js', 'src/after name.js',
    `:100644 100755 ${BLOB_A} ${BLOB_A} T`, 'bin/tool',
  );
  assert.deepEqual(parseDiffRaw(out), [
    { status: 'A', path: 'api/new file.py', oldPath: 'api/new file.py', blob: BLOB_A },
    { status: 'M', path: 'api/app/models.py', oldPath: 'api/app/models.py', blob: BLOB_B },
    { status: 'D', path: 'docs/old.md', oldPath: 'docs/old.md', blob: BLOB_B },
    { status: 'R', path: 'src/after name.js', oldPath: 'src/before name.js', blob: BLOB_B },
    { status: 'M', path: 'bin/tool', oldPath: 'bin/tool', blob: BLOB_A },
  ]);
});

test('parseDiffRaw returns nothing for an empty diff', () => {
  assert.deepEqual(parseDiffRaw(''), []);
});

const file = p => ({ status: 'M', path: p, oldPath: p, blob: BLOB_A });
const shape = nodes =>
  nodes.map(n => (n.type === 'folder' ? { [`${n.name}/`]: shape(n.children), path: n.path } : n.name));

test('buildFileTree collapses single-folder chains only', () => {
  const tree = buildFileTree([
    file('api/app/api/webhook_docs.py'),
    file('api/alembic/versions/u5q6_internal_app_id.py'),
    file('api/app/core/models.py'),
    file('docs/DECISIONS.md'),
  ]);
  assert.deepEqual(shape(tree), [
    {
      'api/': [
        { 'alembic/versions/': ['u5q6_internal_app_id.py'], path: 'api/alembic/versions' },
        {
          'app/': [
            { 'api/': ['webhook_docs.py'], path: 'api/app/api' },
            { 'core/': ['models.py'], path: 'api/app/core' },
          ],
          path: 'api/app',
        },
      ],
      path: 'api',
    },
    { 'docs/': ['DECISIONS.md'], path: 'docs' },
  ]);
});

test('buildFileTree merges a top-level chain into one folder', () => {
  const tree = buildFileTree([file('api/app/b.py'), file('api/app/a.py')]);
  assert.deepEqual(shape(tree), [{ 'api/app/': ['a.py', 'b.py'], path: 'api/app' }]);
});

test('buildFileTree puts folders before files, each sorted by name', () => {
  const tree = buildFileTree([
    file('z.txt'),
    file('README.md'),
    file('src/x.js'),
    file('bin/run'),
    file('test_10.py'),
    file('test_2.py'),
    file('a.txt'),
  ]);
  assert.deepEqual(shape(tree), [
    { 'bin/': ['run'], path: 'bin' },
    { 'src/': ['x.js'], path: 'src' },
    'a.txt',
    'README.md',
    'test_2.py',
    'test_10.py',
    'z.txt',
  ]);
});

test('buildFileTree keeps the diff entry on file nodes', () => {
  const entry = { status: 'R', path: 'src/new.js', oldPath: 'src/old.js', blob: BLOB_B };
  const [folder] = buildFileTree([entry]);
  assert.equal(folder.children[0].file, entry);
  assert.deepEqual(filesUnder(folder).map(n => n.path), ['src/new.js']);
});

test('filesUnder walks nested folders', () => {
  const tree = buildFileTree([file('a/b/c.py'), file('a/d.py'), file('a/b/e/f.py')]);
  assert.deepEqual(filesUnder(tree[0]).map(n => n.path).sort(), ['a/b/c.py', 'a/b/e/f.py', 'a/d.py']);
});

test('isViewed matches only the blob that was marked', () => {
  assert.equal(isViewed(BLOB_A, BLOB_A), true);
  assert.equal(isViewed(BLOB_A, BLOB_B), false);
  assert.equal(isViewed(undefined, BLOB_A), false);
  assert.equal(isViewed(undefined, undefined), false);
});

test('isProtected matches branch names exactly', () => {
  const list = ['main', 'master', 'develop', 'stage'];
  assert.equal(isProtected('stage', list), true);
  assert.equal(isProtected('main', list), true);
  assert.equal(isProtected('feat/APPR-143-internal-app-id', list), false);
  assert.equal(isProtected('stage-fix', list), false);
  assert.equal(isProtected('Main', list), false);
  assert.equal(isProtected('main', []), false);
  assert.equal(isProtected('main', undefined), false);
});
