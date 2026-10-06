const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { execSync } = require('child_process');
const parser = require('@babel/parser');

const CASES_DIR = path.join(__dirname, '../../docs/evaluation/cases');
const OUTPUT_DIR = path.join(__dirname, 'outputs');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const REPOS = {
  'moidsufiyan/wollyway': 'c:/Users/Moid Sufiyan/Documents/MyWorkspace/Wollyway',
  'honojs/hono': 'c:/Users/Moid Sufiyan/.gemini/antigravity-ide/brain/7ca9ffd7-5653-48c6-ad18-857fa89c70d4/scratch/hono'
};

// --- Git Helpers ---

function getTrackedFiles(repoPath, commit) {
  try {
    const cmd = `git -C "${repoPath}" ls-tree -r --name-only ${commit}`;
    const output = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    return output.trim().split('\n').map(line => line.trim()).filter(Boolean);
  } catch (e) {
    return [];
  }
}

function getFileContent(repoPath, commit, filePath) {
  try {
    const cmd = `git -C "${repoPath}" show ${commit}:${filePath}`;
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
  } catch (e) {
    return null;
  }
}

// --- Path Resolution ---

// Naive resolution matching a specifier to a repository path
function resolveModule(sourcePath, specifier, allTrackedFiles) {
  if (!specifier.startsWith('.')) {
    // We explicitly defer resolving node_modules or absolute path aliases for this simple experiment.
    return null;
  }

  const dir = path.dirname(sourcePath);
  // path.join on Windows uses '\', but git paths use '/'
  let resolvedBase = path.posix.join(dir, specifier);
  
  // Possible extensions for TS/JS
  const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];
  
  for (const ext of extensions) {
    const candidate = resolvedBase + ext;
    if (allTrackedFiles.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

// --- AST Parsing ---

function extractImports(sourceCode) {
  const imports = [];
  try {
    const ast = parser.parse(sourceCode, {
      sourceType: 'module',
      plugins: ['typescript']
    });

    function visit(node) {
      if (!node) return;
      if (node.type === 'ImportDeclaration') {
        const specifier = node.source.value;
        const line = node.loc ? node.loc.start.line : 0;
        // Reconstruct basic text for evidence
        const specifiers = node.specifiers.map(s => s.local.name).join(', ');
        const text = `import ${specifiers ? `{ ${specifiers} }` : '*'} from '${specifier}'`;
        
        imports.push({
          specifier: specifier,
          line: line,
          text: text
        });
      }

      for (const key in node) {
        if (node.hasOwnProperty(key)) {
          const child = node[key];
          if (Array.isArray(child)) {
            child.forEach(visit);
          } else if (child && typeof child === 'object' && typeof child.type === 'string') {
            visit(child);
          }
        }
      }
    }

    visit(ast.program);
  } catch (e) {
    // Parser failed (e.g. invalid syntax)
  }
  return imports;
}

// --- Main Pipeline ---

async function runB1() {
  const caseFiles = fs.readdirSync(CASES_DIR).filter(f => f.startsWith('case-') && f.endsWith('.yaml'));
  const results = {};

  for (const file of caseFiles) {
    const casePath = path.join(CASES_DIR, file);
    const caseData = yaml.load(fs.readFileSync(casePath, 'utf-8'));
    
    console.log(`\nRunning B1 on ${caseData.case_id}...`);
    const repoPath = REPOS[caseData.repository.name];
    if (!repoPath) {
      console.error(`Repo path not found for ${caseData.repository.name}`);
      continue;
    }

    const baseCommit = caseData.repository.base_commit;
    const trackedFilesList = getTrackedFiles(repoPath, baseCommit);
    const trackedFiles = new Set(trackedFilesList);

    // Filter to parsable files (.ts, .tsx, .js, .jsx)
    const parsableFiles = trackedFilesList.filter(f => f.match(/\.(ts|tsx|js|jsx)$/));

    console.log(`Found ${parsableFiles.length} parsable files at ${baseCommit}`);

    // Build the dependency graph
    // Map: targetPath -> array of { sourcePath, specifier, line, text }
    const reverseImports = new Map();
    // Map: sourcePath -> array of { targetPath, specifier, line, text }
    const forwardImports = new Map();

    for (const filePath of parsableFiles) {
      const content = getFileContent(repoPath, baseCommit, filePath);
      if (!content) continue;

      const fileImports = extractImports(content);
      for (const imp of fileImports) {
        const targetPath = resolveModule(filePath, imp.specifier, trackedFiles);
        if (targetPath) {
          // Forward
          if (!forwardImports.has(filePath)) forwardImports.set(filePath, []);
          forwardImports.get(filePath).push({ ...imp, targetPath });

          // Reverse
          if (!reverseImports.has(targetPath)) reverseImports.set(targetPath, []);
          reverseImports.get(targetPath).push({ ...imp, sourcePath: filePath });
        }
      }
    }

    // Now process changed artifacts
    const changedPaths = (caseData.changed_artifacts || []).map(a => a.path);
    const retrieved = new Map(); // path -> Set of evidence

    for (const changed of changedPaths) {
      // 1. Module import relationship (changed file imports candidate)
      const outgoing = forwardImports.get(changed) || [];
      for (const out of outgoing) {
        if (!retrieved.has(out.targetPath)) retrieved.set(out.targetPath, new Set());
        retrieved.get(out.targetPath).add(
          `[Direct Import] Source artifact (${changed}) imports candidate at line ${out.line}: \`${out.text}\``
        );
      }

      // 2. Reverse importer relationship & Test-to-source
      const incoming = reverseImports.get(changed) || [];
      for (const inc of incoming) {
        if (!retrieved.has(inc.sourcePath)) retrieved.set(inc.sourcePath, new Set());
        
        // Is it a test?
        if (inc.sourcePath.includes('.test.') || inc.sourcePath.includes('.spec.')) {
          retrieved.get(inc.sourcePath).add(
            `[Test-to-Source Dependency] Test artifact (${inc.sourcePath}) imports changed source at line ${inc.line}: \`${inc.text}\``
          );
        } else {
          retrieved.get(inc.sourcePath).add(
            `[Reverse Import] Candidate artifact (${inc.sourcePath}) imports changed source at line ${inc.line}: \`${inc.text}\``
          );
        }
      }
    }

    // Evaluate
    const truthCandidates = caseData.candidates || [];
    const truthPaths = new Set(truthCandidates.map(c => c.path));
    
    let relevantFound = [];
    let relevantMissed = [];
    let falsePositives = [];
    const changedPathsSet = new Set(changedPaths);

    for (const [retrievedPath, evidenceSet] of retrieved.entries()) {
      if (truthPaths.has(retrievedPath)) {
        relevantFound.push({
          path: retrievedPath,
          evidence: Array.from(evidenceSet)
        });
      } else {
        if (!changedPathsSet.has(retrievedPath)) {
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
      metrics: {
        total_retrieved: retrieved.size,
        relevant_found: relevantFound.length,
        relevant_missed: relevantMissed.length,
        false_positives: falsePositives.length,
      },
      relevant_found: relevantFound,
      relevant_missed: relevantMissed,
      // false_positives list is written to disk but maybe long
      false_positives: falsePositives
    };

    results[caseData.case_id] = report;
    fs.writeFileSync(path.join(OUTPUT_DIR, `${caseData.case_id}.json`), JSON.stringify(report, null, 2));
    console.log(`Finished ${caseData.case_id}. Found ${relevantFound.length}/${relevantFound.length + relevantMissed.length} candidates.`);
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, 'summary.json'), JSON.stringify(results, null, 2));
  console.log('\nDone!');
}

runB1().catch(console.error);
