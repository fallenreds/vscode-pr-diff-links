// Opens a side-by-side diff of one file between the merge base of two refs and the head ref,
// the same view the built-in Git and GitHub Pull Requests extensions show.
//
// Triggers:
//   vscode://fallenreds.pr-diff-links/open?repo=<abs path>&base=<ref>&head=<ref>&path=<repo-relative>&line=<n>
//   any *.prdiff file with a JSON object of the same fields (works wherever file:// links work)

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const EMPTY_SCHEME = 'prdiff-empty';
let log;

function activate(context) {
  log = vscode.window.createOutputChannel('PR Diff Links');
  context.subscriptions.push(log);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, {
      provideTextDocumentContent: () => '',
    }),
  );

  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri) {
        log.appendLine(`uri: ${uri.toString(true)}`);
        const q = new URLSearchParams(uri.query);
        run(Object.fromEntries(q.entries()));
      },
    }),
  );

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(handleEditor));
  handleEditor(vscode.window.activeTextEditor);
}

// The .prdiff tab is only a trigger: close it and show the diff instead.
async function handleEditor(editor) {
  if (!editor || !editor.document.uri.fsPath.endsWith('.prdiff')) return;
  const uri = editor.document.uri;
  log.appendLine(`file: ${uri.fsPath}`);
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(uri.fsPath, 'utf8'));
  } catch (e) {
    return fail(`Cannot read ${uri.fsPath}: ${e.message}`);
  }
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString()) {
        await vscode.window.tabGroups.close(tab);
      }
    }
  }
  await run(spec);
}

async function run(spec) {
  try {
    await openDiff(spec);
  } catch (e) {
    fail(e.message || String(e));
  }
}

async function openDiff({ repo, base, head, path: relPath, line, title }) {
  if (!repo || !base || !head || !relPath) {
    throw new Error('Link must have repo, base, head and path');
  }
  const git = vscode.extensions.getExtension('vscode.git').exports.getAPI(1);
  const repository = git.getRepository(vscode.Uri.file(repo)) || (await git.openRepository(vscode.Uri.file(repo)));
  if (!repository) throw new Error(`Not a git repository: ${repo}`);

  let mergeBase;
  try {
    mergeBase = await repository.getMergeBase(base, head);
  } catch (e) {
    throw new Error(`Cannot resolve ${base}...${head} in ${repo}. Run git fetch? (${e.message})`);
  }
  if (!mergeBase) throw new Error(`No merge base for ${base}...${head}. Run git fetch?`);

  const fileUri = vscode.Uri.file(path.join(repository.rootUri.fsPath, relPath));
  const left = (await exists(repository, mergeBase, relPath))
    ? git.toGitUri(fileUri, mergeBase)
    : vscode.Uri.from({ scheme: EMPTY_SCHEME, path: `/${relPath}`, query: 'base' });
  const right = (await exists(repository, head, relPath))
    ? git.toGitUri(fileUri, head)
    : vscode.Uri.from({ scheme: EMPTY_SCHEME, path: `/${relPath}`, query: 'head' });

  const label = title || `${path.basename(relPath)} (${shortRef(base)} ↔ ${shortRef(head)})`;
  const options = { preview: false };
  const n = parseInt(line, 10);
  if (n > 0) options.selection = new vscode.Range(n - 1, 0, n - 1, 0);

  log.appendLine(`diff ${relPath}: ${mergeBase.slice(0, 7)} ↔ ${head} line=${n || '-'}`);
  await vscode.commands.executeCommand('vscode.diff', left, right, label, options);
}

async function exists(repository, ref, relPath) {
  try {
    await repository.getObjectDetails(ref, relPath);
    return true;
  } catch {
    return false;
  }
}

function shortRef(ref) {
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref.replace(/^origin\//, '');
}

function fail(message) {
  log.appendLine(`error: ${message}`);
  vscode.window.showErrorMessage(`PR Diff Links: ${message}`);
}

function deactivate() {}

module.exports = { activate, deactivate };
