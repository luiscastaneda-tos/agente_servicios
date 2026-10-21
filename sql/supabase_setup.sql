-- Enable pgvector extension for 768-dimensional embeddings
create extension if not exists vector;

-- Sessions table storing user quota, attached document metadata, and structured travel state
create table if not exists mia_chat_sessions (
  session_id text primary key,
  user_id text not null,
  messages_used int default 0,
  max_messages int default 25,
  files_uploaded int default 0,
  max_files int default 3,
  attached_documents jsonb default '[]'::jsonb,
  travel_state jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Chat history messages linked to session_id
create table if not exists mia_chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id text references mia_chat_sessions(session_id) on delete cascade,
  role text not null,
  content text not null,
  ui_payload jsonb,
  metadata jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_mia_chat_messages_session_id on mia_chat_messages(session_id, created_at desc);

-- Document chunks for RAG (768 dimensions unified across Gemini text-embedding-004 and OpenAI text-embedding-3-small)
create table if not exists mia_document_chunks (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  user_id text not null,
  document_id text not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  embedding vector(768)
);

create index if not exists idx_mia_document_chunks_session_id on mia_document_chunks(session_id);
create index if not exists idx_mia_document_chunks_embedding on mia_document_chunks using hnsw (embedding vector_cosine_ops);

-- RPC function compatible with LangChain SupabaseVectorStore
create or replace function match_mia_documents(
  query_embedding vector(768),
  match_count int default 5,
  filter jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    mia_document_chunks.id,
    mia_document_chunks.content,
    mia_document_chunks.metadata,
    1 - (mia_document_chunks.embedding <=> query_embedding) as similarity
  from mia_document_chunks
  where mia_document_chunks.metadata @> filter
  order by mia_document_chunks.embedding <=> query_embedding
  limit match_count;
end;
$$;
