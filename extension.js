// Opens a side-by-side diff of one file between the merge base of two refs and the head ref,
// the same view the built-in Git and GitHub Pull Requests extensions show, and shows the
// pull requests of the workspace as a file tree in its own Activity Bar panel.
//
// Triggers:
//   vscode://fallenreds.pr-diff-links/open?repo=<abs path>&base=<ref>&head=<ref>&path=<repo-relative>&line=<n>
//   any *.prdiff file with a JSON object of the same fields (opened from a plain path link)

const vscode = require('vscode');
const fs = require('fs');
const diff = require('./src/diff');
const { Registry } = require('./src/repos');
const { PrTreeProvider } = require('./src/tree');

let log;
let registry;
let tree;

function activate(context) {
  log = vscode.window.createOutputChannel('PR Diff Links');
  context.subscriptions.push(log);

  diff.register(context);
  registry = new Registry(context.globalState);
  scanWorkspace();
  tree = new PrTreeProvider(context, { registry, log: line => log.appendLine(line), openDiff: showDiff });

  context.subscriptions.push(
    vscode.commands.registerCommand('prDiffLinks.refresh', () => tree.refresh()),
    vscode.commands.registerCommand('prDiffLinks.openFile', node => tree.openFile(node)),
    vscode.commands.registerCommand('prDiffLinks.openOnGitHub', node => tree.openOnGitHub(node)),
    vscode.commands.registerCommand('prDiffLinks.push', node =>
      tree.push(node).catch(e => fail(`Push failed: ${e.message.trim()}`)),
    ),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      scanWorkspace();
      tree.refresh();
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

function scanWorkspace() {
  const folders = vscode.workspace.workspaceFolders || [];
  registry.scan(folders.filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath));
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
  await showDiff(spec);
}

async function showDiff(spec) {
  try {
    return await diff.openDiff(spec, line => log.appendLine(line));
  } catch (e) {
    fail(e.message || String(e));
  }
}

function fail(message) {
  log.appendLine(`error: ${message}`);
  vscode.window.showErrorMessage(`PR Diff Links: ${message}`);
}

function deactivate() {}

module.exports = { activate, deactivate };
