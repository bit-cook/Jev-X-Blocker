import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const destination = resolve(root, 'dist');

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const entry of ['manifest.json', 'src', 'assets']) {
  await cp(resolve(root, entry), resolve(destination, entry), { recursive: true });
}

// Fail the build early when the manifest points at a missing file.
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_page,
  ...manifest.content_scripts[0].js,
  ...Object.values(manifest.icons)
];
for (const file of referenced) {
  await stat(join(root, file));
}

console.log(`Packaged extension in ${destination} (${referenced.length} entrypoints verified)`);
