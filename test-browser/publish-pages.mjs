// Publishes the GitHub Pages site to the gh-pages branch (orphan commit)
// and enables Pages for the repo. Runs from anywhere; paths are absolute.
//   GH_TOKEN=... node test-browser/publish-pages.mjs
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = process.env.GH_TOKEN;
const OWNER = 'bit-cook';
const REPO = 'Jev-X-Blocker';
const BRANCH = 'gh-pages';
const API = 'https://api.github.com';
const SRC = resolve(ROOT, 'test-browser/artifacts/gh-pages');

if (!TOKEN) { console.error('missing GH_TOKEN'); process.exit(1); }

const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'jev-x-blocker-pages',
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2022-11-28'
};

async function api(pathname, method = 'GET', body, headers = {}) {
  const payload = body === undefined || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const response = await fetch(`${API}${pathname}`, { method, headers: { ...H, ...headers }, body: payload });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = { raw: text.slice(0, 200) }; }
  if (!response.ok) throw new Error(`${method} ${pathname} -> ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

const files = ['index.html', 'assets/icon128.png', 'shots/console.png', 'shots/settings.png', 'shots/content.png'];
for (const f of files) {
  if (!existsSync(join(SRC, f))) throw new Error(`missing site asset: ${f}`);
}

console.log(`uploading ${files.length} files to gh-pages...`);
const tree = [];
for (const path of files) {
  const buffer = readFileSync(join(SRC, path));
  const isBinary = path.endsWith('.png');
  const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, 'POST', {
    content: isBinary ? buffer.toString('base64') : buffer.toString('utf8'),
    encoding: isBinary ? 'base64' : 'utf-8'
  });
  tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  console.log(`  blob ${blob.sha.slice(0, 7)} ${path} (${(buffer.length / 1024).toFixed(1)} KB)`);
}

const createdTree = await api(`/repos/${OWNER}/${REPO}/git/trees`, 'POST', { tree });
console.log(`tree ${createdTree.sha.slice(0, 7)}`);

const commit = await api(`/repos/${OWNER}/${REPO}/git/commits`, 'POST', {
  message: 'pages: Jev X Blocker landing site',
  tree: createdTree.sha
  // no parents: orphan branch, independent of main
});
console.log(`commit ${commit.sha.slice(0, 7)}`);

const existing = await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`).catch(() => null);
if (existing) {
  await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, 'PATCH', { sha: commit.sha, force: true });
  console.log(`refs/heads/${BRANCH} updated`);
} else {
  await api(`/repos/${OWNER}/${REPO}/git/refs`, 'POST', { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
  console.log(`refs/heads/${BRANCH} created`);
}

// Enable Pages (idempotent: 409 means already enabled -> verify instead).
try {
  const pages = await api(`/repos/${OWNER}/${REPO}/pages`, 'POST', {
    source: { branch: BRANCH, path: '/' }
  });
  console.log(`pages enabled: ${JSON.stringify(pages.html_url || pages).slice(0, 120)}`);
} catch (e) {
  if (String(e).includes('409')) {
    const current = await api(`/repos/${OWNER}/${REPO}/pages`);
    console.log(`pages already enabled: ${current.html_url}`);
  } else throw e;
}

console.log(`\nsite: https://${OWNER}.github.io/${REPO}/`);
