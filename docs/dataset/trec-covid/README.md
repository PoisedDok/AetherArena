# TREC-COVID Dataset

This directory contains the TREC-COVID evaluation corpus used for offline retrieval and proactive-query experiments.

## Files

- `corpus.jsonl` — corpus documents
- `queries.jsonl` — official TREC-COVID topics
- `qrels/test.tsv` — relevance judgments

## Why it is here

The dataset supports reproducible evaluation work:

- offline corpus search experiments
- relevance-based analysis against known judgments
- proactive retrieval experiments where browsing context and retrieval quality can be compared against a fixed benchmark

This README is intentionally standalone. It should not depend on dissertation-only paths that are not present in the repository.
