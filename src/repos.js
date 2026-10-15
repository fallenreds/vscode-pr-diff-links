const fs = require('fs');
const { repoRoot, remotes } = require('./git');

const STATE_KEY = 'repos';

// slug → { slug, root, remote }. Workspace folders are scanned on start; repositories
// met in links are remembered, so their PRs stay in the tree after a restart.
class Registry {
  constructor(state) {
    this.state = state;
    this.workspace = new Map();
    const stored = Object.entries(state.get(STATE_KEY, {}));
    this.linked = new Map(stored.filter(([, repo]) => fs.existsSync(repo.root)));
    this.ready = Promise.resolve();
  }

  scan(dirs) {
    this.ready = (async () => {
      const found = new Map();
      for (const dir of dirs) {
        const repo = await describe(dir).catch(() => null);
        if (repo && !found.has(lower(repo.slug))) found.set(lower(repo.slug), repo);
      }
      this.workspace = found;
    })();
    return this.ready;
  }

  async addFromLink(dir, slug) {
    const repo = await describe(dir, slug);
    if (!repo) return null;
    const key = lower(repo.slug);
    const known = this.linked.get(key);
    if (!this.workspace.has(key) && (!known || known.root !== repo.root || known.remote !== repo.remote)) {
      this.linked.set(key, repo);
      await this.state.update(STATE_KEY, Object.fromEntries(this.linked));
    }
    return repo.slug;
  }

  get(slug) {
    return this.workspace.get(lower(slug)) || this.linked.get(lower(slug));
  }

  list() {
    return [...new Map([...this.linked, ...this.workspace]).values()];
  }
}

// Without a slug the PR repository is origin, or the first GitHub remote. A slug that no
// remote points to (a fork clone) still maps to this checkout: the commits may be local.
async function describe(dir, slug) {
  const root = await repoRoot(dir);
  const list = await remotes(root);
  const primary = list.find(r => r.name === 'origin') || list[0];
  if (!slug) return primary ? { slug: primary.slug, root, remote: primary.name } : null;
  const match = list.find(r => lower(r.slug) === lower(slug)) || primary;
  return match ? { slug, root, remote: match.name } : null;
}

const lower = s => s.toLowerCase();

module.exports = { Registry };
