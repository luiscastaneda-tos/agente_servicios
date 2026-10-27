import { Router } from "express";
import multer from "multer";
import { env } from "../config/env";
import { isSupabaseConfigured } from "../config/supabase";
import { chatController } from "../controllers/chat.controller";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.maxFileSizeMb * 1024 * 1024,
  },
});

export const chatRouter = Router();

// Health & capabilities endpoint
chatRouter.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "mia-ai-service",
    defaultProvider: env.defaultProvider,
    fallbackProvider: env.fallbackProvider,
    supabaseConfigured: isSupabaseConfigured(),
    agents: [
      "flight",
      "car_rental",
      "chauffeur",
      "ferry",
      "train",
      "bus",
      "pdf_specialist",
      "csv_analyst",
      "general_assistant",
    ],
    quotas: {
      maxMessagesPerSession: env.maxMessagesPerSession,
      maxFilesPerSession: env.maxFilesPerSession,
      maxFileSizeMb: env.maxFileSizeMb,
      slidingWindowMessages: env.slidingWindowMessages,
    },
  });
});

// Tokenización e ingesta de PDF / CSV
chatRouter.post(
  "/documents/ingest",
  upload.single("file"),
  (req, res, next) => chatController.ingestDocument(req, res, next)
);

// Chat multi-agente (acepta JSON o multipart/form-data):
//  - `file`: un PDF/CSV para ingesta RAG (flujo original)
//  - `files`: hasta 3 adjuntos (PDF, CSV, Excel, imagen) para el modo cotización
chatRouter.post(
  "/chat",
  upload.fields([
    { name: "file", maxCount: 1 },
    { name: "files", maxCount: 3 },
  ]),
  (req, res, next) => chatController.sendMessage(req, res, next)
);

// Obtener estado completo de una sesión (travelState, archivos, cuota y mensajes)
chatRouter.get("/chat/session/:sessionId", (req, res, next) =>
  chatController.getSessionState(req, res, next)
);
