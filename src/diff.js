const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { git, exists } = require('./git');
const { parsePrUrl, prKey: keyOf } = require('./model');

const EMPTY_SCHEME = 'prdiff-empty';
const GIT_SCHEME = 'prdiff-git';

function register(context) {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, {
      provideTextDocumentContent: () => '',
    }),
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, {
      provideTextDocumentContent(uri) {
        const { root, ref } = JSON.parse(uri.query);
        return git(root, ['show', `${ref}:${uri.path.slice(1)}`]);
      },
    }),
  );
}

// `oldPath` is the left side of a rename. The PR key ("owner/repo#N") rides in both URIs, so a
// diff tab can be matched to its PR in the tree, even one VS Code restored after a restart.
async function openDiff(spec, { log, registry }) {
  const { repo, url, base, head, path: relPath, oldPath = relPath, line, title } = spec;
  const prKey = spec.prKey || linkKey(spec);
  if ((!repo && !url) || !base || !head || !relPath) {
    throw new Error('Link must have repo, base, head and path');
  }
  const root = await resolveRoot(spec, registry);

  let mergeBase;
  try {
    mergeBase = (await git(root, ['merge-base', base, head])).trim();
  } catch (e) {
    throw new Error(`Cannot resolve ${base}...${head} in ${root}. Run git fetch? (${e.message.trim()})`);
  }

  const tag = { pr: prKey, file: relPath };
  const side = async (ref, filePath, name) =>
    (await exists(root, ref, filePath))
      ? gitUri(root, ref, filePath, tag)
      : vscode.Uri.from({ scheme: EMPTY_SCHEME, path: `/${filePath}`, query: JSON.stringify({ side: name, ...tag }) });
  const left = await side(mergeBase, oldPath, 'base');
  const right = await side(head, relPath, 'head');

  const label = title || `${path.basename(relPath)} (${shortRef(base)} ↔ ${shortRef(head)})`;
  const options = { preview: false };
  const n = parseInt(line, 10);
  if (n > 0) options.selection = new vscode.Range(n - 1, 0, n - 1, 0);

  log(`diff ${relPath}: ${mergeBase.slice(0, 7)} ↔ ${head} line=${n || '-'}`);
  await vscode.commands.executeCommand('vscode.diff', left, right, label, options);
  return { root };
}

// A worktree removed after the merge leaves its links pointing nowhere, but any known clone
// of the same GitHub repository shares the commits.
async function resolveRoot({ repo, url }, registry) {
  if (repo && fs.existsSync(repo)) return (await git(repo, ['rev-parse', '--show-toplevel'])).trim();
  const parsed = parsePrUrl(url);
  if (parsed && registry) {
    await registry.ready;
    const known = registry.get(parsed.slug);
    if (known) return known.root;
  }
  throw new Error(`Repository folder not found: ${repo}`);
}

function linkKey({ pr, url }) {
  const parsed = parsePrUrl(url);
  return parsed ? keyOf(parsed.slug, Number(pr) || parsed.number) : undefined;
}

// The file path stays in the URI path so the diff editor picks the right language.
function gitUri(root, ref, relPath, tag) {
  return vscode.Uri.from({
    scheme: GIT_SCHEME,
    path: `/${relPath}`,
    query: JSON.stringify({ root, ref, ...tag }),
  });
}

function shortRef(ref) {
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref.replace(/^origin\//, '');
}

module.exports = { register, openDiff, EMPTY_SCHEME, GIT_SCHEME };
