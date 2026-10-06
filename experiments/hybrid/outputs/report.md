# Hybrid Retrieval v1: Final Evaluation Report

## TB-0001

### Performance Comparison

| Method | Top-1 | Top-3 | Top-5 | Top-10 | Top-20 |
|--------|-------|-------|-------|--------|--------|
| Deterministic (B6) | ❌ | ❌ | ❌ | ❌ | ✅ |
| Semantic (B7.1) | ❌ | ❌ | ✅ | ✅ | ✅ |
| Hybrid (H1 Union) | ❌ | ❌ | ✅ | ✅ | ✅ |
| Hybrid (H2 RRF) | ❌ | ❌ | ❌ | ✅ | ✅ |
| Hybrid (H3 Tiers) | ❌ | ❌ | ❌ | ✅ | ✅ |

### Relevant Artifact Details
- **Artifact:** `backend/docs/architecture/checkout-lifecycle.md`
  - **H2 Rank:** 6
  - **H3 Rank:** 6
  - **Deterministic Rank:** 12 (2. Strong Lexical (Path + Multi-Content))
  - **Semantic Rank:** 4 (Sim: 0.701)

## TB-0002

### Performance Comparison

| Method | Top-1 | Top-3 | Top-5 | Top-10 | Top-20 |
|--------|-------|-------|-------|--------|--------|
| Deterministic (B6) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Semantic (B7.1) | ❌ | ✅ | ✅ | ✅ | ✅ |
| Hybrid (H1 Union) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Hybrid (H2 RRF) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Hybrid (H3 Tiers) | ✅ | ✅ | ✅ | ✅ | ✅ |

### Relevant Artifact Details
- **Artifact:** `backend/docs/architecture/order-lifecycle.md`
  - **H2 Rank:** 1
  - **H3 Rank:** 1
  - **Deterministic Rank:** 1 (2. Strong Lexical (Path + Multi-Content))
  - **Semantic Rank:** 2 (Sim: 0.769)

## TB-0003

### Performance Comparison

| Method | Top-1 | Top-3 | Top-5 | Top-10 | Top-20 |
|--------|-------|-------|-------|--------|--------|
| Deterministic (B6) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Semantic (B7.1) | ❌ | ❌ | ✅ | ✅ | ✅ |
| Hybrid (H1 Union) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Hybrid (H2 RRF) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Hybrid (H3 Tiers) | ✅ | ✅ | ✅ | ✅ | ✅ |

### Relevant Artifact Details
- **Artifact:** `src/middleware/combine/index.test.ts`
  - **H2 Rank:** 1
  - **H3 Rank:** 1
  - **Deterministic Rank:** 1 (1. Critical Structural (Incoming Dependent / Test))
  - **Semantic Rank:** 5 (Sim: 0.714)

## TB-0004

### Performance Comparison

| Method | Top-1 | Top-3 | Top-5 | Top-10 | Top-20 |
|--------|-------|-------|-------|--------|--------|
| Deterministic (B6) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Semantic (B7.1) | ❌ | ✅ | ✅ | ✅ | ✅ |
| Hybrid (H1 Union) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Hybrid (H2 RRF) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Hybrid (H3 Tiers) | ✅ | ✅ | ✅ | ✅ | ✅ |

### Relevant Artifact Details
- **Artifact:** `src/middleware/etag/index.test.ts`
  - **H2 Rank:** 1
  - **H3 Rank:** 1
  - **Deterministic Rank:** 1 (1. Critical Structural (Incoming Dependent / Test))
  - **Semantic Rank:** 2 (Sim: 0.748)

## TB-0005

### Performance Comparison

| Method | Top-1 | Top-3 | Top-5 | Top-10 | Top-20 |
|--------|-------|-------|-------|--------|--------|
| Deterministic (B6) | ❌ | ✅ | ✅ | ✅ | ✅ |
| Semantic (B7.1) | ❌ | ✅ | ✅ | ✅ | ✅ |
| Hybrid (H1 Union) | ❌ | ✅ | ✅ | ✅ | ✅ |
| Hybrid (H2 RRF) | ❌ | ✅ | ✅ | ✅ | ✅ |
| Hybrid (H3 Tiers) | ❌ | ✅ | ✅ | ✅ | ✅ |

### Relevant Artifact Details
- **Artifact:** `src/middleware/ip-restriction/index.ts`
  - **H2 Rank:** 2
  - **H3 Rank:** 2
  - **Deterministic Rank:** 2 (1. Critical Structural (Incoming Dependent / Test))
  - **Semantic Rank:** 3 (Sim: 0.710)

## TB-0006

### Performance Comparison

| Method | Top-1 | Top-3 | Top-5 | Top-10 | Top-20 |
|--------|-------|-------|-------|--------|--------|
| Deterministic (B6) | ❌ | ❌ | ❌ | ✅ | ✅ |
| Semantic (B7.1) | ❌ | ❌ | ❌ | ✅ | ✅ |
| Hybrid (H1 Union) | ❌ | ❌ | ❌ | ✅ | ✅ |
| Hybrid (H2 RRF) | ❌ | ❌ | ✅ | ✅ | ✅ |
| Hybrid (H3 Tiers) | ❌ | ❌ | ✅ | ✅ | ✅ |

### Relevant Artifact Details
- **Artifact:** `backend/docs/database/inventory-domain.md`
  - **H2 Rank:** 5
  - **H3 Rank:** 5
  - **Deterministic Rank:** 8 (2. Strong Lexical (Path + Multi-Content))
  - **Semantic Rank:** 9 (Sim: 0.687)

## TB-0007

### Performance Comparison

| Method | Top-1 | Top-3 | Top-5 | Top-10 | Top-20 |
|--------|-------|-------|-------|--------|--------|
| Deterministic (B6) | ❌ | ❌ | ❌ | ❌ | ✅ |
| Semantic (B7.1) | ❌ | ❌ | ✅ | ✅ | ✅ |
| Hybrid (H1 Union) | ❌ | ❌ | ✅ | ✅ | ✅ |
| Hybrid (H2 RRF) | ❌ | ❌ | ❌ | ✅ | ✅ |
| Hybrid (H3 Tiers) | ❌ | ❌ | ❌ | ✅ | ✅ |

### Relevant Artifact Details
- **Artifact:** `backend/docs/architecture/order-lifecycle.md`
  - **H2 Rank:** 8
  - **H3 Rank:** 8
  - **Deterministic Rank:** 17 (2. Strong Lexical (Path + Multi-Content))
  - **Semantic Rank:** 5 (Sim: 0.698)

## TB-0008

### Performance Comparison

| Method | Top-1 | Top-3 | Top-5 | Top-10 | Top-20 |
|--------|-------|-------|-------|--------|--------|
| Deterministic (B6) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Semantic (B7.1) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Hybrid (H1 Union) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Hybrid (H2 RRF) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Hybrid (H3 Tiers) | ❌ | ❌ | ❌ | ❌ | ❌ |

### Relevant Artifact Details
*No relevant artifacts found in Top 20 for H2/H3.*

## TB-0009

### Performance Comparison

| Method | Top-1 | Top-3 | Top-5 | Top-10 | Top-20 |
|--------|-------|-------|-------|--------|--------|
| Deterministic (B6) | ❌ | ✅ | ✅ | ✅ | ✅ |
| Semantic (B7.1) | ❌ | ✅ | ✅ | ✅ | ✅ |
| Hybrid (H1 Union) | ❌ | ✅ | ✅ | ✅ | ✅ |
| Hybrid (H2 RRF) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Hybrid (H3 Tiers) | ✅ | ✅ | ✅ | ✅ | ✅ |

### Relevant Artifact Details
- **Artifact:** `src/helper/streaming/stream.ts`
  - **H2 Rank:** 1
  - **H3 Rank:** 1
  - **Deterministic Rank:** 3 (1. Critical Structural (Incoming Dependent / Test))
  - **Semantic Rank:** 3 (Sim: 0.713)

