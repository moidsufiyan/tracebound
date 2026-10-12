// Offline verification of an M9 release directory.
//
//   node scripts/m9-verify.mjs <release dir> [--expect-manifest-digest <sha256>]
//
// Needs a built tree (`npm run build`). It starts no Ollama, runs no retrieval or reasoning model
// and opens no Git repository; the database is opened read-only. A passing run shows that the files
// are the recorded bytes and agree with each other, not who recorded them.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { verifyRelease } = await import(pathToFileURL(join(root, 'dist', 'evaluation', 'm9', 'verify.js')).href);

const releaseDir = process.argv[2];
if (!releaseDir) throw new Error('Usage: m9-verify.mjs <release dir> [--expect-manifest-digest <sha256>]');
const flag = process.argv.indexOf('--expect-manifest-digest');
const expectedManifestDigest = flag >= 0 ? process.argv[flag + 1] : undefined;

const report = await verifyRelease(resolve(releaseDir), expectedManifestDigest ? { expectedManifestDigest } : {});
for (const check of report.checks) console.log(`${check.ok ? 'ok    ' : 'FAILED'} ${check.name}${check.ok || !check.detail ? '' : ` — ${check.detail}`}`);
console.log(`\nrelease manifest digest: ${report.manifestDigest ?? 'unavailable'}`);
console.log(`${report.checks.filter((check) => check.ok).length}/${report.checks.length} checks passed: ${report.ok ? 'VERIFIED' : 'NOT VERIFIED'}`);
process.exitCode = report.ok ? 0 : 1;
