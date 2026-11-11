// Pure helpers shared by the tree view. No vscode import: `node --test test/` loads this file directly.

const GITHUB_REMOTE =
  /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;

function parseGitHubRemote(url) {
  const m = GITHUB_REMOTE.exec(String(url || '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

function parsePrUrl(url) {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(String(url || ''));
  return m ? { slug: m[1], number: Number(m[2]) } : null;
}

// GitHub treats owner/repo case-insensitively, links and remotes may spell it differently.
function prKey(slug, number) {
  return `${slug.toLowerCase()}#${number}`;
}

// `git diff --raw -z -M --no-abbrev`: ":<mode> <mode> <blob> <blob> <status>\0<path>\0",
// renames and copies carry two paths, old then new.
function parseDiffRaw(stdout) {
  const parts = stdout.split('\0');
  const files = [];
  let i = 0;
  while (i < parts.length) {
    const meta = parts[i++];
    if (!meta.startsWith(':')) continue;
    const [, , oldBlob, newBlob, statusField] = meta.slice(1).split(' ');
    const letter = statusField[0];
    const status = letter === 'T' ? 'M' : letter;
    const first = parts[i++];
    const twoPaths = letter === 'R' || letter === 'C';
    const filePath = twoPaths ? parts[i++] : first;
    files.push({
      status,
      path: filePath,
      oldPath: first,
      blob: status === 'D' ? oldBlob : newBlob,
    });
  }
  return files;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.name, b.name);

// Folders come first, and a folder whose only child is another folder is merged into it
// ("alembic/versions"), the same way the GitHub Pull Requests tree shows it.
function buildFileTree(files) {
  const root = newFolder('', '');
  for (const file of files) {
    const segments = file.path.split('/');
    let folder = root;
    for (const name of segments.slice(0, -1)) {
      if (!folder.folders.has(name)) {
        folder.folders.set(name, newFolder(name, folder.path ? `${folder.path}/${name}` : name));
      }
      folder = folder.folders.get(name);
    }
    folder.files.push({ type: 'file', name: segments[segments.length - 1], path: file.path, file });
  }
  return children(root);
}

function newFolder(name, path) {
  return { name, path, folders: new Map(), files: [] };
}

function children(folder) {
  const folders = [...folder.folders.values()].map(collapse).sort(byName);
  return [...folders, ...folder.files.sort(byName)];
}

function collapse(folder) {
  let name = folder.name;
  while (folder.files.length === 0 && folder.folders.size === 1) {
    folder = folder.folders.values().next().value;
    name = `${name}/${folder.name}`;
  }
  return { type: 'folder', name, path: folder.path, children: children(folder) };
}

function filesUnder(node) {
  if (node.type === 'file') return [node];
  return node.children.flatMap(filesUnder);
}

// A stored blob that no longer matches means the file changed after it was marked.
function isViewed(stored, blob) {
  return Boolean(stored) && stored === blob;
}

// Integration branches change only through a PR, never by a push from the tree.
function isProtected(branch, protectedBranches) {
  return Array.isArray(protectedBranches) && protectedBranches.includes(branch);
}

// `git worktree list --porcelain`: one block per checkout, the main clone first.
function parseWorktrees(stdout) {
  const list = [];
  for (const block of stdout.split(/\n\n+/)) {
    const fields = Object.fromEntries(
      block.split('\n').filter(Boolean).map(line => {
        const space = line.indexOf(' ');
        return space < 0 ? [line, true] : [line.slice(0, space), line.slice(space + 1)];
      }),
    );
    if (fields.worktree && fields.HEAD && !fields.bare && !fields.prunable) list.push({ path: fields.worktree, head: fields.HEAD });
  }
  return list;
}

// Checkouts whose copy of the file lies in a workspace folder come first: language servers index
// only those. The sort is stable, so on a tie the main clone, listed first by git, wins.
function byWorkspace(checkouts, workspaceDirs, relPath) {
  const indexed = dir => workspaceDirs.some(ws => `${dir}/${relPath}`.startsWith(`${ws}/`));
  return [...checkouts.filter(c => indexed(c.path)), ...checkouts.filter(c => !indexed(c.path))];
}

module.exports = {
  parseGitHubRemote,
  parsePrUrl,
  prKey,
  parseDiffRaw,
  buildFileTree,
  filesUnder,
  isViewed,
  isProtected,
  parseWorktrees,
  byWorkspace,
};
