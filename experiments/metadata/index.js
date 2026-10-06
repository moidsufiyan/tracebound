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

function runGit(repoPath, cmd) {
  try {
    return execSync(`git -C "${repoPath}" ${cmd}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    return '';
  }
}

// Extract #123 patterns from commit message
function extractReferences(message) {
  const regex = /#(\d+)/g;
  const matches = new Set();
  let match;
  while ((match = regex.exec(message)) !== null) {
    matches.add(match[1]);
  }
  return Array.from(matches);
}

function getHistoricalCommitsForFile(repoPath, baseCommit, file) {
  const output = runGit(repoPath, `log --format="%H|%at|%B" ${baseCommit} -- "${file}"`);
  if (!output) return [];
  
  const commits = [];
  const entries = output.split(/^[0-9a-f]{40}\|/m);
  const hashes = output.match(/^[0-9a-f]{40}\|/gm);
  
  if (hashes && hashes.length === entries.length - 1) {
    for (let i = 0; i < hashes.length; i++) {
      const hashStr = hashes[i].slice(0, 40);
      const rest = entries[i+1];
      const tsMatch = rest.match(/^(\d+)\|([\s\S]*)/);
      if (tsMatch) {
        commits.push({
          hash: hashStr,
          timestamp: parseInt(tsMatch[1], 10),
          message: tsMatch[2].trim(),
          refs: extractReferences(tsMatch[2])
        });
      }
    }
  }
  return commits;
}

function getCommitsByReference(repoPath, baseCommit, ref) {
  // Use --fixed-strings --grep to find commits mentioning the issue number #REF
  const output = runGit(repoPath, `log --format="%H|%at" --grep="#${ref}\\b" -E ${baseCommit}`);
  if (!output) return [];
  
  return output.split('\n').filter(Boolean).map(line => {
    const [hash, timestamp] = line.split('|');
    return { hash, timestamp: parseInt(timestamp, 10) };
  });
}

function getFilesInCommit(repoPath, commitHash) {
  const output = runGit(repoPath, `show --name-only --format="" ${commitHash}`);
  if (!output) return [];
  return output.split('\n').filter(Boolean).map(f => f.trim());
}

async function runB4() {
  const caseFiles = fs.readdirSync(CASES_DIR).filter(f => f.startsWith('case-') && f.endsWith('.yaml'));
  const results = {};

  for (const file of caseFiles) {
    const casePath = path.join(CASES_DIR, file);
    const caseData = yaml.load(fs.readFileSync(casePath, 'utf-8'));
    const caseId = caseData.case_id;
    
    console.log(`\nRunning B4 for ${caseId}...`);
    const repoPath = REPOS[caseData.repository.name];
    if (!repoPath) {
      console.error(`Repo path not found for ${caseData.repository.name}`);
      continue;
    }

    const baseCommit = caseData.repository.base_commit;
    const changedArtifacts = (caseData.changed_artifacts || []).map(a => a.path);
    
    if (changedArtifacts.length === 0) continue;

    const candidateMap = new Map();
    const checkedRefs = new Set();

    for (const sourceFile of changedArtifacts) {
      const commits = getHistoricalCommitsForFile(repoPath, baseCommit, sourceFile);
      
      for (const commit of commits) {
        if (commit.refs.length === 0) continue;
        
        for (const ref of commit.refs) {
          if (checkedRefs.has(ref)) continue;
          checkedRefs.add(ref);
          
          const siblingCommits = getCommitsByReference(repoPath, baseCommit, ref);
          for (const sib of siblingCommits) {
            // If the sibling commit is just the same commit, skip adding itself as evidence unless we want to, but we already have B3 for co-change.
            // Wait, B4 is for finding explicit PR/Issue links across *different* commits.
            const files = getFilesInCommit(repoPath, sib.hash);
            
            for (const f of files) {
              if (f === sourceFile) continue;
              
              if (!candidateMap.has(f)) {
                candidateMap.set(f, {
                  source_artifact: sourceFile,
                  relationships: new Set(),
                  evidence: []
                });
              }
              
              const entry = candidateMap.get(f);
              const relKey = `Issue/PR #${ref}`;
              if (!entry.relationships.has(relKey)) {
                entry.relationships.add(relKey);
                entry.evidence.push(`Commit ${commit.hash.slice(0,7)} (modified source) and Commit ${sib.hash.slice(0,7)} (modified candidate) both reference #${ref}`);
              }
            }
          }
        }
      }
    }

    const truthCandidates = caseData.candidates || [];
    const truthPaths = new Set(truthCandidates.map(c => c.path));
    const changedPathsSet = new Set(changedArtifacts);
    
    let relevantFound = [];
    let relevantMissed = [];
    let falsePositives = [];

    const candidates = Array.from(candidateMap.entries()).map(([path, data]) => {
      return {
        path,
        source_artifact: data.source_artifact,
        relationship_count: data.relationships.size,
        relationships: Array.from(data.relationships),
        evidence: data.evidence,
        signals: ['B4']
      };
    });
    
    candidates.sort((a, b) => b.relationship_count - a.relationship_count || a.path.localeCompare(b.path));
    
    for (const c of candidates) {
      c.rank = candidates.indexOf(c) + 1;
      if (truthPaths.has(c.path)) {
        relevantFound.push(c);
      } else {
        if (!changedPathsSet.has(c.path)) falsePositives.push(c);
      }
    }
    
    for (const c of truthCandidates) {
      if (!candidateMap.has(c.path)) {
        relevantMissed.push(c.path);
      }
    }

    const report = {
      case_id: caseId,
      metrics: {
        total_retrieved: candidates.length,
        relevant_found: relevantFound.length,
        relevant_missed: relevantMissed.length,
        false_positives: falsePositives.length,
      },
      relevant_found: relevantFound,
      relevant_missed: relevantMissed,
      false_positives: falsePositives
    };

    results[caseId] = report;
    fs.writeFileSync(path.join(OUTPUT_DIR, `${caseId}.json`), JSON.stringify(report, null, 2));
    
    console.log(`Finished ${caseId}. Retrieved: ${candidates.length}. Relevant Found: ${relevantFound.length}.`);
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, 'summary.json'), JSON.stringify(results, null, 2));
  console.log('Done!');
}

runB4().catch(console.error);
