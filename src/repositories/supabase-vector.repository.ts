import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Document } from "@langchain/core/documents";
import type { Embeddings } from "@langchain/core/embeddings";
import { env } from "../config/env";
import type { IVectorStoreRepository } from "./interfaces/repositories.interface";

interface MemoryVectorRecord {
  doc: Document;
  vector: number[];
}

export class SupabaseVectorRepository implements IVectorStoreRepository {
  private supabase: SupabaseClient | null = null;
  private readonly fallbackStore = new Map<string, MemoryVectorRecord[]>();
  private warnedFallback = false;

  constructor() {
    if (
      env.supabaseUrl &&
      env.supabaseServiceRoleKey &&
      !env.supabaseUrl.includes("your-project")
    ) {
      this.supabase = createClient(
        env.supabaseUrl,
        env.supabaseServiceRoleKey,
        {
          auth: { persistSession: false },
        }
      );
    } else {
      this.warnLocalFallback();
    }
  }

  private warnLocalFallback(reason?: string): void {
    if (!this.warnedFallback) {
      console.warn(
        `[SupabaseVectorRepository] ⚠️ Usando caché vectorial en memoria local (${
          reason || "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no configurados en .env"
        }). Configure Supabase para persistencia pgvector en mia_document_chunks.`
      );
      this.warnedFallback = true;
    }
  }

  private fitVectorDimension(vec: number[]): number[] {
    const targetDim = env.embeddingDimensions || 768;
    if (vec.length === targetDim) return vec;
    if (vec.length > targetDim) return vec.slice(0, targetDim);
    const padded = new Array(targetDim).fill(0);
    for (let i = 0; i < vec.length; i++) {
      padded[i] = vec[i];
    }
    return padded;
  }

  public async storeDocumentChunks(
    chunks: Document[],
    embeddings: Embeddings
  ): Promise<void> {
    if (chunks.length === 0) return;

    const texts = chunks.map((c) => c.pageContent);
    const rawVectors = await embeddings.embedDocuments(texts);
    const vectors = rawVectors.map((v) => this.fitVectorDimension(v));

    // Always keep in memory fallback cache for resilience if Supabase is not configured
    for (let i = 0; i < chunks.length; i++) {
      const sessionId = String(chunks[i].metadata?.sessionId || "default");
      const list = this.fallbackStore.get(sessionId) || [];
      list.push({ doc: chunks[i], vector: vectors[i] });
      this.fallbackStore.set(sessionId, list);
    }

    if (!this.supabase) {
      this.warnLocalFallback();
      return;
    }

    const rows = chunks.map((chunk, idx) => ({
      session_id: String(chunk.metadata?.sessionId || ""),
      user_id: String(chunk.metadata?.userId || "anonymous"),
      document_id: String(chunk.metadata?.documentId || ""),
      file_name: String(chunk.metadata?.fileName || ""),
      file_type: String(chunk.metadata?.fileType || "pdf"),
      chunk_index: Number(chunk.metadata?.chunkIndex ?? idx),
      token_count: Number(chunk.metadata?.tokenCount ?? 0),
      content: chunk.pageContent,
      metadata: chunk.metadata || {},
      embedding: vectors[idx],
    }));

    const { error } = await this.supabase
      .from("mia_document_chunks")
      .insert(rows);

    if (error) {
      this.warnLocalFallback(`Error en insert de Supabase: ${error.message}`);
    }
  }

  public async searchSimilarChunks(params: {
    query: string;
    sessionId: string;
    userId?: string;
    fileType?: "pdf" | "csv";
    topK?: number;
    embeddings: Embeddings;
  }): Promise<Document[]> {
    const { query, sessionId, fileType, topK = 6, embeddings } = params;
    const rawQueryVector = await embeddings.embedQuery(query);
    const queryVector = this.fitVectorDimension(rawQueryVector);

    if (this.supabase) {
      try {
        const { data, error } = await this.supabase.rpc("match_mia_documents", {
          query_embedding: queryVector,
          match_count: topK,
          filter_session_id: sessionId,
          filter_file_type: fileType ?? null,
        });

        if (!error && Array.isArray(data) && data.length > 0) {
          const matchedDocs: Document[] = data.map(
            (row: {
              content: string;
              file_name: string;
              file_type: string;
              chunk_index: number;
              token_count: number;
              metadata: Record<string, unknown>;
              similarity: number;
            }) =>
              new Document({
                pageContent: row.content,
                metadata: {
                  ...(row.metadata || {}),
                  fileName: row.file_name,
                  fileType: row.file_type,
                  chunkIndex: row.chunk_index,
                  tokenCount: row.token_count,
                  similarity: row.similarity,
                },
              })
          );

          // If searching CSV, ensure any statistical summary chunk (chunk_index = 0 / isSummaryChunk) is included
          if (fileType === "csv") {
            const hasSummary = matchedDocs.some(
              (d) => Boolean(d.metadata?.isSummaryChunk) || d.metadata?.chunkIndex === 0
            );
            if (!hasSummary) {
              const { data: summaryRows } = await this.supabase
                .from("mia_document_chunks")
                .select("content, file_name, file_type, chunk_index, token_count, metadata")
                .eq("session_id", sessionId)
                .eq("file_type", "csv")
                .eq("chunk_index", 0)
                .limit(3);

              if (Array.isArray(summaryRows) && summaryRows.length > 0) {
                const summaryDocs = summaryRows.map(
                  (r) =>
                    new Document({
                      pageContent: r.content,
                      metadata: {
                        ...(r.metadata || {}),
                        fileName: r.file_name,
                        fileType: r.file_type,
                        chunkIndex: r.chunk_index,
                        tokenCount: r.token_count,
                        isSummaryChunk: true,
                      },
                    })
                );
                return [...summaryDocs, ...matchedDocs];
              }
            }
          }

          return matchedDocs;
        }
      } catch (err) {
        this.warnLocalFallback(
          err instanceof Error ? err.message : "Error ejecutando match_mia_documents"
        );
      }
    }

    // Local fallback cosine similarity search
    const sessionRecords = this.fallbackStore.get(sessionId) || [];
    const filtered = fileType
      ? sessionRecords.filter((r) => r.doc.metadata?.fileType === fileType)
      : sessionRecords;

    if (filtered.length === 0) return [];

    const scored = filtered
      .map((record) => ({
        doc: record.doc,
        score: this.cosineSimilarity(queryVector, record.vector),
      }))
      .sort((a, b) => b.score - a.score);

    const topDocs = scored.slice(0, topK).map((s) => s.doc);

    if (fileType === "csv") {
      const summaryDocs = filtered
        .filter((r) => Boolean(r.doc.metadata?.isSummaryChunk))
        .map((r) => r.doc);

      for (const sumDoc of summaryDocs) {
        const alreadyIncluded = topDocs.some(
          (d) =>
            d.metadata?.documentId === sumDoc.metadata?.documentId &&
            d.metadata?.chunkIndex === sumDoc.metadata?.chunkIndex
        );
        if (!alreadyIncluded) {
          topDocs.unshift(sumDoc);
        }
      }
    }

    return topDocs;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
