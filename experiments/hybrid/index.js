const fs = require('fs');
const path = require('path');
const yaml = require('../structural/node_modules/js-yaml');

const CASES_DIR = path.join(__dirname, '../../docs/evaluation/cases');
const DET_OUTPUTS = path.join(__dirname, '../ranking/outputs');
const SEM_OUTPUTS = path.join(__dirname, '../semantic/outputs');
const OUT_DIR = path.join(__dirname, 'outputs');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return null; }
}

function evaluateTopK(ranked, truthPaths, K) {
  const topK = ranked.slice(0, K);
  for (const c of topK) {
    if (truthPaths.has(c.artifact)) return true;
  }
  return false;
}

function runHybrid() {
  const caseFiles = fs.readdirSync(CASES_DIR).filter(f => f.startsWith('case-') && f.endsWith('.yaml'));
  const cases = caseFiles.map(f => {
    return yaml.load(fs.readFileSync(path.join(CASES_DIR, f), 'utf-8'));
  });

  const summary = {};

  for (const caseData of cases) {
    const caseId = caseData.case_id;
    const detData = loadJson(path.join(DET_OUTPUTS, `${caseId}.json`));
    const semData = loadJson(path.join(SEM_OUTPUTS, `${caseId}.json`));

    if (!detData || !semData) {
      console.log(`Skipping ${caseId} due to missing input data.`);
      continue;
    }

    const truthPaths = new Set((caseData.candidates || []).map(c => c.path));
    
    // Build union map
    const unionMap = new Map();

    const getOrAdd = (p) => {
      if (!unionMap.has(p)) {
        unionMap.set(p, {
          artifact: p,
          deterministic_evidence: { found: false, rank: null, signals: [], tier: null },
          semantic_evidence: { found: false, rank: null, similarity: null },
          hybrid_evidence: {}
        });
      }
      return unionMap.get(p);
    };

    // Deterministic
    (detData.all_candidates || []).forEach(c => {
      const cand = getOrAdd(c.path);
      cand.deterministic_evidence = {
        found: true,
        rank: c.rank,
        signals: c.signals,
        tier: c.rank_name
      };
    });

    // Semantic
    (semData.all_candidates || []).forEach((c, idx) => {
      const cand = getOrAdd(c.path);
      cand.semantic_evidence = {
        found: true,
        rank: idx + 1,
        similarity: c.similarity
      };
    });

    const allCandidates = Array.from(unionMap.values());

    // Evaluate H1 (Coverage Union)
    const h1Coverage = (K) => {
      const detTop = (detData.all_candidates || []).slice(0, K).map(c => c.path);
      const semTop = (semData.all_candidates || []).slice(0, K).map(c => c.path);
      const h1Set = new Set([...detTop, ...semTop]);
      for (const p of h1Set) {
        if (truthPaths.has(p)) return true;
      }
      return false;
    };

    // Evaluate H2 (RRF)
    const K_RRF = 60;
    const h2Candidates = allCandidates.map(c => {
      const detScore = c.deterministic_evidence.found ? 1 / (K_RRF + c.deterministic_evidence.rank) : 0;
      const semScore = c.semantic_evidence.found ? 1 / (K_RRF + c.semantic_evidence.rank) : 0;
      const score = detScore + semScore;
      return { ...c, h2_score: score };
    });

    h2Candidates.sort((a, b) => {
      if (b.h2_score !== a.h2_score) return b.h2_score - a.h2_score;
      
      const getTierLvl = (tierStr) => {
        if (!tierStr) return 99;
        const match = tierStr.match(/^(\d+)/);
        return match ? parseInt(match[1]) : 99;
      };
      const tierA = getTierLvl(a.deterministic_evidence.tier);
      const tierB = getTierLvl(b.deterministic_evidence.tier);
      if (tierA !== tierB) return tierA - tierB;

      return a.artifact.localeCompare(b.artifact);
    });

    // Evaluate H3 (Evidence-aware Precedence)
    const h3Candidates = allCandidates.map(c => {
      let h3_tier = 99;
      const detFound = c.deterministic_evidence.found;
      const semFound = c.semantic_evidence.found;
      
      const getTierLvl = (tierStr) => {
        if (!tierStr) return 99;
        const match = tierStr.match(/^(\d+)/);
        return match ? parseInt(match[1]) : 99;
      };
      
      const detTierLvl = getTierLvl(c.deterministic_evidence.tier);
      
      if (detFound && detTierLvl <= 2) {
        h3_tier = 1; // Tier A
      } else if (detFound && detTierLvl > 2) {
        h3_tier = 2; // Tier B
      } else if (semFound && !detFound) {
        h3_tier = 3; // Tier C
      }

      return { ...c, h3_tier };
    });

    h3Candidates.sort((a, b) => {
      if (a.h3_tier !== b.h3_tier) return a.h3_tier - b.h3_tier;
      
      // Tie-breaker within tier: RRF score
      const scoreA = (a.deterministic_evidence.found ? 1 / (K_RRF + a.deterministic_evidence.rank) : 0) + (a.semantic_evidence.found ? 1 / (K_RRF + a.semantic_evidence.rank) : 0);
      const scoreB = (b.deterministic_evidence.found ? 1 / (K_RRF + b.deterministic_evidence.rank) : 0) + (b.semantic_evidence.found ? 1 / (K_RRF + b.semantic_evidence.rank) : 0);
      if (scoreA !== scoreB) return scoreB - scoreA;
      
      return a.artifact.localeCompare(b.artifact);
    });
    
    // Add hybrid evidence reporting
    h2Candidates.forEach((c, idx) => c.hybrid_evidence = { fusion_method: 'H2 (RRF)', fused_rank: idx + 1 });
    h3Candidates.forEach((c, idx) => c.hybrid_evidence = { fusion_method: 'H3 (Precedence)', fused_rank: idx + 1 });

    const report = {
      case_id: caseId,
      metrics: {
        total_union: allCandidates.length,
        h1: {
          top_1: h1Coverage(1),
          top_3: h1Coverage(3),
          top_5: h1Coverage(5),
          top_10: h1Coverage(10),
          top_20: h1Coverage(20),
        },
        h2: {
          top_1: evaluateTopK(h2Candidates, truthPaths, 1),
          top_3: evaluateTopK(h2Candidates, truthPaths, 3),
          top_5: evaluateTopK(h2Candidates, truthPaths, 5),
          top_10: evaluateTopK(h2Candidates, truthPaths, 10),
          top_20: evaluateTopK(h2Candidates, truthPaths, 20),
        },
        h3: {
          top_1: evaluateTopK(h3Candidates, truthPaths, 1),
          top_3: evaluateTopK(h3Candidates, truthPaths, 3),
          top_5: evaluateTopK(h3Candidates, truthPaths, 5),
          top_10: evaluateTopK(h3Candidates, truthPaths, 10),
          top_20: evaluateTopK(h3Candidates, truthPaths, 20),
        }
      },
      h2_top_20: h2Candidates.slice(0, 20),
      h3_top_20: h3Candidates.slice(0, 20)
    };

    summary[caseId] = report;
    fs.writeFileSync(path.join(OUT_DIR, `${caseId}.json`), JSON.stringify(report, null, 2));
  }
  
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log("Hybrid evaluation complete!");
}

runHybrid();
