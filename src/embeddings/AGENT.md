# src/embeddings

This folder contains the local semantic embedding implementation used by Horizon Layer search.

## Files

- `index.ts`: lazy-loads a Xenova transformers feature-extraction pipeline, embeds text with mean pooling plus normalization, and converts vectors into SQL literal form for pgvector writes.

## Why It Exists

The project supports hybrid search across pages and database rows. That requires a local way to turn text into vectors without depending on an external embedding API. This module is the bridge between application content and the `vector` columns/indexes defined in the SQL schema.

## Implementation Notes

- Model name and vector dimensions come from `src/config.ts`.
- The transformer pipeline is loaded lazily on first use to avoid slowing down process startup when embeddings are not immediately needed.
- `env.allowLocalModels = true` enables local caching of the model assets.
- `vectorToSql()` exists because the query layer writes vectors into pgvector-compatible SQL text form.

## Operational Detail

The first process that uses embeddings will pay the model initialization cost. After that, the in-process pipeline is reused.
