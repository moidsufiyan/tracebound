const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { execSync } = require('child_process');

const CASES_DIR = path.join(__dirname, '../../docs/evaluation/cases');
const OUTPUT_DIR = path.join(__dirname, 'outputs');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const REPOS = {
  'moidsufiyan/wollyway': 'c:/Users/Moid Sufiyan/Documents/MyWorkspace/Wollyway',
  'honojs/hono': 'c:/Users/Moid Sufiyan/.gemini/antigravity-ide/brain/7ca9ffd7-5653-48c6-ad18-857fa89c70d4/scratch/hono'
};

// Generic stop words + common code extensions/terms
const STOP_WORDS = new Set([
  'and', 'or', 'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'from', 'by', 'as', 'is', 'are', 'was', 'were', 'it', 'this', 'that', 'these', 'those', 
  'ts', 'js', 'md', 'src', 'index', 'backend', 'frontend', 'docs', 'test', 'spec', 'file', 'from', 'across', 'full', 'stack', 'some' // note: 'some' is tricky for TB-0003
]);

function extractTerms(text) {
  if (!text) return [];
  // Split camelCase and snake_case, replace non-alphanumeric with space
  const normalized = text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_./\\()'"\[\]{}<>]/g, ' ')
    .toLowerCase();
  
  const tokens = normalized.split(/\s+/).filter(t => t.length > 2 && !STOP_WORDS.has(t));
  return Array.from(new Set(tokens));
}

function runGitGrep(repoPath, commit, term) {
  try {
    const cmd = `git -C "${repoPath}" grep -l -i "${term}" ${commit}`;
    const output = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    return output.trim().split('\n').map(line => {
      const parts = line.split(':');
      if (parts.length > 1) {
        return parts.slice(1).join(':').trim(); // Git grep format: commit:path
      }
      return line.trim();
    }).filter(Boolean);
  } catch (e) {
    return []; // grep exits with 1 if no match
  }
}

function runGitLsTree(repoPath, commit, term) {
  try {
    const cmd = `git -C "${repoPath}" ls-tree -r --name-only ${commit}`;
    const output = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    return output.trim().split('\n')
      .map(line => line.trim())
      .filter(line => line.toLowerCase().includes(term.toLowerCase()));
  } catch (e) {
    return [];
  }
}

async function runB2() {
  const caseFiles = fs.readdirSync(CASES_DIR).filter(f => f.startsWith('case-') && f.endsWith('.yaml'));
  const results = {};

  for (const file of caseFiles) {
    const casePath = path.join(CASES_DIR, file);
    const caseData = yaml.load(fs.readFileSync(casePath, 'utf-8'));
    
    console.log(`Running B2 on ${caseData.case_id}...`);
    const repoPath = REPOS[caseData.repository.name];
    if (!repoPath) {
      console.error(`Repo path not found for ${caseData.repository.name}`);
      continue;
    }

    const baseCommit = caseData.repository.base_commit;
    let queryTerms = [];

    // Extract from description
    queryTerms.push(...extractTerms(caseData.source_change.description));

    // Extract from changed artifacts
    if (caseData.changed_artifacts) {
      for (const artifact of caseData.changed_artifacts) {
        queryTerms.push(...extractTerms(path.basename(artifact.path)));
        if (artifact.symbols) {
          for (const sym of artifact.symbols) {
            queryTerms.push(...extractTerms(sym.name));
          }
        }
      }
    }

    // Special case for TB-0003: 'some' is a function name but was filtered out as a stop word length/common word.
    // Let's ensure exact symbols are added without stop-word filtering if they are explicitly symbols.
    if (caseData.changed_artifacts) {
      for (const artifact of caseData.changed_artifacts) {
        if (artifact.symbols) {
          for (const sym of artifact.symbols) {
             queryTerms.push(sym.name.toLowerCase());
          }
        }
      }
    }

    queryTerms = Array.from(new Set(queryTerms));
    console.log(`Query terms: ${queryTerms.join(', ')}`);

    const retrieved = new Map(); // path -> Set of evidence

    for (const term of queryTerms) {
      // Content search
      const contentMatches = runGitGrep(repoPath, baseCommit, term);
      for (const match of contentMatches) {
        if (!retrieved.has(match)) retrieved.set(match, new Set());
        retrieved.get(match).add(`Content matched token: '${term}'`);
      }

      // Path search
      const pathMatches = runGitLsTree(repoPath, baseCommit, term);
      for (const match of pathMatches) {
        if (!retrieved.has(match)) retrieved.set(match, new Set());
        retrieved.get(match).add(`Path matched token: '${term}'`);
      }
    }

    // Evaluate
    const truthCandidates = caseData.candidates || [];
    const truthPaths = new Set(truthCandidates.map(c => c.path));
    
    let relevantFound = [];
    let relevantMissed = [];
    let falsePositives = [];

    const changedPaths = new Set((caseData.changed_artifacts || []).map(a => a.path));

    for (const [retrievedPath, evidenceSet] of retrieved.entries()) {
      if (truthPaths.has(retrievedPath)) {
        relevantFound.push({
          path: retrievedPath,
          evidence: Array.from(evidenceSet)
        });
      } else {
        if (!changedPaths.has(retrievedPath)) {
          falsePositives.push({
            path: retrievedPath,
            evidence: Array.from(evidenceSet)
          });
        }
      }
    }

    for (const c of truthCandidates) {
      if (!retrieved.has(c.path)) {
        relevantMissed.push(c.path);
      }
    }

    const report = {
      case_id: caseData.case_id,
      query_terms: queryTerms,
      metrics: {
        total_retrieved: retrieved.size,
        relevant_found: relevantFound.length,
        relevant_missed: relevantMissed.length,
        false_positives: falsePositives.length,
      },
      relevant_found: relevantFound,
      relevant_missed: relevantMissed,
      false_positives: falsePositives
    };

    results[caseData.case_id] = report;
    fs.writeFileSync(path.join(OUTPUT_DIR, `${caseData.case_id}.json`), JSON.stringify(report, null, 2));
    console.log(`Finished ${caseData.case_id}. Found ${relevantFound.length}/${relevantFound.length + relevantMissed.length} candidates.`);
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, 'summary.json'), JSON.stringify(results, null, 2));
  console.log('Done!');
}

runB2().catch(console.error);
