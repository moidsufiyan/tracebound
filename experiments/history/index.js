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

// Execute a git command and return output
function runGit(repoPath, cmd) {
  try {
    return execSync(`git -C "${repoPath}" ${cmd}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    return '';
  }
}

// Get all commits modifying a specific file, strictly up to base_commit
function getCommitsModifyingFile(repoPath, baseCommit, filePath) {
  const output = runGit(repoPath, `log --format="%H|%at" ${baseCommit} -- "${filePath}"`);
  if (!output) return [];
  return output.split('\n').filter(Boolean).map(line => {
    const [hash, timestamp] = line.split('|');
    return { hash, timestamp: parseInt(timestamp, 10) };
  });
}

// Get all files modified in a specific commit
function getFilesInCommit(repoPath, commitHash) {
  const output = runGit(repoPath, `show --name-only --format="" ${commitHash}`);
  if (!output) return [];
  return output.split('\n').filter(Boolean).map(f => f.trim());
}

async function runB3() {
  const caseFiles = fs.readdirSync(CASES_DIR).filter(f => f.startsWith('case-') && f.endsWith('.yaml'));
  const results = {};

  for (const file of caseFiles) {
    const casePath = path.join(CASES_DIR, file);
    const caseData = yaml.load(fs.readFileSync(casePath, 'utf-8'));
    const caseId = caseData.case_id;
    
    console.log(`\nRunning B3 for ${caseId}...`);
    const repoPath = REPOS[caseData.repository.name];
    if (!repoPath) {
      console.error(`Repo path not found for ${caseData.repository.name}`);
      continue;
    }

    const baseCommit = caseData.repository.base_commit;
    const changedArtifacts = (caseData.changed_artifacts || []).map(a => a.path);
    
    if (changedArtifacts.length === 0) {
      console.log(`No changed artifacts found for ${caseId}`);
      continue;
    }

    // Map: co-changed path -> { source_artifact, commits: Set<hash>, latest_ts: number }
    const coChangeMap = new Map();

    for (const sourceFile of changedArtifacts) {
      const commits = getCommitsModifyingFile(repoPath, baseCommit, sourceFile);
      
      for (const commit of commits) {
        const filesInCommit = getFilesInCommit(repoPath, commit.hash);
        
        for (const coFile of filesInCommit) {
          // Exclude the source file itself
          if (coFile === sourceFile) continue;
          
          if (!coChangeMap.has(coFile)) {
            coChangeMap.set(coFile, {
              source_artifact: sourceFile,
              commits: new Set(),
              commitDetails: [],
              latest_ts: 0
            });
          }
          
          const entry = coChangeMap.get(coFile);
          if (!entry.commits.has(commit.hash)) {
            entry.commits.add(commit.hash);
            entry.commitDetails.push({ id: commit.hash, timestamp: commit.timestamp });
            if (commit.timestamp > entry.latest_ts) {
              entry.latest_ts = commit.timestamp;
            }
          }
        }
      }
    }

    const truthCandidates = caseData.candidates || [];
    const truthPaths = new Set(truthCandidates.map(c => c.path));
    
    let relevantFound = [];
    let relevantMissed = [];
    let falsePositives = [];

    // Filter and build candidate objects
    const candidates = Array.from(coChangeMap.entries()).map(([coFile, data]) => {
      // Sort commits descending by timestamp
      data.commitDetails.sort((a, b) => b.timestamp - a.timestamp);
      
      return {
        path: coFile,
        source_artifact: data.source_artifact,
        co_change_count: data.commits.size,
        latest_timestamp: data.latest_ts,
        historical_commits: data.commitDetails,
        signals: ['B3']
      };
    });
    
    // Sort logic for transparent evidence ordering:
    // 1. Frequency (co_change_count descending)
    // 2. Recency (latest_timestamp descending)
    // 3. Path localeCompare
    candidates.sort((a, b) => {
      if (a.co_change_count !== b.co_change_count) {
        return b.co_change_count - a.co_change_count;
      }
      if (a.latest_timestamp !== b.latest_timestamp) {
        return b.latest_timestamp - a.latest_timestamp;
      }
      return a.path.localeCompare(b.path);
    });

    const changedPathsSet = new Set(changedArtifacts);

    for (const c of candidates) {
      c.rank = candidates.indexOf(c) + 1;
      
      if (truthPaths.has(c.path)) {
        relevantFound.push(c);
      } else {
        // Exclude other changed artifacts from being treated as false positives?
        // Wait, other changed artifacts technically are co-changed. Let's keep them in the output but flag them.
        if (!changedPathsSet.has(c.path)) {
          falsePositives.push(c);
        }
      }
    }

    for (const c of truthCandidates) {
      if (!coChangeMap.has(c.path)) {
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

runB3().catch(console.error);
