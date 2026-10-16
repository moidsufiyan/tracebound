# Co-change evaluation report

**Result: SUPPORTED** (supported). Every selected commit has complete primary results.

Rendered from `results.json` (SHA-256 `22f044c703377728cde800c7492a009c8cdf92bff43bf9ccb8b548a921a46c87`) only. Protocol `docs/evaluation/cochange/protocol.md`, version 1.0.0. Repository `sindresorhus/got` at `05b4476913da39a47dd8e20d29e250f28b0a6dca`.

## Objective

When a developer changes source files, does Tracebound's hybrid retrieval surface the test and documentation files that the same commit also changed, better than simple baselines? The comparison runs on selected commits of one repository that took no part in Tracebound's design. A file changed in the same commit is a weak proxy for impact: these results speak to retrieval of co-changed files, not to impact accuracy.

Registered methods: hybrid (reciprocal rank fusion of the deterministic and semantic rankings), deterministic only, semantic only, and the sibling-test heuristic; plus a descriptive sensitivity arm, hybrid with an empty description. Each ranking has the commit's input files removed and its first 20 entries scored.

## Outcome

Supported: hybrid beat the sibling-test heuristic by at least 0.10 macro Recall@10 on test targets with a 95% interval strictly above zero, and neither single-source baseline outperformed hybrid materially.

Rule that decided: **supported**. The sibling difference was at least 0.10 with an interval above zero, and no single-source baseline outperformed hybrid materially.

Selected commits: 50. Commits with a test target (primary population): 47.

Confirmatory comparison: hybrid against the sibling-test heuristic, macro Recall@10 on test targets (difference = hybrid minus the baseline, 95% percentile bootstrap interval). The other two comparisons are exploratory and can only downgrade the outcome.

| Baseline | Difference | 95% interval | Interval above 0 | Interval below 0 | At least 0.10 | Outperforms hybrid materially |
| --- | --- | --- | --- | --- | --- | --- |
| Sibling-test heuristic | 0.7642 | [0.6436, 0.8723] | yes | no | yes | no |
| Deterministic only | 0.1862 | [0.0691, 0.3085] | yes | no | yes | no |
| Semantic only | 0.0550 | [-0.0514, 0.1684] | no | no | no | no |

## Primary results

Macro averages over the commits with at least one target in the stratum, each with its 95% percentile bootstrap interval. Differences are hybrid minus the named method.

### Test targets (primary)

Population: 47 commit(s).

| Method | Recall@3 | Recall@5 | Recall@10 | Recall@20 | MRR@20 |
| --- | --- | --- | --- | --- | --- |
| Hybrid | 0.4238 [0.2890, 0.5585] | 0.5266 [0.3883, 0.6596] | 0.7642 [0.6436, 0.8723] | 0.8972 [0.8191, 0.9610] | 0.3624 [0.2724, 0.4561] |
| Deterministic only | 0.3085 [0.1809, 0.4397] | 0.4043 [0.2695, 0.5461] | 0.5780 [0.4362, 0.7128] | 0.7110 [0.5798, 0.8298] | 0.3135 [0.2112, 0.4222] |
| Semantic only | 0.3918 [0.2606, 0.5284] | 0.5514 [0.4149, 0.6827] | 0.7092 [0.5851, 0.8262] | 0.8642 [0.7738, 0.9415] | 0.3922 [0.2952, 0.4964] |
| Sibling-test heuristic | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] |

| Hybrid minus | Recall@3 | Recall@5 | Recall@10 | Recall@20 | MRR@20 |
| --- | --- | --- | --- | --- | --- |
| Sibling-test heuristic | 0.4238 [0.2890, 0.5585] | 0.5266 [0.3883, 0.6596] | 0.7642 [0.6436, 0.8723] | 0.8972 [0.8191, 0.9610] | 0.3624 [0.2724, 0.4561] |
| Deterministic only | 0.1152 [0.0124, 0.2287] | 0.1223 [0.0000, 0.2500] | 0.1862 [0.0691, 0.3085] | 0.1862 [0.0922, 0.2926] | 0.0490 [-0.0354, 0.1324] |
| Semantic only | 0.0319 [-0.1277, 0.1915] | -0.0248 [-0.1596, 0.1099] | 0.0550 [-0.0514, 0.1684] | 0.0330 [-0.0149, 0.1011] | -0.0298 [-0.1361, 0.0707] |

### Documentation targets

Population: 19 commit(s).

| Method | Recall@3 | Recall@5 | Recall@10 | Recall@20 | MRR@20 |
| --- | --- | --- | --- | --- | --- |
| Hybrid | 0.4737 [0.2632, 0.6842] | 0.5000 [0.2895, 0.7105] | 0.7632 [0.5789, 0.9474] | 0.9211 [0.7895, 1.0000] | 0.4555 [0.2845, 0.6371] |
| Deterministic only | 0.3684 [0.1579, 0.5789] | 0.3684 [0.1579, 0.5789] | 0.4474 [0.2368, 0.6579] | 0.5526 [0.3158, 0.7632] | 0.3204 [0.1499, 0.5059] |
| Semantic only | 0.5789 [0.3684, 0.7895] | 0.6316 [0.4211, 0.8158] | 0.8421 [0.6842, 0.9737] | 0.8947 [0.7368, 1.0000] | 0.4607 [0.3057, 0.6257] |
| Sibling-test heuristic | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] |

| Hybrid minus | Recall@3 | Recall@5 | Recall@10 | Recall@20 | MRR@20 |
| --- | --- | --- | --- | --- | --- |
| Sibling-test heuristic | 0.4737 [0.2632, 0.6842] | 0.5000 [0.2895, 0.7105] | 0.7632 [0.5789, 0.9474] | 0.9211 [0.7895, 1.0000] | 0.4555 [0.2845, 0.6371] |
| Deterministic only | 0.1053 [0.0000, 0.2632] | 0.1316 [0.0000, 0.2895] | 0.3158 [0.1053, 0.5263] | 0.3684 [0.1579, 0.5789] | 0.1351 [0.0271, 0.2365] |
| Semantic only | -0.1053 [-0.3684, 0.1579] | -0.1316 [-0.3421, 0.0789] | -0.0789 [-0.2368, 0.0526] | 0.0263 [-0.0789, 0.1579] | -0.0052 [-0.1302, 0.1312] |

### Test targets with a structural link

Population: 11 commit(s).

| Method | Recall@3 | Recall@5 | Recall@10 | Recall@20 | MRR@20 |
| --- | --- | --- | --- | --- | --- |
| Hybrid | 0.8636 [0.6364, 1.0000] | 0.9091 [0.7273, 1.0000] | 1.0000 [1.0000, 1.0000] | 1.0000 [1.0000, 1.0000] | 0.6465 [0.4495, 0.8485] |
| Deterministic only | 0.8636 [0.6364, 1.0000] | 1.0000 [1.0000, 1.0000] | 1.0000 [1.0000, 1.0000] | 1.0000 [1.0000, 1.0000] | 0.7000 [0.5273, 0.8636] |
| Semantic only | 0.3636 [0.0909, 0.6364] | 0.6364 [0.3636, 0.9091] | 0.7273 [0.4545, 1.0000] | 0.9091 [0.7273, 1.0000] | 0.4074 [0.1915, 0.6439] |
| Sibling-test heuristic | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] |

| Hybrid minus | Recall@3 | Recall@5 | Recall@10 | Recall@20 | MRR@20 |
| --- | --- | --- | --- | --- | --- |
| Sibling-test heuristic | 0.8636 [0.6364, 1.0000] | 0.9091 [0.7273, 1.0000] | 1.0000 [1.0000, 1.0000] | 1.0000 [1.0000, 1.0000] | 0.6465 [0.4495, 0.8485] |
| Deterministic only | 0.0000 [-0.2727, 0.2727] | -0.0909 [-0.2727, 0.0000] | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] | -0.0535 [-0.2222, 0.1030] |
| Semantic only | 0.5000 [0.2273, 0.7727] | 0.2727 [0.0000, 0.5455] | 0.2727 [0.0000, 0.5455] | 0.0909 [0.0000, 0.2727] | 0.2390 [0.0179, 0.4609] |

### Test targets without a structural link

Population: 37 commit(s).

| Method | Recall@3 | Recall@5 | Recall@10 | Recall@20 | MRR@20 |
| --- | --- | --- | --- | --- | --- |
| Hybrid | 0.3041 [0.1689, 0.4527] | 0.4212 [0.2703, 0.5766] | 0.6959 [0.5541, 0.8311] | 0.8649 [0.7703, 0.9459] | 0.2772 [0.1990, 0.3652] |
| Deterministic only | 0.1577 [0.0541, 0.2748] | 0.2387 [0.1171, 0.3784] | 0.4595 [0.2973, 0.6216] | 0.6284 [0.4797, 0.7704] | 0.1991 [0.1087, 0.3035] |
| Semantic only | 0.4077 [0.2590, 0.5631] | 0.5293 [0.3806, 0.6802] | 0.7072 [0.5721, 0.8378] | 0.8500 [0.7477, 0.9369] | 0.3800 [0.2772, 0.4943] |
| Sibling-test heuristic | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] | 0.0000 [0.0000, 0.0000] |

| Hybrid minus | Recall@3 | Recall@5 | Recall@10 | Recall@20 | MRR@20 |
| --- | --- | --- | --- | --- | --- |
| Sibling-test heuristic | 0.3041 [0.1689, 0.4527] | 0.4212 [0.2703, 0.5766] | 0.6959 [0.5541, 0.8311] | 0.8649 [0.7703, 0.9459] | 0.2772 [0.1990, 0.3652] |
| Deterministic only | 0.1464 [0.0428, 0.2680] | 0.1824 [0.0405, 0.3243] | 0.2365 [0.0946, 0.3919] | 0.2365 [0.1216, 0.3649] | 0.0781 [-0.0150, 0.1712] |
| Semantic only | -0.1036 [-0.2658, 0.0586] | -0.1081 [-0.2477, 0.0270] | -0.0113 [-0.1149, 0.0968] | 0.0149 [-0.0257, 0.0757] | -0.1029 [-0.2114, -0.0041] |

## Cases

Descriptive. Each cell is the best position of any target in the method's ranking after the inputs were removed (positions beyond 20 are not scored), or the method's status.

| Commit | Test / doc targets | Missing targets | Hybrid | Deterministic only | Semantic only | Sibling-test heuristic | Hybrid, no description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `21121688cb51` | 0 / 1 | 0 | @3 | none | @3 | none | @3 |
| `7693a7d64574` | 1 / 1 | 0 | @1 | @1 | @1 | none | @4 |
| `47da1181a525` | 2 / 1 | 0 | @1 | @2 | @1 | none | @2 |
| `b7d4f8caca90` | 3 / 0 | 0 | @4 | @1 | @7 | none | @7 |
| `e1cbaf200bad` | 1 / 0 | 0 | @2 | @3 | @2 | none | @13 |
| `e45087ab049d` | 1 / 0 | 0 | @1 | @1 | @3 | none | @5 |
| `b3cd9612541f` | 1 / 1 | 0 | @1 | @1 | @1 | none | @3 |
| `919703cd8e9b` | 1 / 0 | 0 | @3 | @1 | @11 | none | @11 |
| `b45896aa4ec7` | 1 / 1 | 0 | @1 | @1 | @1 | none | @3 |
| `0c5e44ce3cdb` | 1 / 0 | 0 | @9 | none | @9 | none | @10 |
| `43b51ba66114` | 2 / 0 | 0 | @7 | none | @7 | none | @13 |
| `38931e239583` | 1 / 0 | 0 | @7 | @10 | @5 | none | @10 |
| `7a49ce7b72e3` | 1 / 0 | 0 | @14 | @8 | @29 | none | @29 |
| `ecf31809bc37` | 1 / 0 | 0 | @3 | @1 | @19 | none | @3 |
| `78a56ecaf8eb` | 0 / 1 | 0 | @1 | @1 | @6 | none | @5 |
| `b392f605050c` | 1 / 2 | 0 | @1 | @1 | @2 | none | @1 |
| `29ffb44f6be9` | 1 / 2 | 0 | @1 | @2 | @1 | none | @2 |
| `95c7c2c2f6d9` | 1 / 1 | 0 | @3 | @3 | @4 | none | @4 |
| `355789640975` | 1 / 1 | 0 | @2 | @8 | @1 | none | @14 |
| `95bed1e3555c` | 2 / 0 | 0 | @1 | @1 | @16 | none | @2 |
| `5a8f461d9181` | 1 / 0 | 0 | @1 | @1 | @1 | none | @2 |
| `e0f8aabbc3df` | 1 / 0 | 0 | @7 | @4 | @11 | none | @14 |
| `1f363b976cd2` | 1 / 0 | 0 | @11 | @19 | @6 | none | @61 |
| `4fd10068013f` | 1 / 0 | 0 | @7 | @10 | @10 | none | @59 |
| `429db406c6e5` | 2 / 0 | 0 | @6 | @16 | @5 | none | @25 |
| `7dbb9ee2bd58` | 3 / 0 | 0 | @13 | @31 | @2 | none | @26 |
| `c98f0d7c39eb` | 1 / 0 | 0 | @3 | @7 | @5 | none | @17 |
| `4be7446baaef` | 1 / 1 | 0 | @2 | @2 | @3 | none | @15 |
| `9c16d9083019` | 1 / 1 | 0 | @3 | @2 | @2 | none | @18 |
| `f65c9efd2f34` | 3 / 0 | 0 | @13 | @21 | @8 | none | @15 |
| `1120370e05fd` | 1 / 1 | 0 | @8 | @2 | @2 | none | @17 |
| `efafa167d70b` | 1 / 0 | 0 | @14 | @26 | @12 | none | @30 |
| `488001730f80` | 0 / 2 | 0 | @1 | @1 | @2 | none | @2 |
| `439fb82d2a07` | 1 / 1 | 0 | @8 | @37 | @1 | none | @49 |
| `22d58fb43aec` | 1 / 1 | 0 | @19 | @29 | @20 | none | @23 |
| `3e9d3af606c3` | 1 / 0 | 0 | @8 | @26 | @1 | none | @37 |
| `f2f8cb29fe9f` | 1 / 0 | 0 | @4 | @20 | @2 | none | @70 |
| `e899c0736f6a` | 1 / 0 | 0 | @1 | @1 | @2 | none | @11 |
| `60a441939af3` | 1 / 0 | 0 | @2 | @8 | @2 | none | @44 |
| `449833a227fc` | 1 / 1 | 0 | @15 | @22 | @26 | none | @58 |
| `ff46eaecba43` | 2 / 0 | 0 | @12 | @23 | @17 | none | @50 |
| `6be69a54b3f9` | 5 / 0 | 0 | @35 | none | @14 | none | @25 |
| `a5b76bffb33d` | 1 / 1 | 0 | @3 | @11 | @1 | none | @28 |
| `78bf3940ac81` | 1 / 0 | 0 | @2 | @2 | @1 | none | @6 |
| `b57120c9cfda` | 2 / 0 | 0 | @2 | @10 | @1 | none | @27 |
| `f98d0e1c2332` | 3 / 0 | 0 | @1 | @2 | @1 | none | @1 |
| `60b62a0553bb` | 1 / 1 | 0 | @8 | @13 | @1 | none | @28 |
| `0c17a8b4c237` | 1 / 0 | 0 | @3 | @5 | @6 | none | @2 |
| `a9a754f551fa` | 4 / 0 | 0 | @3 | @12 | @3 | none | @8 |
| `850e49bb4beb` | 1 / 0 | 0 | @1 | @10 | @1 | none | @60 |

## Failures

| Method | Failed commits | Not run (base failed preparation) |
| --- | --- | --- |
| Hybrid | 0 | 0 |
| Deterministic only | 0 | 0 |
| Semantic only | 0 | 0 |
| Sibling-test heuristic | 0 | 0 |
| Hybrid, no description | 0 | 0 |

A failure keeps only its stage and error name; raw error text is not published. Missing records are never read as failures: an evaluation with missing records is refused before any result exists.

## Sensitivity: hybrid without a description (descriptive only)

Computed on the common population C: the 50 selected commit(s) where both ordinary hybrid and the arm succeeded, with a separate generator (seed 2667729199). It measures how much hybrid depends on the commit subject and does not remove all leakage of the commit into the query: the input paths are still given. It plays no part in the decision and cannot change it.

Ordinary hybrid unsuccessful: 0. Arm failed: 0. Arm not run: 0.

### Test targets (primary)

Population: 47 commit(s).

| Method | Recall@3 | Recall@5 | Recall@10 | Recall@20 | MRR@20 |
| --- | --- | --- | --- | --- | --- |
| Hybrid | 0.4238 [0.2908, 0.5621] | 0.5266 [0.3901, 0.6632] | 0.7642 [0.6454, 0.8723] | 0.8972 [0.8191, 0.9610] | 0.3624 [0.2752, 0.4574] |
| Hybrid, no description | 0.1028 [0.0284, 0.1915] | 0.1986 [0.0957, 0.3156] | 0.2996 [0.1791, 0.4291] | 0.5426 [0.4043, 0.6809] | 0.1347 [0.0773, 0.2027] |

| Hybrid minus | Recall@3 | Recall@5 | Recall@10 | Recall@20 | MRR@20 |
| --- | --- | --- | --- | --- | --- |
| Hybrid, no description | 0.3209 [0.1968, 0.4574] | 0.3280 [0.1915, 0.4663] | 0.4645 [0.3262, 0.6028] | 0.3546 [0.2199, 0.4929] | 0.2277 [0.1604, 0.3043] |

### Documentation targets

Population: 19 commit(s).

| Method | Recall@3 | Recall@5 | Recall@10 | Recall@20 | MRR@20 |
| --- | --- | --- | --- | --- | --- |
| Hybrid | 0.4737 [0.2632, 0.6842] | 0.5000 [0.2895, 0.7105] | 0.7632 [0.5789, 0.9474] | 0.9211 [0.7895, 1.0000] | 0.4555 [0.2834, 0.6390] |
| Hybrid, no description | 0.2895 [0.1316, 0.4737] | 0.4474 [0.2368, 0.6579] | 0.5000 [0.2895, 0.7105] | 0.6579 [0.4474, 0.8684] | 0.1963 [0.1157, 0.2798] |

| Hybrid minus | Recall@3 | Recall@5 | Recall@10 | Recall@20 | MRR@20 |
| --- | --- | --- | --- | --- | --- |
| Hybrid, no description | 0.1842 [0.0000, 0.3947] | 0.0526 [0.0000, 0.1579] | 0.2632 [0.1053, 0.4737] | 0.2632 [0.1053, 0.4737] | 0.2592 [0.1414, 0.3890] |

### Test targets with a structural link

Population: 11 commit(s).

| Method | Recall@3 | Recall@5 | Recall@10 | Recall@20 | MRR@20 |
| --- | --- | --- | --- | --- | --- |
| Hybrid | 0.8636 [0.6818, 1.0000] | 0.9091 [0.7273, 1.0000] | 1.0000 [1.0000, 1.0000] | 1.0000 [1.0000, 1.0000] | 0.6465 [0.4495, 0.8485] |
| Hybrid, no description | 0.5000 [0.2273, 0.7727] | 0.5000 [0.2273, 0.7727] | 0.5909 [0.3182, 0.8636] | 0.8182 [0.5455, 1.0000] | 0.3770 [0.1869, 0.5923] |

| Hybrid minus | Recall@3 | Recall@5 | Recall@10 | Recall@20 | MRR@20 |
| --- | --- | --- | --- | --- | --- |
| Hybrid, no description | 0.3636 [0.0909, 0.6364] | 0.4091 [0.1364, 0.6818] | 0.4091 [0.1364, 0.6818] | 0.1818 [0.0000, 0.4545] | 0.2695 [0.1010, 0.4500] |

### Test targets without a structural link

Population: 37 commit(s).

| Method | Recall@3 | Recall@5 | Recall@10 | Recall@20 | MRR@20 |
| --- | --- | --- | --- | --- | --- |
| Hybrid | 0.3041 [0.1689, 0.4459] | 0.4212 [0.2725, 0.5766] | 0.6959 [0.5541, 0.8311] | 0.8649 [0.7702, 0.9459] | 0.2772 [0.1999, 0.3665] |
| Hybrid, no description | 0.0000 [0.0000, 0.0000] | 0.1216 [0.0270, 0.2297] | 0.2275 [0.1081, 0.3604] | 0.4685 [0.3153, 0.6261] | 0.0635 [0.0402, 0.0889] |

| Hybrid minus | Recall@3 | Recall@5 | Recall@10 | Recall@20 | MRR@20 |
| --- | --- | --- | --- | --- | --- |
| Hybrid, no description | 0.3041 [0.1689, 0.4459] | 0.2995 [0.1441, 0.4550] | 0.4685 [0.3108, 0.6216] | 0.3964 [0.2342, 0.5586] | 0.2137 [0.1434, 0.2944] |

## Statistical settings

- Metrics: Recall@3, Recall@5, Recall@10, Recall@20 and MRR@20, macro-averaged over commits; scored depth 20.
- Exact arithmetic: every per-commit value is an integer multiple of 1/232792560; rates are derived only for display.
- Paired percentile bootstrap over commits: 10000 replicates, interval from the 0.025 and 0.975 percentiles, Mulberry32 seeds 20261014 (primary) and 2667729199 (sensitivity). The streams are distinct deterministic streams; no statistical independence is claimed.
- Strata, in the order the primary generator is consumed: test, doc, test-with-link, test-without-link.

## Provenance

Recorded in the journal headers when the evaluation ran. Assembly did not re-check any of these against the machine that ran the evaluation:

- Tracebound commit `34c4d41a76db36ad7a3bea5d4871dd753d5dc2ea` (source recorded as clean); build hash `06f3e6bb6d4cd9319801898be78e034caa0ee6d3a291b03bf3f7e55cad2406bc`
- Node v24.20.0
- Embedding model identity `ollama:nomic-embed-text:v1.5@0a109f422b47` (as configured; this report does not show that the model was reachable or that its weights were verified)

Verified when the results were assembled (assembly refuses otherwise):

- Manifest bytes equal the registered manifest, SHA-256 `d179d992f28b201b558e9c5c97db3e9b0ac39f18544b2463d73f317b865eb361`
- Frozen database bytes equal the database the evaluation read, SHA-256 `cf944d38e5ff6996bd6a9f4979f8ab91fb94a30d0afcbecad06a520a716d5194`
- Preparation journal, SHA-256 `2889d2ef5ca619a9e2df2fe8cb594b4054b14492f1bdb1b138862fadb15d368f`, valid, complete and for the same run identity
- Evaluation journal, SHA-256 `8b46c1024293639e756be56c2f84b5e8994424dfed2cf0d243b6293168b24e4d`, valid, complete, in manifest order, and its records consistent with the manifest and the preparation

Not verified by assembly or publication: the state of the dataset clone and of the Tracebound checkout and build at evaluation time, and whether the recorded rankings came from the real embedding model.

## What this does and does not show

- It shows how well each method ranked the files that the selected commits co-changed, within the first 20 results, on this one repository.
- It does not show that any file is affected by a change, and it does not measure impact classification accuracy: the repository has no impact-level labels.
- Co-change is a biased subset of what a change touches; commits are drawn from one repository; classification of files into source, test and documentation follows fixed path rules with known gaps (see the protocol); commit subjects can name the files they changed.
- Intervals from at most 50 commits of one repository are approximate; commits are not independent draws.
- The decision applies the registered rules once; nothing was tuned.
