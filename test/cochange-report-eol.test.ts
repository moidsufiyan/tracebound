import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../src/evaluation/m9/canonical.js';
import { publishResults } from '../src/evaluation/cochange/publish.js';
import { REPORT_FILE, RESULTS_FILE } from '../src/evaluation/cochange/report.js';
import { buildSynthetic } from './cochange-synthetic.js';
import { FixtureRepo } from './git-fixture.js';

// Each test assembles results (10,000-replicate bootstraps) and runs Git; the 5 s default is too tight in a parallel suite.
vi.setConfig({ testTimeout: 60_000 });

const RESULTS_DIR = 'docs/evaluation/cochange';
const ATTRIBUTES = readFileSync(join(import.meta.dirname, '..', '.gitattributes'), 'utf8');

let dir: string;
const repos: FixtureRepo[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tracebound-report-eol-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  while (repos.length > 0) repos.pop()!.remove();
});

/** A checkout that converts LF to CRLF on checkout, as Git for Windows does by default, holding the published artifacts. */
async function publishInto(attributes: string | null) {
  const repo = new FixtureRepo();
  repos.push(repo);
  repo.git('config', 'core.autocrlf', 'true');
  if (attributes !== null) repo.commit({ '.gitattributes': attributes });
  mkdirSync(join(repo.path, RESULTS_DIR), { recursive: true });
  const built = buildSynthetic(dir);
  const publish = () => publishResults({ workDirectory: built.work, manifestPath: built.manifestPath, outputDirectory: join(repo.path, RESULTS_DIR), repositoryPath: join(dir, 'clone') }, { registration: built.registration });
  const result = await publish();
  if (result.status !== 'published') throw new Error(JSON.stringify(result));
  repo.commit({}, { message: 'publish results' });
  const report = result.artifacts.find((a) => a.name === REPORT_FILE)!;
  return { repo, report, publish };
}

const reportSha = (root: string) => sha256Hex(readFileSync(join(root, RESULTS_DIR, REPORT_FILE)));

/** Removes the working copy of the report and checks it out again; returns the SHA-256 of what Git wrote. */
function checkoutAgain(repo: FixtureRepo): string {
  rmSync(join(repo.path, RESULTS_DIR, REPORT_FILE));
  repo.git('checkout', '--', `${RESULTS_DIR}/${REPORT_FILE}`);
  return reportSha(repo.path);
}

describe('published report line endings', () => {
  it('renders the report with LF line endings only', async () => {
    const { repo } = await publishInto(ATTRIBUTES);
    const text = readFileSync(join(repo.path, RESULTS_DIR, REPORT_FILE), 'utf8');
    expect(text).toContain('\n');
    expect(text).not.toContain('\r');
  });

  it("keeps the report's SHA-256 through checkout and cloning under the repository's .gitattributes", async () => {
    const { repo, report, publish } = await publishInto(ATTRIBUTES);
    expect(repo.git('check-attr', 'eol', '--', `${RESULTS_DIR}/${REPORT_FILE}`)).toMatch(/eol: lf$/);
    expect(checkoutAgain(repo)).toBe(report.sha256);

    const clone = join(dir, 'fresh-clone');
    execFileSync('git', ['-c', 'core.autocrlf=true', 'clone', '--quiet', repo.path, clone]);
    expect(reportSha(clone)).toBe(report.sha256);

    // The checked-out files are still the published ones: a rerun finds both identical and writes nothing.
    const again = await publish();
    expect(again).toMatchObject({ status: 'published' });
    expect(again.status === 'published' && again.artifacts.map((a) => [a.name, a.action])).toEqual([[RESULTS_FILE, 'unchanged'], [REPORT_FILE, 'unchanged']]);
  });

  it('would change the SHA-256 on checkout without the rule (control)', async () => {
    const { repo, report, publish } = await publishInto(null);
    expect(checkoutAgain(repo)).not.toBe(report.sha256);
    // And the no-overwrite rule then refuses to publish over the converted file.
    expect(await publish()).toMatchObject({ status: 'refused', reason: 'artifact-conflict' });
  });
});
