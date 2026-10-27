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
  | "quote_agent"
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
  departureTimes?: string[];
  serviceClass?: string;
  vehicleCategory?: string;
  highlights: string[];
  sourceUrl?: string;
}

// Opción encontrada por un agente de transporte y anexada a un ítem de cotización.
// Mismo shape que TransportOptionItem, con un id propio para que el cliente marque su preferida.
export interface QuoteFoundOption extends TransportOptionItem {
  id: string;
}

export type UIPayloadType =
  | "none"
  | "transport_options"
  | "table"
  | "summary_cards"
  | "extracted_fields"
  | "quote_draft";

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
  quoteDraft?: QuoteDraft;
}

// --- Cotizaciones (borrador que revisa el usuario antes de enviarlo a Operaciones) ---
// Fechas ISO YYYY-MM-DD, horas HH:mm. Sin ningún campo de precio: lo cotiza Operaciones.
export type QuoteServiceType = "flight" | "car_rental" | "hotel" | "bus";

interface QuoteItemBase {
  id: string;
  type: QuoteServiceType;
  travelers?: number;
  travelerNames?: string[];
  notes?: string;
}

export interface FlightQuoteItem extends QuoteItemBase {
  type: "flight";
  tripType?: "oneway" | "roundtrip" | "multicity";
  origin?: string;
  destination?: string;
  departureDate?: string;
  returnDate?: string;
  airline?: string;
  cabin?: string;
  flightNumber?: string;
  foundOptions?: QuoteFoundOption[];
  preferredOptionId?: string | null;
}

export interface CarRentalQuoteItem extends QuoteItemBase {
  type: "car_rental";
  pickupLocation?: string;
  dropoffLocation?: string;
  pickupDate?: string;
  dropoffDate?: string;
  pickupTime?: string;
  dropoffTime?: string;
  carCategory?: string;
  withDriver?: boolean;
  foundOptions?: QuoteFoundOption[];
  preferredOptionId?: string | null;
}

export interface HotelQuoteItem extends QuoteItemBase {
  type: "hotel";
  city?: string;
  hotelName?: string;
  checkIn?: string;
  checkOut?: string;
  rooms?: number;
  roomType?: string;
  guests?: number;
}

export interface BusQuoteItem extends QuoteItemBase {
  type: "bus";
  origin?: string;
  destination?: string;
  departureDate?: string;
  returnDate?: string;
  busLine?: string;
  serviceClass?: string;
  foundOptions?: QuoteFoundOption[];
  preferredOptionId?: string | null;
}

export type QuoteItem =
  | FlightQuoteItem
  | CarRentalQuoteItem
  | HotelQuoteItem
  | BusQuoteItem;

export interface QuoteFileRef {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string | null;
  uploadError?: string;
}

export interface QuoteMissingField {
  itemId: string;
  field: string;
  label: string;
}

export interface QuoteDraft {
  resumen: string;
  items: QuoteItem[];
  notes?: string;
  files: QuoteFileRef[];
  missingFields: QuoteMissingField[];
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
