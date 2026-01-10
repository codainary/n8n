-- ==========================================
-- PostgreSQL + pgvector Initialization Script
-- ==========================================

-- Instalar extensión pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Crear tabla para los chunks (solo si no existe)
CREATE TABLE IF NOT EXISTS documents (
    id SERIAL PRIMARY KEY,
    document_id TEXT NOT NULL,
    chunk_index INT NOT NULL,
    content TEXT,
    content_hash TEXT,
    embedding vector(1536), -- tamaño según el modelo de OpenAI
    modified_time TIMESTAMP,
    UNIQUE(document_id, chunk_index)
);

-- Crear índice para búsqueda vectorial (si no existe)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes 
        WHERE tablename = 'documents' 
        AND indexname = 'documents_embedding_idx'
    ) THEN
        CREATE INDEX documents_embedding_idx ON documents 
        USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
    END IF;
END $$;
