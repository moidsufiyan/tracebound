const fs = require('fs');
const path = require('path');

const B1_OUTPUTS = path.join(__dirname, '../structural/outputs');
const B2_OUTPUTS = path.join(__dirname, '../lexical/outputs');
const OUTPUT_DIR = path.join(__dirname, 'outputs');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    return null;
  }
}

// Deterministic Tier Ranking strategy
// Tier 1: Structural dependencies (B1)
// Tier 2: Strong Lexical (B2) - Matches multiple terms or path matches
// Tier 3: Weak Lexical (B2) - Matches single content term
function assignTier(candidate) {
  if (candidate.signals.includes('B1')) {
    return 'Tier 1 (Structural)';
  }
  
  if (candidate.signals.includes('B2')) {
    // Check if it's a documentation path or has path matches
    const hasPathMatch = candidate.b2_evidence.some(e => e.includes('Path matched token'));
    const evidenceCount = candidate.b2_evidence.length;
    
    if (hasPathMatch || evidenceCount >= 3) {
      return 'Tier 2 (Strong Lexical)';
    }
    return 'Tier 3 (Weak Lexical)';
  }
  
  return 'Tier 4 (Unknown)';
}

// Check if string ends with documentation extension
function isDocs(path) {
  return path.endsWith('.md') || path.endsWith('.txt');
}

async function runB5() {
  const CASES_DIR = path.join(__dirname, '../../docs/evaluation/cases');
  const yaml = require('js-yaml');
  const caseFiles = fs.readdirSync(CASES_DIR).filter(f => f.startsWith('case-') && f.endsWith('.yaml'));
  const cases = caseFiles.map(f => {
    const caseData = yaml.load(fs.readFileSync(path.join(CASES_DIR, f), 'utf-8'));
    return caseData.case_id;
  });
  const results = {};

  for (const caseId of cases) {
    console.log(`\nAggregating B5 for ${caseId}...`);
    
    const b1Data = loadJson(path.join(B1_OUTPUTS, `${caseId}.json`));
    const b2Data = loadJson(path.join(B2_OUTPUTS, `${caseId}.json`));
    const caseNum = caseId.split('-')[1].substring(1);
    const caseFile = `case-${caseNum}.yaml`;
    const caseData = yaml.load(fs.readFileSync(path.join(CASES_DIR, caseFile), 'utf-8'));
    
    if (!b1Data || !b2Data) {
      console.error(`Missing B1 or B2 data for ${caseId}`);
      continue;
    }

    const mergedCandidates = new Map();

    const addOrUpdateCandidate = (sourcePath, signal, evidence) => {
      if (!mergedCandidates.has(sourcePath)) {
        mergedCandidates.set(sourcePath, {
          path: sourcePath,
          signals: [],
          b1_evidence: [],
          b2_evidence: [],
        });
      }
      
      const candidate = mergedCandidates.get(sourcePath);
      if (!candidate.signals.includes(signal)) {
        candidate.signals.push(signal);
      }
      
      if (signal === 'B1') {
        candidate.b1_evidence.push(...evidence);
      } else if (signal === 'B2') {
        candidate.b2_evidence.push(...evidence);
      }
    };

    // Process B1
    (b1Data.relevant_found || []).forEach(c => addOrUpdateCandidate(c.path, 'B1', c.evidence));
    (b1Data.false_positives || []).forEach(c => addOrUpdateCandidate(c.path, 'B1', c.evidence));

    // Process B2
    (b2Data.relevant_found || []).forEach(c => addOrUpdateCandidate(c.path, 'B2', c.evidence));
    (b2Data.false_positives || []).forEach(c => addOrUpdateCandidate(c.path, 'B2', c.evidence));

    // Apply ranking
    const rankedCandidates = Array.from(mergedCandidates.values()).map(c => {
      c.tier = assignTier(c);
      return c;
    });

    // Sort by Tier
    rankedCandidates.sort((a, b) => a.tier.localeCompare(b.tier));

    // Ground truth evaluation
    const truthCandidates = caseData.candidates || [];
    const truthPaths = new Set(truthCandidates.map(c => c.path));
    const changedPaths = new Set((caseData.changed_artifacts || []).map(a => a.path));
    
    let relevantFound = [];
    let relevantMissed = [];
    let falsePositives = [];

    // Counters for analysis
    let onlyB1 = 0;
    let onlyB2 = 0;
    let both = 0;
    let changedRelevant = 0;
    let unchangedRelevant = 0;

    for (const c of rankedCandidates) {
      if (truthPaths.has(c.path)) {
        relevantFound.push(c);
        
        if (c.signals.includes('B1') && !c.signals.includes('B2')) onlyB1++;
        if (!c.signals.includes('B1') && c.signals.includes('B2')) onlyB2++;
        if (c.signals.includes('B1') && c.signals.includes('B2')) both++;
        
        if (changedPaths.has(c.path)) changedRelevant++;
        else unchangedRelevant++;

      } else {
        if (!changedPaths.has(c.path)) {
          falsePositives.push(c);
        }
      }
    }

    for (const c of truthCandidates) {
      if (!mergedCandidates.has(c.path)) {
        relevantMissed.push(c.path);
      }
    }

    const report = {
      case_id: caseId,
      metrics: {
        b1_retrieved: b1Data.metrics.total_retrieved,
        b2_retrieved: b2Data.metrics.total_retrieved,
        union_retrieved: rankedCandidates.length,
        relevant_found: relevantFound.length,
        relevant_missed: relevantMissed.length,
        false_positives: falsePositives.length,
        only_b1: onlyB1,
        only_b2: onlyB2,
        both: both,
        changed_relevant: changedRelevant,
        unchanged_relevant: unchangedRelevant
      },
      relevant_found: relevantFound,
      relevant_missed: relevantMissed,
      false_positives: falsePositives
    };

    results[caseId] = report;
    fs.writeFileSync(path.join(OUTPUT_DIR, `${caseId}.json`), JSON.stringify(report, null, 2));
    console.log(`Finished ${caseId}. Total Union: ${rankedCandidates.length}. Relevant: ${relevantFound.length}`);
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, 'summary.json'), JSON.stringify(results, null, 2));
  console.log('Done!');
}

runB5().catch(console.error);
