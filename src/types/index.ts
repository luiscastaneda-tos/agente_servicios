export type LLMProviderType = "gemini" | "openai";

export type TransportServiceType =
  | "flight"
  | "car_rental"
  | "chauffeur"
  | "ferry"
  | "train"
  | "bus";

export type AgentSpecialtyType =
  | TransportServiceType
  | "pdf_specialist"
  | "csv_analyst"
  | "general_assistant";

export interface TravelState {
  activeService?: TransportServiceType;
  origin?: string;
  destination?: string;
  departureDate?: string;
  returnDate?: string;
  passengers?: number;
  serviceClass?: string;
  vehicleType?: string;
  withDriver?: boolean;
  notes?: string;
}

export interface AttachedDocumentMeta {
  documentId: string;
  fileName: string;
  fileType: "pdf" | "csv";
  totalChunks: number;
  totalTokens: number;
  uploadedAt: string;
}

export interface SessionState {
  sessionId: string;
  userId: string;
  messagesUsed: number;
  maxMessages: number;
  filesUploaded: number;
  maxFiles: number;
  attachedDocuments: AttachedDocumentMeta[];
  travelState: TravelState;
  createdAt: string;
  updatedAt: string;
}

export interface TransportOptionItem {
  provider: string;
  serviceName?: string;
  departurePoint?: string;
  arrivalPoint?: string;
  estimatedDuration?: string;
  frequencyOrSchedule?: string;
  serviceClass?: string;
  vehicleCategory?: string;
  highlights: string[];
  sourceUrl?: string;
}

export type UIPayloadType =
  | "none"
  | "transport_options"
  | "table"
  | "summary_cards"
  | "extracted_fields";

export interface UIPayload {
  type: UIPayloadType;
  title?: string;
  serviceType?: TransportServiceType;
  route?: {
    origin?: string;
    destination?: string;
    date?: string;
    passengers?: number;
  };
  options?: TransportOptionItem[];
  tableData?: {
    columns: string[];
    rows: Record<string, string | number | null>[];
  };
  cards?: Array<{
    label: string;
    value: string | number;
    description?: string;
  }>;
}

export interface DocumentSourceCitation {
  fileName: string;
  fileType: "pdf" | "csv";
  pageOrRowRange: string;
  snippet: string;
  isSummaryChunk?: boolean;
}

export interface TokenUsageMeta {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResponseMetadata {
  sessionId: string;
  agentUsed: AgentSpecialtyType;
  providerUsed: LLMProviderType;
  modelUsed: string;
  fallbackTriggered: boolean;
  tokenUsage: TokenUsageMeta;
  latencyMs: number;
  sources: DocumentSourceCitation[];
  webSourcesUsed?: Array<{ title: string; url: string }>;
  quota: {
    messagesUsed: number;
    maxMessages: number;
    messagesRemaining: number;
    filesUploaded: number;
    maxFiles: number;
  };
}

export interface AgentExecutionResult {
  answer: string;
  uiPayload: UIPayload;
  suggestedActions: string[];
  updatedTravelState?: Partial<TravelState>;
  metadata: ChatResponseMetadata;
}

export interface ChatMessageRecord {
  id?: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  uiPayload?: UIPayload;
  metadata?: Partial<ChatResponseMetadata>;
  createdAt: string;
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}
