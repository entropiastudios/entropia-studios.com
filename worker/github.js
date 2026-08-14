// Minimal GitHub client for the /admin panel.
//
// Everything the panel changes is committed to the repository in a single
// commit (Git Data API). Cloudflare rebuilds and publishes the site on push,
// so the repo stays the only source of truth — same as editing by hand.

const API = 'https://api.github.com';

function headers(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'entropia-studios-admin',
    'Content-Type': 'application/json',
  };
}

async function gh(env, path, init = {}) {
  const res = await fetch(`${API}/repos/${env.GITHUB_REPO}${path}`, {
    ...init,
    headers: headers(env),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`GitHub ${init.method || 'GET'} ${path} → ${res.status}: ${body.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function headCommit(env) {
  const ref = await gh(env, `/git/ref/heads/${env.GIT_BRANCH}`);
  return ref.object.sha;
}

/** Full recursive tree of the branch head: Map<path, {sha, size}>. */
export async function treeFiles(env, commitSha) {
  const commit = await gh(env, `/git/commits/${commitSha}`);
  const tree = await gh(env, `/git/trees/${commit.tree.sha}?recursive=1`);
  const files = new Map();
  for (const entry of tree.tree) {
    if (entry.type === 'blob') files.set(entry.path, { sha: entry.sha, size: entry.size });
  }
  return { files, treeSha: commit.tree.sha, truncated: tree.truncated };
}

/** Read a UTF-8 file at a given commit. Returns null when it does not exist. */
export async function readTextFile(env, path, ref) {
  const res = await fetch(`${API}/repos/${env.GITHUB_REPO}/contents/${path}?ref=${ref}`, {
    headers: { ...headers(env), Accept: 'application/vnd.github.raw' },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = new Error(`GitHub GET ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

/**
 * Commit a set of files in one go.
 *   texts   { path: string }        UTF-8 contents
 *   uploads [{ path, base64 }]      binary contents
 *   deletes [path]                  files to remove
 * Returns the new commit sha.
 */
export async function commitFiles(env, { baseCommit, texts = {}, uploads = [], deletes = [], message }) {
  const base = await gh(env, `/git/commits/${baseCommit}`);

  const tree = [];

  for (const [path, content] of Object.entries(texts)) {
    const blob = await gh(env, '/git/blobs', {
      method: 'POST',
      body: JSON.stringify({ content, encoding: 'utf-8' }),
    });
    tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  for (const up of uploads) {
    const blob = await gh(env, '/git/blobs', {
      method: 'POST',
      body: JSON.stringify({ content: up.base64, encoding: 'base64' }),
    });
    tree.push({ path: up.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  for (const path of deletes) {
    tree.push({ path, mode: '100644', type: 'blob', sha: null });
  }

  if (!tree.length) return baseCommit;

  const newTree = await gh(env, '/git/trees', {
    method: 'POST',
    body: JSON.stringify({ base_tree: base.tree.sha, tree }),
  });

  const commit = await gh(env, '/git/commits', {
    method: 'POST',
    body: JSON.stringify({ message, tree: newTree.sha, parents: [baseCommit] }),
  });

  await gh(env, `/git/refs/heads/${env.GIT_BRANCH}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });

  return commit.sha;
}
