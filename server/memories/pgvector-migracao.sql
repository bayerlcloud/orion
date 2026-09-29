-- Migracao pgvector da busca hibrida da memoria (trilha mem21/tool).
-- NAO roda no boot do orion-central: quem executa e o deploy do Bayerl, direto no Postgres do
-- container orion-postgres, por exemplo:
--   docker exec -i orion-postgres psql -U orion -d orion < server/memories/pgvector-migracao.sql
-- Requer a extensao pgvector disponivel na imagem (senao o CREATE EXTENSION falha e nada muda;
-- o codigo segue no full-text puro por feature-detect, sem erro).
-- Depois dela, rodar o backfill: npx tsx scripts/backfill-embeddings.ts

CREATE EXTENSION IF NOT EXISTS vector;

-- 384 dimensoes: intfloat/multilingual-e5-small (ver server/memories/embed.ts).
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding vector(384);

-- Indice HNSW por cosseno (mesmo operador <=> que a busca da tool usa).
CREATE INDEX IF NOT EXISTS memories_embedding_hnsw_idx ON memories USING hnsw (embedding vector_cosine_ops);
