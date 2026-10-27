import { NextFunction, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { AgentRouterOrchestrator } from "../agents/agent-router.orchestrator";
import { QuoteInputFile } from "../agents/quote/quote-input.reader";
import {
  QuoteDraftInput,
  QuoteDraftInputSchema,
} from "../agents/quote/quote.schema";
import { GuardrailsService } from "../guardrails/guardrails.service";
import { ChatSessionRepository } from "../repositories/chat-session.repository";
import { SupabaseVectorRepository } from "../repositories/supabase-vector.repository";
import { TokenizerRepository } from "../repositories/tokenizer.repository";
import { WebSearchRepository } from "../repositories/web-search.repository";
import { llmContext } from "../strategies/llm.context";
import { AttachedDocumentMeta, LLMProviderType } from "../types";
import { AppError } from "../utils/errors";
import { dropNulls } from "../utils/price-filter";

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
      const rawMessage = (req.body?.message as string) || "";
      const preferredProvider = req.body?.provider as LLMProviderType | undefined;

      // El router de multer (fields) deja los archivos en req.files por nombre de campo:
      // `file` = ingesta RAG de un PDF/CSV (flujo original), `files` = adjuntos de cotización.
      const uploaded = (
        req.files && !Array.isArray(req.files) ? req.files : {}
      ) as Record<string, Express.Multer.File[]>;
      const singleFile = uploaded.file?.[0] ?? req.file;
      const quoteUploads = uploaded.files ?? [];
      const isQuoteMode = req.body?.mode === "quote" || quoteUploads.length > 0;

      // En modo cotización el archivo suelto también es un adjunto de cotización, no ingesta RAG.
      const quoteFiles: QuoteInputFile[] = (
        isQuoteMode
          ? [...(singleFile ? [singleFile] : []), ...quoteUploads]
          : []
      ).map((file) => {
        const { kind, mimeType } = sharedGuardrails.validateQuoteFile(file);
        return {
          // multer decodifica el nombre como latin1; se recupera el UTF-8 original (acentos).
          fileName: Buffer.from(file.originalname, "latin1").toString("utf8"),
          mimeType,
          kind,
          buffer: file.buffer,
        };
      });

      const message =
        rawMessage.trim() ||
        (quoteFiles.length > 0
          ? "Cotiza lo que viene en los archivos adjuntos."
          : rawMessage);
      const currentDraft = isQuoteMode
        ? this.parseCurrentDraft(req.body?.currentDraft)
        : undefined;

      // Si en la misma llamada adjuntaron un archivo PDF o CSV, lo tokenizamos e indexamos primero
      if (!isQuoteMode && singleFile) {
        sharedGuardrails.validateFileUpload(singleFile);
        const session = await sharedSessionRepo.getOrCreateSession(
          sessionId,
          userId
        );
        sharedGuardrails.validateSessionQuota(session, "file");

        const tokenized = await sharedTokenizerRepo.tokenizeFile({
          buffer: singleFile.buffer,
          fileName: singleFile.originalname,
          mimeType: singleFile.mimetype,
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
        ...(isQuoteMode ? { mode: "quote" as const, currentDraft, quoteFiles } : {}),
      });

      res.status(200).json({
        ok: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  // currentDraft llega como JSON string en multipart o como objeto en JSON; si no es válido se ignora.
  private parseCurrentDraft(raw: unknown): QuoteDraftInput | undefined {
    let value: unknown = raw;
    if (typeof raw === "string") {
      if (!raw.trim()) return undefined;
      try {
        value = JSON.parse(raw);
      } catch {
        return undefined;
      }
    }
    if (!value || typeof value !== "object") return undefined;
    const parsed = QuoteDraftInputSchema.safeParse(dropNulls(value));
    return parsed.success ? parsed.data : undefined;
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
