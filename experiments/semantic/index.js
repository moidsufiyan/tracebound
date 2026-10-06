const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { execSync } = require('child_process');
const crypto = require('crypto');

const CASES_DIR = path.join(__dirname, '../../docs/evaluation/cases');
const OUTPUT_DIR = path.join(__dirname, 'outputs');
const CACHE_FILE = path.join(OUTPUT_DIR, 'ollama_embeddings_cache.json');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const MODEL = "nomic-embed-text:v1.5";
const OLLAMA_ENDPOINT = "http://127.0.0.1:11434/api/embed";

const REPOS = {
  'moidsufiyan/wollyway': 'c:/Users/Moid Sufiyan/Documents/MyWorkspace/Wollyway',
  'honojs/hono': 'c:/Users/Moid Sufiyan/.gemini/antigravity-ide/brain/7ca9ffd7-5653-48c6-ad18-857fa89c70d4/scratch/hono'
};

const BINARY_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.webm', '.pdf', '.zip', '.tar', '.gz', '.lock']);

// --- Cache Management ---
let embeddingCache = {};
if (fs.existsSync(CACHE_FILE)) {
  try {
    embeddingCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch(e) {
    console.error("Failed to load cache:", e.message);
  }
}

function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(embeddingCache));
}

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Approximate Tokenizer (4 chars = 1 token roughly)
function isWithinContextLimit(text) {
  // nomic-embed-text:v1.5 limit is 8192 tokens
  const approxTokens = Math.ceil(text.length / 3.5); 
  return approxTokens <= 8192;
}

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

// --- Provider Abstraction ---
async function generateEmbeddings(texts) {
  const missingTexts = [];
  const results = new Array(texts.length);
  
  texts.forEach((text, i) => {
    const h = hashText(text);
    if (embeddingCache[h]) {
      results[i] = embeddingCache[h];
    } else {
      missingTexts.push({ index: i, text, hash: h });
    }
  });

  if (missingTexts.length > 0) {
    // Process in batches
    const BATCH_SIZE = 10;
    for (let i = 0; i < missingTexts.length; i += BATCH_SIZE) {
      const batch = missingTexts.slice(i, i + BATCH_SIZE);
      console.log(`  Fetching ollama embeddings for batch of ${batch.length} items...`);
      try {
        const response = await fetch(OLLAMA_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: MODEL,
            input: batch.map(b => b.text)
          })
        });
        
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Ollama API error (${response.status}): ${errText}`);
        }
        
        const data = await response.json();
        
        data.embeddings.forEach((embedding, j) => {
          const originalIndex = batch[j].index;
          const h = batch[j].hash;
          results[originalIndex] = embedding;
          embeddingCache[h] = embedding;
        });
        saveCache();
      } catch (err) {
        console.error("STOP: Error fetching embeddings from Ollama:", err.message);
        process.exit(1);
      }
    }
  }
  return results;
}

function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// --- Main Pipeline ---
async function runB7() {
  const allCaseFiles = fs.readdirSync(CASES_DIR).filter(f => f.startsWith('case-') && f.endsWith('.yaml'));
  const results = {};

  for (const file of allCaseFiles) {
    const casePath = path.join(CASES_DIR, file);
    const caseData = yaml.load(fs.readFileSync(casePath, 'utf-8'));
    
    console.log(`\n========================================`);
    console.log(`Running B7.0 on ${caseData.case_id}...`);
    
    const repoPath = REPOS[caseData.repository.name];
    if (!repoPath) {
      console.error(`Repo path not found for ${caseData.repository.name}`);
      continue;
    }

    const baseCommit = caseData.repository.base_commit;

    const trackedFilesList = getTrackedFiles(repoPath, baseCommit);
    
    // Filter binary files
    const validFiles = trackedFilesList.filter(f => {
      const ext = path.extname(f).toLowerCase();
      return !BINARY_EXTS.has(ext);
    });

    console.log(`Found ${validFiles.length} text files at ${baseCommit}`);

    // 1. Construct Query
    const changedPaths = (caseData.changed_artifacts || []).map(a => a.path);
    const queryBase = `Change Description: ${caseData.source_change.description}\nFiles Modified:\n${changedPaths.map(p => `- ${p}`).join('\n')}`;
    const queryText = `search_query: ${queryBase}`;
    
    console.log(`Query:\n${queryText}`);
    const [queryEmbedding] = await generateEmbeddings([queryText]);

    // 2. Extract Artifacts & Chunking
    const chunkTexts = [];
    const chunkMetadata = [];
    let excludedArtifacts = 0;
    
    for (const filePath of validFiles) {
      const content = getFileContent(repoPath, baseCommit, filePath);
      if (content === null) continue;
      
      const artifactText = `search_document: File: ${filePath}\n\n${content}`;
      
      if (isWithinContextLimit(artifactText)) {
        chunkTexts.push(artifactText);
        chunkMetadata.push({
          path: filePath,
          chunkId: 'full',
          type: path.extname(filePath),
          hash: hashText(artifactText),
          commit: baseCommit,
          model: MODEL
        });
      } else {
        // Deterministic Chunking (limit ~25,000 chars)
        const ext = path.extname(filePath).toLowerCase();
        let chunks = [];
        let parts = [];
        
        if (ext === '.md' || ext === '.mdx') {
          parts = content.split(/(?=^#+ )/m);
        } else if (['.ts', '.js', '.tsx', '.jsx'].includes(ext)) {
          parts = content.split(/(?=^\s*(export |function |class ))/m);
        } else {
          parts = content.split('\n').map(l => l + '\n');
        }

        let currentChunk = "";
        let chunkIndex = 0;
        
        for (const part of parts) {
          if (currentChunk.length + part.length < 25000) {
            currentChunk += part;
          } else {
            if (currentChunk) {
              chunks.push({ id: chunkIndex++, content: currentChunk });
            }
            if (part.length > 25000) {
               // Fallback line-based
               const lines = part.split('\n');
               let subChunk = "";
               for (const line of lines) {
                 if (subChunk.length + line.length < 25000) {
                   subChunk += line + '\n';
                 } else {
                   if (subChunk) chunks.push({ id: chunkIndex++, content: subChunk });
                   subChunk = line + '\n';
                 }
               }
               if (subChunk) chunks.push({ id: chunkIndex++, content: subChunk });
               currentChunk = "";
            } else {
              currentChunk = part;
            }
          }
        }
        if (currentChunk) chunks.push({ id: chunkIndex++, content: currentChunk });
        
        for (const chunk of chunks) {
          const cText = `search_document: File: ${filePath} (Chunk ${chunk.id})\n\n${chunk.content}`;
          chunkTexts.push(cText);
          chunkMetadata.push({
            path: filePath,
            chunkId: chunk.id.toString(),
            type: ext,
            hash: hashText(cText),
            commit: baseCommit,
            model: MODEL
          });
        }
      }
    }
    
    console.log(`Embedding ${chunkTexts.length} valid chunks (${excludedArtifacts} artifacts excluded)...`);
    const artifactEmbeddings = await generateEmbeddings(chunkTexts);

    // 3. Compute Similarity & Rank
    const chunkCandidates = [];

    for (let i = 0; i < chunkMetadata.length; i++) {
      if (!artifactEmbeddings[i]) continue;
      
      const similarity = cosineSimilarity(queryEmbedding, artifactEmbeddings[i]);
      chunkCandidates.push({
        meta: chunkMetadata[i],
        similarity: similarity
      });
    }

    // Sort chunks by similarity
    chunkCandidates.sort((a, b) => b.similarity - a.similarity);

    // Artifact-level Deduplication
    const rankedCandidates = [];
    const seenPaths = new Set();
    
    for (const cand of chunkCandidates) {
      if (!seenPaths.has(cand.meta.path)) {
        seenPaths.add(cand.meta.path);
        rankedCandidates.push({
          path: cand.meta.path,
          similarity: cand.similarity,
          evidence: `Cosine similarity (chunk ${cand.meta.chunkId}): ${cand.similarity.toFixed(4)}`
        });
      }
    }

    // Tie-break with artifact path
    rankedCandidates.sort((a, b) => {
      if (b.similarity !== a.similarity) {
        return b.similarity - a.similarity;
      }
      return a.path.localeCompare(b.path);
    });

    // 4. Evaluate against Ground Truth
    const truthCandidates = caseData.candidates || [];
    const truthPaths = new Set(truthCandidates.map(c => c.path));
    const changedPathsSet = new Set(changedPaths);
    
    const report = {
      case_id: caseData.case_id,
      provider: 'ollama',
      model: MODEL,
      query: queryText,
      metrics: {
        total_artifacts_embedded: rankedCandidates.length,
        total_chunks_embedded: chunkTexts.length,
        excluded_artifacts: excludedArtifacts,
        context_failures: excludedArtifacts, // kept for backwards compatibility
        relevant_found_top_1: 0,
        relevant_found_top_3: 0,
        relevant_found_top_5: 0,
        relevant_found_top_10: 0,
        relevant_found_top_20: 0,
      },
      relevant_artifacts_results: [],
      top_20_candidates: rankedCandidates.slice(0, 20),
      all_candidates: rankedCandidates
    };

    // Calculate Top-K metrics
    for (const truth of truthCandidates) {
      const rankIndex = rankedCandidates.findIndex(c => c.path === truth.path);
      const rank = rankIndex !== -1 ? rankIndex + 1 : -1;
      
      if (rank !== -1) {
        if (rank <= 1) report.metrics.relevant_found_top_1++;
        if (rank <= 3) report.metrics.relevant_found_top_3++;
        if (rank <= 5) report.metrics.relevant_found_top_5++;
        if (rank <= 10) report.metrics.relevant_found_top_10++;
        if (rank <= 20) report.metrics.relevant_found_top_20++;
      }

      report.relevant_artifacts_results.push({
        path: truth.path,
        is_changed: changedPathsSet.has(truth.path),
        rank: rank,
        similarity: rank !== -1 ? rankedCandidates[rankIndex].similarity : null
      });
    }

    results[caseData.case_id] = report;
    fs.writeFileSync(path.join(OUTPUT_DIR, `${caseData.case_id}.json`), JSON.stringify(report, null, 2));
    
    console.log(`Results for ${caseData.case_id}:`);
    report.relevant_artifacts_results.forEach(r => {
      console.log(`- ${r.path} -> Rank: ${r.rank} (Sim: ${r.similarity?.toFixed(4)})`);
    });
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, 'summary.json'), JSON.stringify(results, null, 2));
  console.log('\nAll cases completed successfully!');
}

runB7().catch(console.error);
