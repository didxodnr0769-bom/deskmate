import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// This is independent of .gitignore: only these shared inputs enter a source ZIP.
// New guides and Agent notes must be reviewed before adding them here.
export const SOURCE_ENTRIES = Object.freeze([
  'src', 'tests', 'scripts',
  'docs/architecture.md', 'docs/character-guide.md',
  'docs/agent-provider-guide.md', 'docs/verification.md', '.agents/README.md',
  'package.json', 'package-lock.json', 'README.md', 'AGENTS.md', 'CLAUDE.md',
  'LICENSE', 'THIRD_PARTY_NOTICES.md', '.gitignore', '.nvmrc',
  'tsconfig.json', 'vite.config.ts', 'index.html',
]);

const codeDirectories = new Set(['src', 'tests', 'scripts']);
const privateDirectory = /^(?:\.git|\.svn|\.codex|\.claude|\.cursor|\.vscode(?:-.*)?|\.idea|\.agents|\.aws|\.local|node_modules|dist|release|work|outputs|userData|\.local-data|qa(?:[-_].*)?|\.qa.*|logs?|screenshots?|captures?|sessions?|transcripts?|coverage|\.cache|\.tmp|tmp|temp)$/i;
const privateFile = /^(?:\.env.*|\.npmrc|\.yarnrc(?:\.yml)?|\.pypirc|\.netrc|\.git-credentials|\.DS_Store|\.cursorrules|\.cursorignore|\.claude\.json|(?:AGENTS|CLAUDE)\.local\.md|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|authorized_keys|known_hosts|(?:memos|worktime|briefing).*\.json(?:\..*)?)$|^(?:credentials?|secrets?|tokens?|service[-_]account|client[-_]secret|oauth[-_]token|auth)(?:[._-][^.]+)*\.(?:json|ya?ml|ini|toml|txt|csv)$|\.local\.(?:json|toml)$|\.(?:code-workspace|log|tmp|pem|key|p8|p12|pfx|jks|keystore|cer|crt|mobileprovision|provisionprofile|sqlite3?|db|har|trace)$/i;

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

/**
 * Copy reviewed source inputs into a new staging directory, without following links.
 * Missing required inputs and broad/unreviewed selections fail before staging starts.
 * File-name filters are a second guard; source contents still need publication review.
 */
export async function stageSourceArchive({ root, destination, entries = SOURCE_ENTRIES }) {
  const sourceRoot = resolve(root);
  const targetRoot = resolve(destination);
  if (!Array.isArray(entries) || entries.length === 0
      || new Set(entries).size !== entries.length
      || entries.some(entry => !SOURCE_ENTRIES.includes(entry))) {
    throw new Error('Source archive entries must be unique reviewed project inputs.');
  }
  if (isInside(targetRoot, sourceRoot)
      || [...codeDirectories].some(entry => isInside(join(sourceRoot, entry), targetRoot))) {
    throw new Error('Source archive staging must not contain or overlap source inputs.');
  }
  const rootStat = await lstat(sourceRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Source archive root must be a real project directory.');
  }
  for (const entry of entries) {
    const source = join(sourceRoot, entry);
    // Check every parent too: .agents/README.md must not escape through a linked .agents.
    let current = sourceRoot;
    for (const component of entry.split('/')) {
      current = join(current, component);
      const stat = await lstat(current);
      const expectedDirectory = current !== source || codeDirectories.has(entry);
      if (stat.isSymbolicLink() || (expectedDirectory ? !stat.isDirectory() : !stat.isFile())) {
        throw new Error(`Source archive input has an invalid type: ${entry}`);
      }
    }
  }

  await mkdir(dirname(targetRoot), { recursive: true });
  // A fresh directory cannot accidentally retain files from an earlier staging run.
  await mkdir(targetRoot);
  const copied = [];
  async function copyInput(source, target, projectPath) {
    const stat = await lstat(source);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      if (privateDirectory.test(basename(source))) return;
      await mkdir(target, { recursive: true });
      const children = await readdir(source);
      for (const child of children.sort()) {
        await copyInput(join(source, child), join(target, child), `${projectPath}/${child}`);
      }
    } else if (stat.isFile() && !privateFile.test(basename(source))) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
      copied.push(projectPath);
    }
  }
  for (const entry of entries) {
    await copyInput(join(sourceRoot, entry), join(targetRoot, entry), entry);
  }
  return copied.sort();
}
