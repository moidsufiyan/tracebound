const fs = require('fs');
const path = require('path');

const summaryPath = path.join(__dirname, 'outputs', 'summary.json');
const detSummaryPath = path.join(__dirname, '../ranking/outputs/summary.json');
const semSummaryPath = path.join(__dirname, '../semantic/outputs/summary.json');

const data = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const detData = JSON.parse(fs.readFileSync(detSummaryPath, 'utf8'));
const semData = JSON.parse(fs.readFileSync(semSummaryPath, 'utf8'));

let md = "# Hybrid Retrieval v1: Final Evaluation Report\n\n";

for (const caseId of Object.keys(data)) {
  const d = data[caseId];
  const dDet = detData[caseId];
  const dSem = semData[caseId];
  
  md += `## ${caseId}\n\n`;
  
  md += `### Performance Comparison\n\n`;
  md += `| Method | Top-1 | Top-3 | Top-5 | Top-10 | Top-20 |\n`;
  md += `|--------|-------|-------|-------|--------|--------|\n`;
  
  const toIcon = (val) => val ? '✅' : '❌';
  
  md += `| Deterministic (B6) | ${toIcon(dDet.metrics.top_1)} | ${toIcon(dDet.metrics.top_3)} | ${toIcon(dDet.metrics.top_5)} | ${toIcon(dDet.metrics.top_10)} | ${toIcon(dDet.metrics.top_20)} |\n`;
  md += `| Semantic (B7.1) | ${toIcon(dSem.metrics.relevant_found_top_1)} | ${toIcon(dSem.metrics.relevant_found_top_3)} | ${toIcon(dSem.metrics.relevant_found_top_5)} | ${toIcon(dSem.metrics.relevant_found_top_10)} | ${toIcon(dSem.metrics.relevant_found_top_20)} |\n`;
  md += `| Hybrid (H1 Union) | ${toIcon(d.metrics.h1.top_1)} | ${toIcon(d.metrics.h1.top_3)} | ${toIcon(d.metrics.h1.top_5)} | ${toIcon(d.metrics.h1.top_10)} | ${toIcon(d.metrics.h1.top_20)} |\n`;
  md += `| Hybrid (H2 RRF) | ${toIcon(d.metrics.h2.top_1)} | ${toIcon(d.metrics.h2.top_3)} | ${toIcon(d.metrics.h2.top_5)} | ${toIcon(d.metrics.h2.top_10)} | ${toIcon(d.metrics.h2.top_20)} |\n`;
  md += `| Hybrid (H3 Tiers) | ${toIcon(d.metrics.h3.top_1)} | ${toIcon(d.metrics.h3.top_3)} | ${toIcon(d.metrics.h3.top_5)} | ${toIcon(d.metrics.h3.top_10)} | ${toIcon(d.metrics.h3.top_20)} |\n\n`;

  // Find the truth candidates in H2/H3
  const findTruth = (arr) => arr.filter(c => dDet.top_20_candidates?.some(truth => truth.is_truth && truth.path === c.artifact) || dSem.relevant_artifacts_results?.some(truth => truth.path === c.artifact));
  
  const truthH2 = findTruth(d.h2_top_20);
  const truthH3 = findTruth(d.h3_top_20);
  
  md += `### Relevant Artifact Details\n`;
  if (truthH2.length > 0) {
    truthH2.forEach(c => {
      md += `- **Artifact:** \`${c.artifact}\`\n`;
      md += `  - **H2 Rank:** ${c.hybrid_evidence.fused_rank}\n`;
      md += `  - **H3 Rank:** ${d.h3_top_20.find(x => x.artifact === c.artifact)?.hybrid_evidence.fused_rank || '> 20'}\n`;
      md += `  - **Deterministic Rank:** ${c.deterministic_evidence.found ? c.deterministic_evidence.rank : 'Not Found'} (${c.deterministic_evidence.tier || 'None'})\n`;
      md += `  - **Semantic Rank:** ${c.semantic_evidence.found ? c.semantic_evidence.rank : 'Not Found'} (Sim: ${c.semantic_evidence.similarity?.toFixed(3) || 'N/A'})\n\n`;
    });
  } else {
    md += `*No relevant artifacts found in Top 20 for H2/H3.*\n\n`;
  }
}

fs.writeFileSync(path.join(__dirname, 'outputs', 'report.md'), md);
console.log('Report generated');
