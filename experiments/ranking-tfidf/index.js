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

// 1. Compute DF (Document Frequency) for all tokens across all candidates in a case
function computeDF(candidates) {
  const df = new Map(); // token -> count of documents containing it
  candidates.forEach(c => {
    const tokens = new Set();
    c.b2_evidence.forEach(ev => {
      const match = ev.match(/matched token: '([^']+)'/);
      if (match) {
        tokens.add(match[1]);
      }
    });
    tokens.forEach(t => {
      df.set(t, (df.get(t) || 0) + 1);
    });
  });
  return df;
}

// 2. Compute TF-IDF Score for a candidate
// N = 10000 (Generic fixed corpus size assumption for relative IDF)
// TF = 1 (Boolean presence)
function computeTfIdf(candidate, dfMap) {
  const N = 10000; 
  let score = 0;
  const matchedTokens = new Set();
  const tokenContributions = [];
  let pathMatches = 0;

  candidate.b2_evidence.forEach(ev => {
    const match = ev.match(/matched token: '([^']+)'/);
    if (match) {
      const token = match[1];
      if (ev.startsWith('Path matched')) {
        pathMatches++;
      }
      if (!matchedTokens.has(token)) {
        matchedTokens.add(token);
        const df = dfMap.get(token) || 1;
        // IDF Formula
        const idf = Math.log(N / df);
        score += idf; // TF is 1
        tokenContributions.push({ token, df, idf });
      }
    }
  });

  return {
    score,
    tokens: matchedTokens.size,
    pathMatches,
    contributions: tokenContributions.sort((a, b) => b.idf - a.idf)
  };
}

// Categorical Precedence (Lower is better) - Preserving B6 structure
function getRankingCategory(candidate, tfidfData) {
  const b1Str = candidate.b1_evidence.join(' ');
  const isReverseOrTest = b1Str.includes('[Reverse Import]') || b1Str.includes('[Test-to-Source Dependency]');
  const isDirect = b1Str.includes('[Direct Import]');
  
  const allCount = tfidfData.tokens;
  const pathCount = tfidfData.pathMatches;
  
  let categoryLevel = 99;
  let categoryName = '';
  
  if (isReverseOrTest) {
    categoryLevel = 1;
    categoryName = '1. Critical Structural (Incoming Dependent / Test)';
  } else if (pathCount > 0 && allCount >= 3) {
    categoryLevel = 2;
    categoryName = '2. Strong Lexical (Path + Multi-Content)';
  } else if (allCount >= 5) {
    categoryLevel = 3;
    categoryName = '3. Strong Lexical (High Content Density)';
  } else if (isDirect) {
    categoryLevel = 4;
    categoryName = '4. Weak Structural (Outgoing Dependency)';
  } else if (pathCount > 0) {
    categoryLevel = 5;
    categoryName = '5. Moderate Lexical (Path Match Only)';
  } else if (allCount >= 2) {
    categoryLevel = 6;
    categoryName = '6. Moderate Lexical (Multiple Tokens)';
  } else {
    categoryLevel = 7;
    categoryName = '7. Weak Lexical (Single Token / Generic)';
  }
  
  return { level: categoryLevel, name: categoryName };
}

function rankCandidates(candidates) {
  const dfMap = computeDF(candidates);

  return candidates.map(c => {
    const tfidf = computeTfIdf(c, dfMap);
    const cat = getRankingCategory(c, tfidf);
    return {
      ...c,
      rank_level: cat.level,
      rank_name: cat.name,
      tfidf_score: tfidf.score,
      lex_all_count: tfidf.tokens, // preserve for comparison
      lex_path_count: tfidf.pathMatches,
      tfidf_contributions: tfidf.contributions
    };
  }).sort((a, b) => {
    // 1. Categorical Precedence (Structural preserved)
    if (a.rank_level !== b.rank_level) {
      return a.rank_level - b.rank_level;
    }
    // 2. TF-IDF Score
    if (a.tfidf_score !== b.tfidf_score) {
      return b.tfidf_score - a.tfidf_score;
    }
    // 3. Fallbacks
    if (a.path.length !== b.path.length) {
      return a.path.length - b.path.length;
    }
    return a.path.localeCompare(b.path);
  });
}

function evaluateTopK(ranked, truthPath, K) {
  const topK = ranked.slice(0, K);
  return topK.some(c => c.path === truthPath);
}

async function runB6_1() {
  const cases = ['TB-0001', 'TB-0002', 'TB-0003'];
  const summaryReport = {};

  for (const caseId of cases) {
    const b5Data = loadJson(path.join(B5_OUTPUTS, `${caseId}.json`));
    if (!b5Data) continue;
    
    console.log(`\nRanking B6.1 for ${caseId}...`);
    
    const allCandidates = [...b5Data.relevant_found, ...(b5Data.false_positives || [])];
    const truthCandidate = b5Data.relevant_found.length > 0 ? b5Data.relevant_found[0].path : null;
    
    const ranked = rankCandidates(allCandidates);
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
        tfidf_score: c.tfidf_score,
        lex_all_count: c.lex_all_count,
        is_truth: c.path === truthCandidate,
        contributions: c.tfidf_contributions.map(t => `${t.token}: ${t.idf.toFixed(2)} (DF: ${t.df})`)
      }))
    };
    
    summaryReport[caseId] = report;
    fs.writeFileSync(path.join(OUTPUT_DIR, `${caseId}.json`), JSON.stringify(report, null, 2));
    
    console.log(`Truth rank for ${caseId}: ${truthRank > 0 ? truthRank : 'Not Found'}`);
  }
  
  fs.writeFileSync(path.join(OUTPUT_DIR, 'summary.json'), JSON.stringify(summaryReport, null, 2));
  console.log('Done!');
}

runB6_1().catch(console.error);
