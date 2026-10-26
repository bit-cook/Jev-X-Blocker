// Pushes the local git index to GitHub via the Git Data API.
// Needed because github.com (git smart-HTTPS) is unreachable from this
// network while api.github.com is reachable.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const TOKEN = process.env.GH_TOKEN;
const OWNER = 'bit-cook';
const REPO = 'Jev-X-Blocker';
const BRANCH = 'main';
const API = 'https://api.github.com';

const MESSAGE = process.env.COMMIT_MESSAGE || 'chore: update';

const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'jev-x-blocker-upload',
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2022-11-28'
};

async function api(pathname, method = 'GET', body) {
  const response = await fetch(`${API}${pathname}`, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = { raw: text.slice(0, 300) }; }
  if (!response.ok) {
    throw new Error(`${method} ${pathname} -> ${response.status}: ${JSON.stringify(json).slice(0, 400)}`);
  }
  return json;
}

// Tracked paths come from the index, so .gitignore is already honoured.
const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

// The Git Data API refuses to create blobs in a repo with zero commits
// (409 "Git Repository is empty"). Seed one initial commit via the Contents
// API, then force the branch onto the real single commit below so the final
// history stays clean.
const branchRef = await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`).catch(() => null);
if (!branchRef) {
  await api(`/repos/${OWNER}/${REPO}/contents/README.md`, 'PUT', {
    message: 'chore: initialise repository',
    content: Buffer.from('# Jev X Blocker\n').toString('base64')
  });
  console.log('seeded initial commit via Contents API');
}

console.log(`uploading ${paths.length} tracked files...`);
const tree = [];
for (const path of paths) {
  const buffer = readFileSync(path);
  const isBinary = buffer.includes(0);
  const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, 'POST', {
    content: isBinary ? buffer.toString('base64') : buffer.toString('utf8'),
    encoding: isBinary ? 'base64' : 'utf-8'
  });
  tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  console.log(`  blob ${blob.sha.slice(0, 7)} ${path}`);
}

const createdTree = await api(`/repos/${OWNER}/${REPO}/git/trees`, 'POST', { tree });
console.log(`tree ${createdTree.sha.slice(0, 7)} (${tree.length} entries)`);

// Extend the existing history instead of orphaning it.
const head = await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`);
const parents = [head.object.sha];
console.log(`parent ${head.object.sha.slice(0, 7)}`);

const commit = await api(`/repos/${OWNER}/${REPO}/git/commits`, 'POST', {
  message: MESSAGE,
  tree: createdTree.sha,
  parents
});
console.log(`commit ${commit.sha.slice(0, 7)}`);

// Fast-forward the branch onto the new commit.
await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, 'PATCH', { sha: commit.sha });
console.log(`refs/heads/${BRANCH} -> ${commit.sha.slice(0, 7)}`);
console.log(`\nDONE: https://github.com/${OWNER}/${REPO}`);
