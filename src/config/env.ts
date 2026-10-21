import dotenv from "dotenv";

dotenv.config();

export const env = {
  port: Number(process.env.PORT || 4005),
  nodeEnv: process.env.NODE_ENV || "development",
  defaultProvider: (process.env.DEFAULT_LLM_PROVIDER || "gemini") as "gemini" | "openai",
  fallbackProvider: (process.env.FALLBACK_LLM_PROVIDER || "openai") as "gemini" | "openai",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  geminiChatModel: process.env.GEMINI_CHAT_MODEL || "gemini-2.5-flash",
  openaiChatModel: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
  geminiEmbeddingModel: process.env.GEMINI_EMBEDDING_MODEL || "text-embedding-004",
  openaiEmbeddingModel: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
  embeddingDimensions: Number(process.env.EMBEDDING_DIMENSIONS || 768),
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  maxMessagesPerSession: Number(process.env.MAX_MESSAGES_PER_SESSION || 25),
  maxFilesPerSession: Number(process.env.MAX_FILES_PER_SESSION || 3),
  maxFileSizeMb: Number(process.env.MAX_FILE_SIZE_MB || 4),
  slidingWindowMessages: Number(process.env.SLIDING_WINDOW_MESSAGES || 6),
  chunkSizeTokens: Number(process.env.CHUNK_SIZE_TOKENS || 500),
  chunkOverlapTokens: Number(process.env.CHUNK_OVERLAP_TOKENS || 50),
};
