import { packager } from '@electron/packager';
import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { stageSourceArchive } from './source-archive.mjs';

const require = createRequire(import.meta.url);
const electronRoot = dirname(require.resolve('electron/package.json'));
const electronVersion = require('electron/package.json').version;
const root = process.cwd();
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const release = join(root, 'release');
const electronZipDir = join(release, '.electron-zip');
const notices = join(release, '.package-resources', 'THIRD_PARTY_NOTICES');
await mkdir(electronZipDir, { recursive: true });
await rm(dirname(notices), { recursive: true, force: true });
await mkdir(notices, { recursive: true });

// Copy original notices from the exact installed runtime and production packages.
await copyFile(join(electronRoot, 'dist', 'LICENSE'), join(notices, 'Electron-LICENSE'));
await copyFile(join(electronRoot, 'dist', 'LICENSES.chromium.html'), join(notices, 'LICENSES.chromium.html'));
for (const name of ['react', 'react-dom', 'scheduler']) {
  const packageRoot = dirname(require.resolve(`${name}/package.json`));
  await copyFile(join(packageRoot, 'LICENSE'), join(notices, `${name}-LICENSE`));
}

// Reuse the exact installed runtime instead of downloading another Electron copy.
execFileSync('/usr/bin/ditto', ['-c', '-k', '--norsrc', join(electronRoot, 'dist'), join(electronZipDir, `electron-v${electronVersion}-darwin-${process.arch}.zip`)]);
const paths = await packager({
  dir: '.', out: 'release', name: 'Desktop Companion',
  platform: 'darwin', arch: process.arch, overwrite: true,
  appBundleId: 'land.desktopcompanion.prototype',
  appCategoryType: 'public.app-category.productivity',
  electronVersion, electronZipDir,
  asar: true, prune: true,
  // Only runtime inputs enter app.asar; root documents and local data stay out.
  ignore: [/^\/(?!dist(?:\/|$)|node_modules(?:\/|$)|package\.json$).+/],
  extraResource: [join(root, 'LICENSE'), join(root, 'THIRD_PARTY_NOTICES.md'), notices],
});

for (const output of paths) {
  const archive = join(release, `Desktop-Companion-v${manifest.version}-mac-${process.arch}.zip`);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--keepParent', join(output, 'Desktop Companion.app'), archive]);
  console.log(output);
  console.log(archive);
}

// Build the source archive from explicit project inputs, never the workspace parent.
const sourceStage = join(release, '.source', 'deskmate');
await rm(dirname(sourceStage), { recursive: true, force: true });
try {
  await stageSourceArchive({ root, destination: sourceStage });
  const sourceArchive = join(release, `deskmate-v${manifest.version}-source.zip`);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--keepParent', sourceStage, sourceArchive]);
  console.log(sourceArchive);
} finally {
  await rm(dirname(sourceStage), { recursive: true, force: true });
}
