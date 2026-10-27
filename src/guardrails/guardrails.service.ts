import { z } from "zod";
import { env } from "../config/env";
import { inspectZip } from "../utils/zip-guard";
import {
  SessionState,
  TravelState,
  TransportOptionItem,
  UIPayload,
  QuoteDraft,
} from "../types";
import {
  AppError,
  createGuardrailBlockedError,
  createQuotaExceededError,
} from "../utils/errors";

export class GuardrailError extends AppError {
  constructor(message: string, statusCode = 400, code = "GUARDRAIL_BLOCKED") {
    super({ statusCode, code, message, retryable: false });
    this.name = "GuardrailError";
  }
}

export const TransportOptionSchema: z.ZodType<
  TransportOptionItem,
  z.ZodTypeDef,
  unknown
> = z.object({
  provider: z.string().min(1),
  serviceName: z.string().optional(),
  departurePoint: z.string().optional(),
  arrivalPoint: z.string().optional(),
  estimatedDuration: z.string().optional(),
  frequencyOrSchedule: z.string().optional(),
  departureTimes: z.array(z.string()).optional(),
  serviceClass: z.string().optional(),
  vehicleCategory: z.string().optional(),
  highlights: z.array(z.string()).default([]),
  sourceUrl: z.string().optional(),
});

export const UIPayloadSchema: z.ZodType<UIPayload, z.ZodTypeDef, unknown> =
  z.object({
  type: z
    .enum([
      "none",
      "transport_options",
      "table",
      "summary_cards",
      "extracted_fields",
      "quote_draft",
    ])
    .default("none"),
  title: z.string().optional(),
  serviceType: z
    .enum(["flight", "car_rental", "chauffeur", "ferry", "train", "bus"])
    .optional(),
  route: z
    .object({
      origin: z.string().optional(),
      destination: z.string().optional(),
      date: z.string().optional(),
      passengers: z.number().optional(),
    })
    .optional(),
  options: z.array(TransportOptionSchema).optional(),
  tableData: z
    .object({
      columns: z.array(z.string()),
      rows: z.array(
        z.record(z.string(), z.union([z.string(), z.number(), z.null()]))
      ),
    })
    .optional(),
  cards: z
    .array(
      z.object({
        label: z.string(),
        value: z.union([z.string(), z.number()]),
        description: z.string().optional(),
      })
    )
    .optional(),
  // El borrador de cotización ya viene validado por el QuoteAgent.
  quoteDraft: z.custom<QuoteDraft>().optional(),
});

export const TravelStateSchema: z.ZodType<Partial<TravelState>> = z.object({
  activeService: z
    .enum(["flight", "car_rental", "chauffeur", "ferry", "train", "bus"])
    .optional(),
  origin: z.string().optional(),
  destination: z.string().optional(),
  departureDate: z.string().optional(),
  returnDate: z.string().optional(),
  passengers: z.number().optional(),
  serviceClass: z.string().optional(),
  vehicleType: z.string().optional(),
  withDriver: z.boolean().optional(),
  notes: z.string().optional(),
});

const StructuredAgentOutputSchema = z.object({
  answer: z.string().min(1),
  uiPayload: UIPayloadSchema.optional(),
  suggestedActions: z.array(z.string()).optional(),
  updatedTravelState: TravelStateSchema.optional(),
  options: z.array(TransportOptionSchema).optional(),
});

export class GuardrailsService {
  private static readonly MAX_MESSAGE_LENGTH = 2000;

  private static readonly PROMPT_INJECTION_PATTERNS: RegExp[] = [
    /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts|rules)/i,
    /ignora\s+(todas\s+)?(las\s+)?(instrucciones|reglas)\s+(anteriores|previas)/i,
    /olvida\s+(todas\s+)?(las\s+)?(instrucciones|reglas)\s+(anteriores|previas)/i,
    /system\s*prompt/i,
    /reveal\s+(your\s+)?(system|initial)\s+(prompt|instructions)/i,
    /muestra\s+(tu\s+)?(prompt|instrucciones)\s+(del\s+sistema|iniciales)/i,
    /jailbreak/i,
    /dan\s+mode/i,
    /developer\s+mode\s+enabled/i,
    /act\s+as\s+an\s+unrestricted/i,
    /bypass\s+(safety|security|guardrails|filters)/i,
    /<script[\s>]/i,
    /javascript:/i,
    /<\s*iframe/i,
    /\bDROP\s+TABLE\b/i,
    /\bUNION\s+SELECT\b/i,
  ];

  public validateUserMessage(message: string): { sanitizedMessage: string } {
    if (!message || typeof message !== "string") {
      throw new GuardrailError(
        "El mensaje no puede estar vacío.",
        400,
        "GUARDRAIL_BLOCKED"
      );
    }

    const trimmed = message.trim();
    if (trimmed.length === 0) {
      throw new GuardrailError(
        "El mensaje no puede estar vacío.",
        400,
        "GUARDRAIL_BLOCKED"
      );
    }

    if (trimmed.length > GuardrailsService.MAX_MESSAGE_LENGTH) {
      throw new GuardrailError(
        `El mensaje excede el límite máximo de ${GuardrailsService.MAX_MESSAGE_LENGTH} caracteres.`,
        400,
        "GUARDRAIL_BLOCKED"
      );
    }

    for (const pattern of GuardrailsService.PROMPT_INJECTION_PATTERNS) {
      if (pattern.test(trimmed)) {
        throw new GuardrailError(
          "Tu mensaje contiene patrones no permitidos por las políticas de seguridad de MIA (Prompt Injection / XSS Guardrail).",
          400,
          "GUARDRAIL_BLOCKED"
        );
      }
    }

    // Sanitize control characters and potential HTML script tags
    const sanitizedMessage = trimmed
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .replace(/<\/?script[^>]*>/gi, "");

    return { sanitizedMessage };
  }

  public validateFileUpload(file?: Express.Multer.File): {
    fileType: "pdf" | "csv";
  } {
    if (!file) {
      throw new GuardrailError(
        "No se proporcionó ningún archivo para analizar.",
        400,
        "INVALID_FILE"
      );
    }

    const maxBytes = env.maxFileSizeMb * 1024 * 1024;
    if (file.size > maxBytes) {
      throw new GuardrailError(
        `El archivo "${file.originalname}" excede el límite máximo permitido de ${env.maxFileSizeMb} MB para procesamiento serverless.`,
        413,
        "FILE_TOO_LARGE"
      );
    }

    if (file.size === 0 || !file.buffer || file.buffer.length === 0) {
      throw new GuardrailError(
        `El archivo "${file.originalname}" está vacío.`,
        400,
        "EMPTY_FILE"
      );
    }

    const lowerName = file.originalname.toLowerCase();
    const mime = (file.mimetype || "").toLowerCase();

    const isPdf =
      lowerName.endsWith(".pdf") &&
      (mime === "application/pdf" || mime === "application/octet-stream");

    const isCsv =
      lowerName.endsWith(".csv") &&
      (mime === "text/csv" ||
        mime === "application/vnd.ms-excel" ||
        mime === "text/plain" ||
        mime === "application/csv" ||
        mime === "application/octet-stream");

    if (isPdf) {
      return { fileType: "pdf" };
    }

    if (isCsv) {
      return { fileType: "csv" };
    }

    throw new GuardrailError(
      `Formato de archivo no soportado ("${file.originalname}"). MIA únicamente acepta archivos .PDF y .CSV.`,
      400,
      "UNSUPPORTED_FILE_TYPE"
    );
  }

  /**
   * Valida un adjunto del modo cotización (PDF, CSV, Excel .xlsx o imagen).
   * Además de extensión/MIME comprueba la firma real del archivo.
   */
  public validateQuoteFile(file: Express.Multer.File): {
    kind: "pdf" | "csv" | "excel" | "image";
    mimeType: string;
  } {
    const maxBytes = env.maxFileSizeMb * 1024 * 1024;
    if (file.size > maxBytes) {
      throw new GuardrailError(
        `El archivo "${file.originalname}" excede el límite máximo de ${env.maxFileSizeMb} MB.`,
        413,
        "FILE_TOO_LARGE"
      );
    }
    if (file.size === 0 || !file.buffer || file.buffer.length === 0) {
      throw new GuardrailError(
        `El archivo "${file.originalname}" está vacío.`,
        400,
        "EMPTY_FILE"
      );
    }

    const name = file.originalname.toLowerCase();
    const head = file.buffer.subarray(0, 12);
    const startsWith = (...bytes: number[]) =>
      bytes.every((b, i) => head[i] === b);

    const unsupported = () =>
      new GuardrailError(
        `Formato no soportado ("${file.originalname}"). En cotizaciones acepto PDF, CSV, Excel (.xlsx) e imágenes (PNG, JPG, WEBP).`,
        400,
        "UNSUPPORTED_FILE_TYPE"
      );

    if (name.endsWith(".pdf")) {
      if (!startsWith(0x25, 0x50, 0x44, 0x46)) throw unsupported();
      return { kind: "pdf", mimeType: "application/pdf" };
    }
    if (name.endsWith(".xlsx")) {
      if (!startsWith(0x50, 0x4b)) throw unsupported();
      // Un .xlsx es un ZIP: se descarta si al descomprimirse es desproporcionado (zip bomb).
      const zip = inspectZip(file.buffer);
      if (!zip.ok) {
        throw new GuardrailError(
          `No puedo leer "${file.originalname}": ${zip.reason}. Revisa el archivo o guárdalo de nuevo como .xlsx.`,
          400,
          "FILE_TOO_COMPLEX"
        );
      }
      return {
        kind: "excel",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      };
    }
    if (name.endsWith(".xls")) {
      throw new GuardrailError(
        `"${file.originalname}" es un Excel antiguo (.xls). Guárdalo como .xlsx y vuelve a subirlo.`,
        400,
        "UNSUPPORTED_FILE_TYPE"
      );
    }
    if (name.endsWith(".csv")) {
      if (head.includes(0x00)) throw unsupported();
      return { kind: "csv", mimeType: "text/csv" };
    }
    if (name.endsWith(".png")) {
      if (!startsWith(0x89, 0x50, 0x4e, 0x47)) throw unsupported();
      return { kind: "image", mimeType: "image/png" };
    }
    if (name.endsWith(".jpg") || name.endsWith(".jpeg")) {
      if (!startsWith(0xff, 0xd8, 0xff)) throw unsupported();
      return { kind: "image", mimeType: "image/jpeg" };
    }
    if (name.endsWith(".webp")) {
      const isWebp =
        startsWith(0x52, 0x49, 0x46, 0x46) &&
        head[8] === 0x57 &&
        head[9] === 0x45 &&
        head[10] === 0x42 &&
        head[11] === 0x50;
      if (!isWebp) throw unsupported();
      return { kind: "image", mimeType: "image/webp" };
    }

    throw unsupported();
  }

  public validateSessionQuota(
    session: SessionState,
    action: "message" | "file"
  ): void {
    if (action === "message" && session.messagesUsed >= session.maxMessages) {
      throw new GuardrailError(
        `Has alcanzado el límite máximo de ${session.maxMessages} mensajes por sesión en esta demostración. Crea o reinicia una nueva sesión para continuar.`,
        429,
        "SESSION_MESSAGE_QUOTA_EXCEEDED"
      );
    }

    if (action === "file" && session.filesUploaded >= session.maxFiles) {
      throw new GuardrailError(
        `Has alcanzado el límite máximo de ${session.maxFiles} archivos subidos por sesión (${env.maxFileSizeMb} MB máx c/u).`,
        429,
        "SESSION_FILE_QUOTA_EXCEEDED"
      );
    }
  }

  public sanitizeAndValidateOutput(rawText: string): {
    answer: string;
    uiPayload: UIPayload;
    suggestedActions: string[];
    updatedTravelState?: Partial<TravelState>;
  } {
    const cleaned = (rawText || "").trim();
    if (!cleaned) {
      return {
        answer: "Lo siento, no pude generar una respuesta válida en este momento.",
        uiPayload: { type: "none" },
        suggestedActions: [
          "Intentar nuevamente",
          "Consultar opciones de transporte",
        ],
      };
    }

    const jsonCandidate = this.extractJsonString(cleaned);
    if (jsonCandidate) {
      try {
        const parsed = JSON.parse(jsonCandidate);
        const validated = StructuredAgentOutputSchema.safeParse(parsed);

        if (validated.success) {
          const data = validated.data;
          return {
            answer: data.answer,
            uiPayload: data.uiPayload || { type: "none" },
            suggestedActions:
              data.suggestedActions && data.suggestedActions.length > 0
                ? data.suggestedActions.slice(0, 4)
                : ["¿Qué otras opciones de transporte existen?"],
            updatedTravelState: data.updatedTravelState,
          };
        }

        // Partial fallback if JSON was parsed but had minor schema differences
        if (typeof parsed === "object" && parsed !== null && typeof parsed.answer === "string") {
          const safeUi = UIPayloadSchema.safeParse(parsed.uiPayload);
          const safeTravelState = TravelStateSchema.safeParse(parsed.updatedTravelState);
          return {
            answer: parsed.answer,
            uiPayload: safeUi.success ? safeUi.data : { type: "none" },
            suggestedActions: Array.isArray(parsed.suggestedActions)
              ? parsed.suggestedActions.filter((x: unknown) => typeof x === "string").slice(0, 4)
              : ["Consultar otra ruta", "Analizar documento adjunto"],
            updatedTravelState: safeTravelState.success ? safeTravelState.data : undefined,
          };
        }
      } catch {
        // Fall through to plain markdown text response
      }
    }

    return {
      answer: cleaned,
      uiPayload: { type: "none" },
      suggestedActions: [
        "Buscar vuelos para esta ruta",
        "Comparar con autobús o tren",
        "Subir un archivo PDF o CSV",
      ],
    };
  }

  public extractJsonString(text: string): string | null {
    const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch && fencedMatch[1]) {
      return fencedMatch[1].trim();
    }

    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return text.slice(firstBrace, lastBrace + 1).trim();
    }

    return null;
  }
}
