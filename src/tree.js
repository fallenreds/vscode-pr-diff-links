const vscode = require('vscode');
const { listPrs, viewPr, ensureCommits } = require('./github');
const { aheadCount, branchSha, diffFiles, hasCommit, localBranches, push } = require('./git');
const { buildFileTree, filesUnder, isViewed, prKey } = require('./model');

const TREE_SCHEME = 'prdiff-tree';
const LINKS_KEY = 'links';
const REFS_POLL_MS = 5000;
const LISTS_POLL_MS = 5 * 60 * 1000;
const { Collapsed, Expanded, None } = vscode.TreeItemCollapsibleState;
const { Checked, Unchecked } = vscode.TreeItemCheckboxState;

const SECTIONS = [
  { id: 'links', label: 'From Links', expanded: true },
  { id: 'mine', label: 'Created By Me', search: 'author:@me' },
  { id: 'review', label: 'Waiting For My Review', search: 'review-requested:@me' },
  { id: 'all', label: 'All Open' },
];

const STATUS = {
  A: ['Added', 'gitDecoration.addedResourceForeground'],
  M: ['Modified', 'gitDecoration.modifiedResourceForeground'],
  D: ['Deleted', 'gitDecoration.deletedResourceForeground'],
  R: ['Renamed', 'gitDecoration.renamedResourceForeground'],
  C: ['Copied', 'gitDecoration.addedResourceForeground'],
};

const PR_ICONS = {
  OPEN: ['git-pull-request', 'charts.green'],
  DRAFT: ['git-pull-request-draft', 'disabledForeground'],
  MERGED: ['git-merge', 'charts.purple'],
  CLOSED: ['git-pull-request-closed', 'charts.red'],
};

// Elements are plain objects cached for the life of the tree. TreeView.reveal walks getParent
// and looks the chain up among what getChildren returned, so the same instances must come back.
// PR data (info, files) is shared by key; each section has its own PR node and file nodes.
class PrTreeProvider {
  constructor(context, { registry, log, openDiff }) {
    this.context = context;
    this.state = context.globalState;
    this.registry = registry;
    this.log = log;
    this.openDiff = openDiff;
    this.prs = new Map();
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    this.sections = SECTIONS.map(def => ({ kind: 'section', id: def.id, def, prNodes: new Map(), children: [] }));
    this.view = vscode.window.createTreeView('prDiffLinks.tree', {
      treeDataProvider: this,
      showCollapseAll: true,
      manageCheckboxStateManually: true,
    });
    context.subscriptions.push(
      this.view,
      this.changed,
      this.view.onDidChangeCheckboxState(e => this.markViewed(e.items)),
      this.view.onDidChangeVisibility(() => this.schedule()),
      { dispose: () => this.stopTimers() },
      vscode.window.registerFileDecorationProvider({ provideFileDecoration: decoration }),
    );
    this.schedule();
  }

  getChildren(node) {
    if (!node) return this.sections;
    if (node.kind === 'section') return this.sectionChildren(node);
    if (node.kind === 'pr') return this.prChildren(node);
    return node.children || [];
  }

  getParent(node) {
    return node.parent;
  }

  getTreeItem(node) {
    if (node.kind === 'section') return this.sectionItem(node);
    if (node.kind === 'pr') return this.prItem(node);
    if (node.kind === 'folder') return this.folderItem(node);
    if (node.kind === 'file') return this.fileItem(node);
    return messageItem(node);
  }

  // Merged and closed PRs do not change, the periodic refresh skips them.
  refresh({ openOnly = false } = {}) {
    for (const section of this.sections) section.loading = null;
    for (const pr of this.prs.values()) {
      if (!openOnly || pr.info.state === 'OPEN') pr.stale = true;
    }
    this.changed.fire();
  }

  // Local refs are cheap to read, so they are polled often: commits made outside VS Code
  // (by Claude in a terminal) show up as ↑N without a refresh. GitHub lists are polled rarely.
  schedule() {
    this.stopTimers();
    if (!this.view.visible) return;
    this.refsTimer = setInterval(() => this.pollRefs(), REFS_POLL_MS);
    this.listsTimer = setInterval(() => this.refresh({ openOnly: true }), LISTS_POLL_MS);
    this.pollRefs();
  }

  stopTimers() {
    clearInterval(this.refsTimer);
    clearInterval(this.listsTimer);
  }

  async pollRefs() {
    if (this.polling) return;
    this.polling = true;
    try {
      const changed = await this.updateLocal([...this.prs.values()]);
      if (changed.length) this.changed.fire(this.prNodes(changed.map(pr => pr.key)));
    } finally {
      this.polling = false;
    }
  }

  // Worktrees share refs, so one for-each-ref per repository covers every checkout.
  // Returns the PRs whose local branch or ↑N changed.
  async updateLocal(prs) {
    const byRoot = new Map();
    for (const pr of prs) {
      const repo = this.registry.get(pr.slug);
      if (!repo) continue;
      if (!byRoot.has(repo.root)) byRoot.set(repo.root, []);
      byRoot.get(repo.root).push(pr);
    }
    const changed = [];
    for (const [root, list] of byRoot) {
      let branches;
      try {
        branches = await localBranches(root);
      } catch (e) {
        this.log(`refs ${root}: ${e.message}`);
        continue;
      }
      for (const pr of list) {
        const sha = pushable(pr.info) ? branches.get(pr.info.headRefName) || null : null;
        const stamp = `${sha} ${pr.info.headRefOid}`;
        if (pr.localStamp === stamp) continue;
        pr.localStamp = stamp;
        pr.localSha = sha;
        pr.ahead = sha && sha !== pr.info.headRefOid ? await countAhead(root, pr.info) : 0;
        changed.push(pr);
      }
    }
    return changed;
  }

  async push(node) {
    const pr = this.prs.get(node.key);
    const repo = pr && this.registry.get(pr.slug);
    if (!repo || !pr.localSha) return;
    const branch = pr.info.headRefName;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Pushing ${branch} to ${repo.remote}…` },
      () => push(repo.root, repo.remote, branch),
    );
    this.log(`pushed ${branch} to ${repo.remote}`);
    await this.reloadPr(pr, await branchSha(repo.root, branch));
  }

  // GitHub can take a moment to move the PR head after a push.
  async reloadPr(pr, expectedHead) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 1500));
      this.upsert(pr.slug, await viewPr(pr.slug, pr.number));
      if (!expectedHead || pr.info.headRefOid === expectedHead) break;
    }
    await this.updateLocal([pr]);
    this.changed.fire(this.prNodes([pr.key]));
  }

  async openFile(node) {
    const pr = this.prs.get(node.key);
    const repo = this.registry.get(pr.slug);
    await this.openDiff({
      repo: repo.root,
      base: pr.info.baseRefOid,
      head: pr.info.headRefOid,
      path: node.entry.path,
      oldPath: node.entry.oldPath,
      prKey: node.key,
    });
  }

  // Viewed marks live only in globalState: { [path]: blob }. A push that changes the file
  // changes its blob, so the mark drops off, the same as on GitHub.
  viewed(key) {
    return this.state.get(`viewed:${key}`, {});
  }

  async markViewed(items) {
    const updates = new Map();
    for (const [node, state] of items) {
      if (!node.files) continue;
      const viewed = updates.get(node.key) || { ...this.viewed(node.key) };
      for (const file of node.files) {
        if (state === Checked) viewed[file.path] = file.blob;
        else delete viewed[file.path];
      }
      updates.set(node.key, viewed);
    }
    for (const [key, viewed] of updates) await this.state.update(`viewed:${key}`, viewed);
    this.changed.fire(this.prNodes([...updates.keys()]));
  }

  prNodes(keys) {
    return this.sections.flatMap(section => keys.map(key => section.prNodes.get(key)).filter(Boolean));
  }

  openOnGitHub(node) {
    const pr = this.prs.get(node.key);
    if (pr) vscode.env.openExternal(vscode.Uri.parse(pr.info.url));
  }

  // --- loading

  async sectionChildren(section) {
    section.loading ??= this.loadSection(section);
    await section.loading;
    return section.children;
  }

  async loadSection(section) {
    await this.registry.ready;
    const { prs, errors } = section.id === 'links' ? await this.loadLinks() : await this.loadList(section.def.search);
    const children = errors.map((text, i) => message(section, `error/${i}`, text, true));
    await this.updateLocal(prs);
    for (const pr of prs) children.push(this.prNode(section, pr));
    if (!children.length) children.push(message(section, 'empty', emptyText(section, this.registry)));
    section.children = children;
  }

  async loadList(search) {
    const prs = [];
    const errors = [];
    await Promise.all(
      this.registry.list().map(async repo => {
        try {
          for (const info of await listPrs(repo.slug, { search })) prs.push(this.upsert(repo.slug, info));
        } catch (e) {
          errors.push(this.registry.list().length > 1 ? `${repo.slug}: ${e.message}` : e.message);
        }
      }),
    );
    return { prs, errors };
  }

  async loadLinks() {
    const results = await Promise.all(
      this.state.get(LINKS_KEY, []).map(async ({ slug, number }) => {
        const known = this.prs.get(prKey(slug, number));
        if (known && !known.stale) return { pr: known };
        try {
          return { pr: this.upsert(slug, await viewPr(slug, number)) };
        } catch (e) {
          return { error: `${slug}#${number}: ${e.message}` };
        }
      }),
    );
    return {
      prs: results.filter(r => r.pr).map(r => r.pr),
      errors: results.filter(r => r.error).map(r => r.error),
    };
  }

  upsert(slug, info) {
    const key = prKey(slug, info.number);
    let pr = this.prs.get(key);
    if (!pr) {
      pr = { key, slug, number: info.number, version: 0 };
      this.prs.set(key, pr);
    }
    pr.info = info;
    pr.stale = false;
    return pr;
  }

  prNode(section, pr) {
    let node = section.prNodes.get(pr.key);
    if (!node) {
      node = { kind: 'pr', id: `${section.id}/${pr.key}`, key: pr.key, parent: section, version: -1 };
      section.prNodes.set(pr.key, node);
    }
    return node;
  }

  async prChildren(node) {
    const pr = this.prs.get(node.key);
    try {
      await this.loadFiles(pr);
    } catch (e) {
      return [message(node, 'error', e.message, true)];
    }
    if (node.version !== pr.version) this.buildChildren(node, pr);
    return node.children;
  }

  // Files come from local git, not from gh: the tree then matches the diff exactly, and
  // the raw diff also gives renames and blob SHAs.
  loadFiles(pr) {
    const head = pr.info.headRefOid;
    if (pr.tree && pr.filesHead === head) return Promise.resolve();
    if (pr.loadingHead !== head) {
      pr.loadingHead = head;
      pr.loading = this.fetchFiles(pr, head).finally(() => {
        if (pr.loadingHead === head) pr.loadingHead = null;
      });
    }
    return pr.loading;
  }

  async fetchFiles(pr, head) {
    const repo = this.registry.get(pr.slug);
    if (!repo) throw new Error(`No local clone of ${pr.slug}: open it in the workspace or click a link from it`);
    await ensureCommits(repo.root, repo.remote, pr.info);
    const files = await diffFiles(repo.root, pr.info.baseRefOid, head);
    pr.tree = buildFileTree(files);
    pr.filesHead = head;
    pr.version++;
  }

  buildChildren(prNode, pr) {
    prNode.byPath = new Map();
    const make = (entry, parent) => {
      const node = {
        kind: entry.type,
        id: `${prNode.id}/${entry.path}`,
        key: prNode.key,
        name: entry.name,
        path: entry.path,
        entry: entry.file,
        files: filesUnder(entry).map(file => file.file),
        parent,
      };
      if (entry.type === 'folder') node.children = entry.children.map(child => make(child, node));
      prNode.byPath.set(entry.path, node);
      return node;
    };
    prNode.children = pr.tree.map(entry => make(entry, prNode));
    if (!prNode.children.length) prNode.children = [message(prNode, 'empty', 'No changed files')];
    prNode.version = pr.version;
  }

  // --- items

  // A folder counts as viewed when every file inside it is.
  checkbox(node) {
    const viewed = this.viewed(node.key);
    const all = node.files.every(file => isViewed(viewed[file.path], file.blob));
    return { state: all ? Checked : Unchecked, tooltip: 'Viewed' };
  }

  sectionItem(node) {
    const item = new vscode.TreeItem(node.def.label, node.def.expanded ? Expanded : Collapsed);
    item.id = node.id;
    item.contextValue = 'section';
    return item;
  }

  prItem(node) {
    const pr = this.prs.get(node.key);
    const { info } = pr;
    const item = new vscode.TreeItem(info.title, Collapsed);
    item.id = node.id;
    const repoName = this.registry.list().length > 1 ? info.url.split('/')[4] : '';
    const ahead = pr.ahead ? ` ↑${pr.ahead}` : '';
    item.description = [`${repoName}#${info.number}`, info.author && info.author.login].filter(Boolean).join(' · ') + ahead;
    item.iconPath = prIcon(info);
    item.tooltip = prTooltip(info, pr);
    item.contextValue = pr.localSha ? 'pr.local' : 'pr';
    return item;
  }

  folderItem(node) {
    const item = new vscode.TreeItem(node.name, Expanded);
    item.id = node.id;
    item.iconPath = vscode.ThemeIcon.Folder;
    item.checkboxState = this.checkbox(node);
    item.resourceUri = vscode.Uri.from({ scheme: TREE_SCHEME, path: `/${node.path}` });
    item.contextValue = 'folder';
    return item;
  }

  fileItem(node) {
    const { entry } = node;
    const item = new vscode.TreeItem(node.name, None);
    item.id = node.id;
    item.iconPath = vscode.ThemeIcon.File;
    item.checkboxState = this.checkbox(node);
    item.resourceUri = vscode.Uri.from({
      scheme: TREE_SCHEME,
      path: `/${entry.path}`,
      query: JSON.stringify({ pr: node.key, status: entry.status }),
    });
    const renamed = entry.oldPath !== entry.path;
    if (renamed) item.description = `← ${entry.oldPath}`;
    item.tooltip = renamed ? `${entry.oldPath} → ${entry.path}` : entry.path;
    item.command = { command: 'prDiffLinks.openFile', title: 'Open Diff', arguments: [node] };
    item.contextValue = 'file';
    return item;
  }
}

function message(parent, name, text, error = false) {
  return { kind: 'message', id: `${parent.id}/!${name}`, parent, text, error };
}

function messageItem(node) {
  const item = new vscode.TreeItem(node.text, None);
  item.id = node.id;
  item.tooltip = node.text;
  item.iconPath = node.error ? new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground')) : new vscode.ThemeIcon('info');
  return item;
}

function emptyText(section, registry) {
  if (section.id === 'links') return 'Pull requests opened from .prdiff links appear here';
  if (!registry.list().length) return 'No GitHub repository in the workspace';
  return 'No pull requests';
}

function prState(info) {
  return info.state === 'OPEN' && info.isDraft ? 'DRAFT' : info.state;
}

function prIcon(info) {
  const [icon, color] = PR_ICONS[prState(info)] || PR_ICONS.OPEN;
  return new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
}

// Pushing a fork branch or a finished PR would not update it.
function pushable(info) {
  return info.state === 'OPEN' && !info.isCrossRepository;
}

// Compared with the PR head on GitHub, not with origin/<branch>, which may be stale.
async function countAhead(root, info) {
  if (!(await hasCommit(root, info.headRefOid))) return 0;
  try {
    return await aheadCount(root, info.headRefOid, info.headRefName);
  } catch {
    return 0;
  }
}

function prTooltip(info, pr) {
  const state = prState(info);
  const md = new vscode.MarkdownString();
  md.appendMarkdown('**').appendText(info.title).appendMarkdown('**\n\n');
  md.appendText(`#${info.number} · ${info.author ? info.author.login : 'unknown'} · ${state[0]}${state.slice(1).toLowerCase()}`);
  md.appendMarkdown('\n\n').appendText(`${info.headRefName} → ${info.baseRefName}`);
  if (pr.ahead) md.appendText(` · ${pr.ahead} local commit${pr.ahead > 1 ? 's' : ''} not pushed`);
  md.appendMarkdown(`\n\n[${info.url}](${info.url})`);
  return md;
}

function decoration(uri) {
  if (uri.scheme !== TREE_SCHEME || !uri.query) return undefined;
  const { status } = JSON.parse(uri.query);
  const [tooltip, color] = STATUS[status] || [];
  return tooltip && new vscode.FileDecoration(status, tooltip, new vscode.ThemeColor(color));
}

module.exports = { PrTreeProvider, TREE_SCHEME };
