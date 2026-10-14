import type { Evidence } from '../retrieval/evidence.js';
import type { InvestigationCandidate, InvestigationReport } from './investigate.js';

// A readable rendering of an investigation report. It adds no facts: every line comes from the
// report, and every evidence line carries the evidence id it describes.

export function renderInvestigationMarkdown(report: InvestigationReport): string {
  const md: string[] = [];
  const { snapshot, change, retrieval, reasoning } = report;
  md.push(`# Change investigation`, '');
  md.push(`**Change:** ${change.description}`, '');
  md.push(`Snapshot ${snapshot.id} of repository ${snapshot.repositoryId}, commit \`${snapshot.commitSha}\` (committed ${snapshot.committedAt}).`, '');
  if (report.commitRange) {
    const range = report.commitRange;
    md.push(`The change is the difference from base \`${range.base}\` to head \`${range.head}\` (${range.changes.length} file change${range.changes.length === 1 ? '' : 's'}). It is investigated in the base snapshot, the state before the change.`, '');
  }

  md.push('## How to read this report', '');
  md.push('- Candidates are files retrieved for the change, ordered by fused retrieval rank. A rank, a score, a matched term or an import explains why a file was surfaced; it does not show that the change affects the file.');
  md.push('- Each evidence line names its evidence id; the JSON form of this report holds the complete evidence objects.');
  md.push('- `insufficient_evidence` means the evidence did not decide the question either way. It is not a finding that the file is unaffected.', '');

  md.push('## Changed files', '');
  const withChange = report.commitRange !== null;
  md.push(`| Path |${withChange ? ' Change |' : ''} In snapshot | Own fused rank | Note |`, `|---|${withChange ? '---|' : ''}---|---|---|`);
  for (const f of report.changedFiles) {
    const note = f.inSnapshot ? '' : f.excludedBecause ? `excluded by file policy: ${f.excludedBecause}` : 'not in this snapshot';
    md.push(`| \`${f.path}\` |${withChange ? ` ${f.change ?? '-'} |` : ''} ${f.inSnapshot ? 'yes' : '**no**'} | ${f.fusedRank ?? '-'} | ${note} |`);
  }
  md.push('');

  md.push('## Impact assessment', '');
  switch (reasoning.status) {
    case 'not_requested':
      md.push('Not requested. The candidates below are described by their evidence only.');
      break;
    case 'accepted':
      md.push(`Accepted by the validator: model \`${reasoning.modelId}\`, instructions ${reasoning.instructionsVersion}. Classifications are the model's reading of the cited evidence, checked for citations and a set of explicit mismatches, not for truth.`);
      break;
    case 'rejected':
    case 'failed':
      md.push(`**${reasoning.status === 'rejected' ? 'Rejected by the validator' : 'Failed'}**: model \`${reasoning.modelId}\`, instructions ${reasoning.instructionsVersion}. No classification is shown.`, '', `\`${reasoning.error}\``);
      break;
  }
  md.push('');

  md.push('## Candidates', '');
  md.push(`${report.candidates.length} described of ${retrieval.rankedCandidates} ranked (${retrieval.deterministicCandidates} by lexical and structural signals, ${retrieval.semanticCandidates} by similarity with \`${retrieval.embeddingModelId}\`; RRF K = ${retrieval.rrfK}).`, '');
  if (report.candidates.length > 0) {
    md.push('| Rank | File | Relationship to a changed file | Matched terms | Similarity | Assessment |', '|---|---|---|---|---|---|');
    for (const c of report.candidates) {
      md.push(`| ${c.rank} | \`${c.path}\` | ${relationship(c.evidence)} | ${matchedTerms(c.evidence)} | ${similarity(c.evidence)} | ${c.assessment?.classification ?? '-'} |`);
    }
    md.push('');
  }

  for (const c of report.candidates) renderCandidate(md, c);

  md.push('## Limitations of this report', '');
  for (const l of report.limitations) md.push(`- ${l}`);
  md.push('');
  return md.join('\n');
}

function renderCandidate(md: string[], c: InvestigationCandidate): void {
  md.push(`### ${c.rank}. \`${c.path}\` (${c.kind})`, '');
  const s = c.signals;
  md.push(`Retrieval signals: fused rank ${s.fusedRank}, RRF score ${s.rrfScore.toFixed(4)}, lexical/structural rank ${s.deterministicRank ?? 'none'}${s.deterministicCategory ? ` (${s.deterministicCategory})` : ''}, semantic rank ${s.semanticRank ?? 'none'}.`, '');
  md.push('Evidence:');
  for (const line of c.summary) md.push(`- \`${line.id}\`: ${line.text}`);
  md.push('');
  if (c.assessment) {
    md.push(`Assessment: **${c.assessment.classification}**. ${c.assessment.meaning}`);
    for (const f of c.assessment.findings) md.push(`- ${f.statement} (${f.evidenceIds.map((id) => `\`${id}\``).join(', ')})`);
    md.push('');
  }
  if (c.limitations.length) {
    md.push('What this evidence cannot show:');
    for (const l of c.limitations) md.push(`- ${l}`);
    md.push('');
  }
  md.push('Open questions:');
  for (const q of c.openQuestions) md.push(`- ${q}`);
  md.push('');
}

function relationship(evidence: readonly Evidence[]): string {
  const kinds = evidence.flatMap((e) => (e.type === 'structural' ? [e.signal === 'test-to-source' ? 'tests it' : e.signal === 'incoming-import' ? 'imports it' : 'imported by it'] : []));
  return kinds.length ? [...new Set(kinds)].join(', ') : 'none found';
}

function matchedTerms(evidence: readonly Evidence[]): string {
  const lexical = evidence.find((e) => e.type === 'lexical');
  return lexical && lexical.type === 'lexical' ? `${lexical.matchedTerms.length} (in content ${lexical.contentMatchCount}, in path ${lexical.pathMatchCount})` : '-';
}

function similarity(evidence: readonly Evidence[]): string {
  const semantic = evidence.find((e) => e.type === 'semantic');
  return semantic && semantic.type === 'semantic' ? semantic.similarityScore.toFixed(3) : '-';
}
