const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { git, exists } = require('./git');

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

// `oldPath` is the left side of a rename. `prKey` ("owner/repo#N") rides in both URIs, so a
// diff tab can be matched to its PR in the tree, even one VS Code restored after a restart.
async function openDiff({ repo, base, head, path: relPath, oldPath = relPath, line, title, prKey }, log) {
  if (!repo || !base || !head || !relPath) {
    throw new Error('Link must have repo, base, head and path');
  }
  if (!fs.existsSync(repo)) throw new Error(`Repository folder not found: ${repo}`);
  const root = (await git(repo, ['rev-parse', '--show-toplevel'])).trim();

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
