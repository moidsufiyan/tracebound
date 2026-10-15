// Operator entry point of the co-change evaluation: prepare, evaluate, publish.
//
//   npm run cochange -- <prepare|evaluate|publish> <options>     (--help lists them)
//
// Needs a built tree (`npm run build`) and uses dist/ as it is. The commands are in
// src/evaluation/cochange/operator.ts; see docs/evaluation/cochange/operate.md.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const operatorModule = join(root, 'dist', 'evaluation', 'cochange', 'operator.js');
if (!existsSync(operatorModule)) {
  console.error(`${operatorModule} is missing; run npm run build first`);
  process.exit(2);
}
const { runOperator } = await import(pathToFileURL(operatorModule).href);
process.exitCode = await runOperator(process.argv.slice(2), { traceboundRoot: root });
