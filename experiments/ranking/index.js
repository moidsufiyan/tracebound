const fs = require('fs');
const path = require('path');

const B5_OUTPUTS = path.join(__dirname, '../combined/outputs');
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

// Extract distinct matched tokens from B2 evidence
function getMatchedTokens(b2Evidence) {
  const tokens = new Set();
  const pathTokens = new Set();
  
  b2Evidence.forEach(ev => {
    const match = ev.match(/matched token: '([^']+)'/);
    if (match) {
      tokens.add(match[1]);
      if (ev.startsWith('Path matched')) {
        pathTokens.add(match[1]);
      }
    }
  });
  
  return {
    allCount: tokens.size,
    pathCount: pathTokens.size
  };
}

// Categorical Precedence (Lower is better)
function getRankingCategory(candidate) {
  const b1Str = candidate.b1_evidence.join(' ');
  const isReverseOrTest = b1Str.includes('[Reverse Import]') || b1Str.includes('[Test-to-Source Dependency]');
  const isDirect = b1Str.includes('[Direct Import]');
  
  const lex = getMatchedTokens(candidate.b2_evidence);
  
  let categoryName = '';
  let categoryLevel = 99;
  
  if (isReverseOrTest) {
    categoryLevel = 1;
    categoryName = '1. Critical Structural (Incoming Dependent / Test)';
  } else if (lex.pathCount > 0 && lex.allCount >= 3) {
    categoryLevel = 2;
    categoryName = '2. Strong Lexical (Path + Multi-Content)';
  } else if (lex.allCount >= 5) {
    categoryLevel = 3;
    categoryName = '3. Strong Lexical (High Content Density)';
  } else if (isDirect) {
    // Outgoing dependencies are structurally sound but logically insulated
    categoryLevel = 4;
    categoryName = '4. Weak Structural (Outgoing Dependency)';
  } else if (lex.pathCount > 0) {
    categoryLevel = 5;
    categoryName = '5. Moderate Lexical (Path Match Only)';
  } else if (lex.allCount >= 2) {
    categoryLevel = 6;
    categoryName = '6. Moderate Lexical (Multiple Tokens)';
  } else {
    categoryLevel = 7;
    categoryName = '7. Weak Lexical (Single Token / Generic)';
  }
  
  return { level: categoryLevel, name: categoryName, lex };
}

function rankCandidates(candidates) {
  return candidates.map(c => {
    const { level, name, lex } = getRankingCategory(c);
    return {
      ...c,
      rank_level: level,
      rank_name: name,
      lex_all_count: lex.allCount,
      lex_path_count: lex.pathCount
    };
  }).sort((a, b) => {
    // 1. Categorical Precedence
    if (a.rank_level !== b.rank_level) {
      return a.rank_level - b.rank_level;
    }
    // 2. Tie-break: Number of distinct lexical tokens
    if (a.lex_all_count !== b.lex_all_count) {
      return b.lex_all_count - a.lex_all_count;
    }
    // 3. Tie-break: Number of path tokens
    if (a.lex_path_count !== b.lex_path_count) {
      return b.lex_path_count - a.lex_path_count;
    }
    // 4. Tie-break: Deterministic path sort (shorter paths first, then alphabetical)
    if (a.path.length !== b.path.length) {
      return a.path.length - b.path.length;
    }
    return a.path.localeCompare(b.path);
  });
}

function evaluateTopK(ranked, truthPath, K) {
  const topK = ranked.slice(0, K);
  const found = topK.some(c => c.path === truthPath);
  return found;
}

async function runB6() {
  const b5Files = fs.readdirSync(B5_OUTPUTS).filter(f => f.startsWith('TB-') && f.endsWith('.json'));
  const cases = b5Files.map(f => f.replace('.json', ''));
  const summaryReport = {};

  for (const caseId of cases) {
    const b5Data = loadJson(path.join(B5_OUTPUTS, `${caseId}.json`));
    if (!b5Data) continue;
    
    console.log(`\nRanking B6 for ${caseId}...`);
    
    // Union of all retrieved candidates in B5
    const allCandidates = [...b5Data.relevant_found, ...b5Data.false_positives];
    
    const truthCandidate = b5Data.relevant_found.length > 0 ? b5Data.relevant_found[0].path : null;
    
    const ranked = rankCandidates(allCandidates);
    
    // Assign explicit rank 1-N
    ranked.forEach((c, idx) => c.rank = idx + 1);
    
    let truthRank = -1;
    if (truthCandidate) {
      const idx = ranked.findIndex(c => c.path === truthCandidate);
      if (idx !== -1) truthRank = idx + 1;
    }

    const report = {
      case_id: caseId,
      metrics: {
        total_candidates: ranked.length,
        truth_rank: truthRank,
        top_1: evaluateTopK(ranked, truthCandidate, 1),
        top_3: evaluateTopK(ranked, truthCandidate, 3),
        top_5: evaluateTopK(ranked, truthCandidate, 5),
        top_10: evaluateTopK(ranked, truthCandidate, 10),
        top_20: evaluateTopK(ranked, truthCandidate, 20)
      },
      top_20_candidates: ranked.slice(0, 20).map(c => ({
        rank: c.rank,
        path: c.path,
        rank_name: c.rank_name,
        signals: c.signals,
        is_truth: c.path === truthCandidate
      })),
      all_candidates: ranked.map(c => ({
        rank: c.rank,
        path: c.path,
        rank_name: c.rank_name,
        signals: c.signals,
        is_truth: c.path === truthCandidate
      }))
    };
    
    summaryReport[caseId] = report;
    fs.writeFileSync(path.join(OUTPUT_DIR, `${caseId}.json`), JSON.stringify(report, null, 2));
    
    console.log(`Truth rank for ${caseId}: ${truthRank > 0 ? truthRank : 'Not Found'}`);
  }
  
  fs.writeFileSync(path.join(OUTPUT_DIR, 'summary.json'), JSON.stringify(summaryReport, null, 2));
  console.log('Done!');
}

runB6().catch(console.error);
