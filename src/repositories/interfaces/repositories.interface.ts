import type { Document } from "@langchain/core/documents";
import type { Embeddings } from "@langchain/core/embeddings";
import type {
  ChatMessageRecord,
  SessionState,
  TransportServiceType,
  WebSearchResultItem,
} from "../../types/index";

export interface TokenizedDocumentResult {
  documentId: string;
  fileName: string;
  fileType: "pdf" | "csv";
  chunks: Document[];
  totalChunks: number;
  totalTokens: number;
  summaryText?: string;
}

export interface ITokenizerRepository {
  tokenizeFile(params: {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
    sessionId: string;
    userId: string;
  }): Promise<TokenizedDocumentResult>;
}

export interface IVectorStoreRepository {
  storeDocumentChunks(chunks: Document[], embeddings: Embeddings): Promise<void>;
  searchSimilarChunks(params: {
    query: string;
    sessionId: string;
    userId?: string;
    fileType?: "pdf" | "csv";
    topK?: number;
    embeddings: Embeddings;
  }): Promise<Document[]>;
}

export interface IChatSessionRepository {
  getOrCreateSession(sessionId: string, userId: string): Promise<SessionState>;
  updateSessionState(
    sessionId: string,
    partial: Partial<
      Pick<
        SessionState,
        "messagesUsed" | "filesUploaded" | "attachedDocuments" | "travelState"
      >
    >
  ): Promise<SessionState>;
  saveMessage(message: ChatMessageRecord): Promise<void>;
  getRecentMessages(sessionId: string, limit?: number): Promise<ChatMessageRecord[]>;
  getAllSessionMessages(sessionId: string): Promise<ChatMessageRecord[]>;
}

export interface IWebSearchRepository {
  searchWeb(query: string, maxResults?: number): Promise<WebSearchResultItem[]>;
}

export interface TransportSearchQuery {
  origin?: string;
  destination?: string;
  date?: string;
  passengers?: number;
  extraContext?: string;
}

export interface ITransportServiceRepository {
  readonly serviceType: TransportServiceType;
  searchServiceInfo(query: TransportSearchQuery): Promise<{
    rawSearchContext: string;
    webSources: WebSearchResultItem[];
  }>;
}
