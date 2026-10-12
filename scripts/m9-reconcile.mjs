// Rebuilds only the review packets of an existing M9 release (for example after a change to the
// annotation contract) from the release's own frozen database and evidence packages, then runs the
// release gate.
//
//   node scripts/m9-reconcile.mjs <release dir> --reason "<why>"
//
// Needs a built tree (`npm run build`). No Ollama, retrieval, embedding or reasoning model runs; the
// database is opened read-only and neither it nor any evidence package is rewritten. The replaced
// packets and manifest are kept under <release dir>/superseded/.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { reconcilePackets } = await import(pathToFileURL(join(root, 'dist', 'evaluation', 'm9', 'gate.js')).href);

const releaseDir = process.argv[2];
const flag = process.argv.indexOf('--reason');
if (!releaseDir || flag < 0 || !process.argv[flag + 1]) throw new Error('Usage: m9-reconcile.mjs <release dir> --reason "<why>"');

const result = await reconcilePackets(resolve(releaseDir), new Date().toISOString(), process.argv[flag + 1]);
console.log(`previous manifest digest ${result.previousManifestDigest}`);
console.log(`new manifest digest      ${result.manifestDigest}`);
for (const packet of result.packets) console.log(`${packet.caseId} packet ${packet.before} -> ${packet.after}`);
console.log(`database sha256 (unchanged) ${result.unchanged.databaseSha256}`);
for (const [id, digest] of Object.entries(result.unchanged.packageDigests)) console.log(`${id} package (unchanged) ${digest}`);
for (const entry of result.report.checks.filter((check) => !check.ok)) console.log(`FAILED: ${entry.name} ${entry.detail ?? ''}`);
console.log(`verifier: ${result.report.checks.filter((check) => check.ok).length}/${result.report.checks.length} checks passed`);
console.log(`distribution status: ${result.status}`);
process.exitCode = result.status === 'RELEASED' ? 0 : 1;
