// Runs the co-change commit selector (docs/evaluation/cochange/protocol.md) and writes its manifest.
//
//   node scripts/evaluation/cochange/select.mjs --repo <clone> --name <owner/name> --head <full sha> --out <new file>
//
// Needs a built tree (`npm run build`). It only reads the clone's Git history: no snapshot, index,
// database, embedding or model is involved. The clone path is never written to the manifest, and an
// existing output file is never overwritten. See docs/evaluation/cochange/reproduce.md.
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const USAGE = 'Usage: select.mjs --repo <clone> --name <owner/name> --head <full sha> --out <new file>';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`Missing --${name}. ${USAGE}`);
  return value;
}

const repoPath = resolve(argument('repo'));
const repositoryName = argument('name');
const head = argument('head');
const outPath = resolve(argument('out'));
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryName)) throw new Error(`--name must be owner/name, got ${JSON.stringify(repositoryName)}`);
if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) throw new Error(`--head must be a full lowercase commit SHA, got ${JSON.stringify(head)}`);
if (existsSync(outPath)) throw new Error(`Refusing to overwrite an existing file: ${outPath}`);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const selectorModule = join(root, 'dist', 'evaluation', 'cochange', 'selector.js');
if (!existsSync(selectorModule)) throw new Error(`${selectorModule} is missing; run npm run build first`);
const { selectCochangeCommits, serializeManifest } = await import(pathToFileURL(selectorModule).href);

const result = await selectCochangeCommits({ repoPath, repositoryName, head });
if (result.status !== 'selected') {
  console.log(JSON.stringify(result));
  console.log('No manifest written.');
  process.exit(2);
}

const bytes = Buffer.from(serializeManifest(result.manifest), 'utf8');
writeFileSync(outPath, bytes, { flag: 'wx' });
console.log(`counts ${JSON.stringify(result.manifest.counts)}`);
console.log(`wrote ${outPath}: ${bytes.length} bytes, sha256 ${createHash('sha256').update(bytes).digest('hex')}`);
