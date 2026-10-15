const vscode = require('vscode');
const { listPrs, viewPr, ensureCommits } = require('./github');
const { diffFiles } = require('./git');
const { buildFileTree, prKey } = require('./model');

const TREE_SCHEME = 'prdiff-tree';
const LINKS_KEY = 'links';
const { Collapsed, Expanded, None } = vscode.TreeItemCollapsibleState;

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
      vscode.window.registerFileDecorationProvider({ provideFileDecoration: decoration }),
    );
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

  refresh() {
    for (const section of this.sections) section.loading = null;
    for (const pr of this.prs.values()) pr.stale = true;
    this.changed.fire();
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

  sectionItem(node) {
    const item = new vscode.TreeItem(node.def.label, node.def.expanded ? Expanded : Collapsed);
    item.id = node.id;
    item.contextValue = 'section';
    return item;
  }

  prItem(node) {
    const { info } = this.prs.get(node.key);
    const item = new vscode.TreeItem(info.title, Collapsed);
    item.id = node.id;
    const repoName = this.registry.list().length > 1 ? info.url.split('/')[4] : '';
    item.description = [`${repoName}#${info.number}`, info.author && info.author.login].filter(Boolean).join(' · ');
    item.iconPath = prIcon(info);
    item.tooltip = prTooltip(info);
    item.contextValue = 'pr';
    return item;
  }

  folderItem(node) {
    const item = new vscode.TreeItem(node.name, Expanded);
    item.id = node.id;
    item.iconPath = vscode.ThemeIcon.Folder;
    item.resourceUri = vscode.Uri.from({ scheme: TREE_SCHEME, path: `/${node.path}` });
    item.contextValue = 'folder';
    return item;
  }

  fileItem(node) {
    const { entry } = node;
    const item = new vscode.TreeItem(node.name, None);
    item.id = node.id;
    item.iconPath = vscode.ThemeIcon.File;
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

function prTooltip(info) {
  const state = prState(info);
  const md = new vscode.MarkdownString();
  md.appendMarkdown('**').appendText(info.title).appendMarkdown('**\n\n');
  md.appendText(`#${info.number} · ${info.author ? info.author.login : 'unknown'} · ${state[0]}${state.slice(1).toLowerCase()}`);
  md.appendMarkdown('\n\n').appendText(`${info.headRefName} → ${info.baseRefName}`);
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
