import { NextFunction, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { AgentRouterOrchestrator } from "../agents/agent-router.orchestrator";
import { GuardrailsService } from "../guardrails/guardrails.service";
import { ChatSessionRepository } from "../repositories/chat-session.repository";
import { SupabaseVectorRepository } from "../repositories/supabase-vector.repository";
import { TokenizerRepository } from "../repositories/tokenizer.repository";
import { WebSearchRepository } from "../repositories/web-search.repository";
import { llmContext } from "../strategies/llm.context";
import { AttachedDocumentMeta, LLMProviderType } from "../types";
import { AppError } from "../utils/errors";

// Shared repository instances so local fallback state (when Supabase env is not yet set)
// is shared seamlessly between document ingestion and chat orchestration.
const sharedSessionRepo = new ChatSessionRepository();
const sharedVectorStoreRepo = new SupabaseVectorRepository();
const sharedWebSearchRepo = new WebSearchRepository();
const sharedTokenizerRepo = new TokenizerRepository();
const sharedGuardrails = new GuardrailsService();

const agentOrchestrator = new AgentRouterOrchestrator({
  sessionRepo: sharedSessionRepo,
  vectorStoreRepo: sharedVectorStoreRepo,
  webSearchRepo: sharedWebSearchRepo,
  llm: llmContext,
  guardrails: sharedGuardrails,
});

export class ChatController {
  /**
   * POST /api/v1/documents/ingest
   * Recibe un PDF o CSV, lo tokeniza con LangChain (TokenTextSplitter) y almacena sus embeddings.
   */
  public async ingestDocument(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const file = req.file;
      const sessionId = (req.body?.sessionId as string) || uuidv4();
      const userId = (req.body?.userId as string) || "anonymous";
      const preferredProvider = req.body?.provider as LLMProviderType | undefined;

      // 1. Guardrail de archivo (tipo PDF/CSV y límite 4MB para Vercel)
      const { fileType } = sharedGuardrails.validateFileUpload(file);
      if (!file) {
        throw new AppError({
          statusCode: 400,
          code: "FILE_REQUIRED",
          message: "Debes adjuntar un archivo PDF o CSV en el campo 'file'.",
          retryable: false,
        });
      }

      // 2. Cargar sesión y validar cuota de archivos
      const session = await sharedSessionRepo.getOrCreateSession(
        sessionId,
        userId
      );
      sharedGuardrails.validateSessionQuota(session, "file");

      // 3. Tokenizar el PDF o CSV con LangChain (PDFLoader / CSVLoader + TokenTextSplitter)
      const tokenized = await sharedTokenizerRepo.tokenizeFile({
        buffer: file.buffer,
        fileName: file.originalname,
        mimeType: file.mimetype,
        sessionId,
        userId,
      });

      // 4. Generar embeddings (768 dims con fallback automático) y guardar en VectorStoreRepository
      const embeddings = llmContext.getEmbeddingsWithFallback(preferredProvider);
      await sharedVectorStoreRepo.storeDocumentChunks(
        tokenized.chunks,
        embeddings
      );

      // 5. Actualizar estado de la sesión con el documento adjunto
      const newDocMeta: AttachedDocumentMeta = {
        documentId: tokenized.documentId,
        fileName: tokenized.fileName,
        fileType: tokenized.fileType,
        totalChunks: tokenized.totalChunks,
        totalTokens: tokenized.totalTokens,
        uploadedAt: new Date().toISOString(),
      };

      const updatedAttachedDocs = [...session.attachedDocuments, newDocMeta];
      const updatedSession = await sharedSessionRepo.updateSessionState(
        sessionId,
        {
          filesUploaded: session.filesUploaded + 1,
          attachedDocuments: updatedAttachedDocs,
        }
      );

      res.status(200).json({
        ok: true,
        data: {
          sessionId,
          document: newDocMeta,
          summaryPreview: tokenized.summaryText || null,
          sampleChunks: tokenized.chunks.slice(0, 2).map((c) => ({
            preview: c.pageContent.slice(0, 200),
            metadata: c.metadata,
          })),
          quota: {
            filesUploaded: updatedSession.filesUploaded,
            maxFiles: updatedSession.maxFiles,
            filesRemaining: Math.max(
              0,
              updatedSession.maxFiles - updatedSession.filesUploaded
            ),
            messagesUsed: updatedSession.messagesUsed,
            maxMessages: updatedSession.maxMessages,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/chat
   * Soporta tanto JSON ({ sessionId, userId, message, provider })
   * como multipart/form-data si el usuario adjunta un PDF/CSV y envía un mensaje al mismo tiempo.
   */
  public async sendMessage(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const sessionId = (req.body?.sessionId as string) || uuidv4();
      const userId = (req.body?.userId as string) || "anonymous";
      const message = (req.body?.message as string) || "";
      const preferredProvider = req.body?.provider as LLMProviderType | undefined;

      // Si en la misma llamada adjuntaron un archivo PDF o CSV, lo tokenizamos e indexamos primero
      if (req.file) {
        sharedGuardrails.validateFileUpload(req.file);
        const session = await sharedSessionRepo.getOrCreateSession(
          sessionId,
          userId
        );
        sharedGuardrails.validateSessionQuota(session, "file");

        const tokenized = await sharedTokenizerRepo.tokenizeFile({
          buffer: req.file.buffer,
          fileName: req.file.originalname,
          mimeType: req.file.mimetype,
          sessionId,
          userId,
        });

        const embeddings =
          llmContext.getEmbeddingsWithFallback(preferredProvider);
        await sharedVectorStoreRepo.storeDocumentChunks(
          tokenized.chunks,
          embeddings
        );

        const newDocMeta: AttachedDocumentMeta = {
          documentId: tokenized.documentId,
          fileName: tokenized.fileName,
          fileType: tokenized.fileType,
          totalChunks: tokenized.totalChunks,
          totalTokens: tokenized.totalTokens,
          uploadedAt: new Date().toISOString(),
        };

        await sharedSessionRepo.updateSessionState(sessionId, {
          filesUploaded: session.filesUploaded + 1,
          attachedDocuments: [...session.attachedDocuments, newDocMeta],
        });
      }

      const result = await agentOrchestrator.routeAndExecute({
        sessionId,
        userId,
        message,
        preferredProvider,
      });

      res.status(200).json({
        ok: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/chat/session/:sessionId
   * Recupera el estado completo de la sesión (travelState, archivos tokenizados, cuota e historial).
   */
  public async getSessionState(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const sessionId = req.params.sessionId as string;
      const userId = (req.query.userId as string) || "anonymous";

      const session = await sharedSessionRepo.getOrCreateSession(
        sessionId,
        userId
      );
      const messages = await sharedSessionRepo.getAllSessionMessages(sessionId);

      res.status(200).json({
        ok: true,
        data: {
          session,
          messages,
        },
      });
    } catch (err) {
      next(err);
    }
  }
}

export const chatController = new ChatController();
