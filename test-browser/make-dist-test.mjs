// Builds dist-test/ from dist/: identical extension code, only the content
// script match pattern is extended so the real extension can run against the
// local mock X page (http://127.0.0.1:8788). dist/ itself stays pristine.
import { cp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'dist');
const dest = resolve(root, 'dist-test');

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });

const manifestPath = resolve(dest, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.name = 'Jev X Blocker E2E';
manifest.content_scripts[0].matches = ['https://x.com/*', 'http://127.0.0.1:8788/*'];
for (const entry of manifest.web_accessible_resources) entry.matches = ['https://x.com/*', 'http://127.0.0.1:8788/*'];
// WITH_HOST_PERMS=1 grants host permission for the no-CORS mock host (8789),
// to test whether host_permissions alone exempts the SW from CORS.
if (process.env.WITH_HOST_PERMS === '1') {
  manifest.host_permissions = [...manifest.host_permissions, 'http://127.0.0.1:8789/*'];
}
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`dist-test ready at ${dest} (host_permissions: ${JSON.stringify(manifest.host_permissions)})`);
