import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { env } from "../config/env";
import { GuardrailsService } from "../guardrails/guardrails.service";
import { ChatSessionRepository } from "../repositories/chat-session.repository";
import {
  IChatSessionRepository,
  IVectorStoreRepository,
  IWebSearchRepository,
} from "../repositories/interfaces/repositories.interface";
import { SupabaseVectorRepository } from "../repositories/supabase-vector.repository";
import {
  BusRepository,
  CarRentalRepository,
  ChauffeurRepository,
  FerryRepository,
  FlightRepository,
  TrainRepository,
} from "../repositories/transport/transport.repositories";
import { WebSearchRepository } from "../repositories/web-search.repository";
import { HotelServiceRepository } from "../repositories/hotel-service.repository";
import { LLMStrategyContext, llmContext } from "../strategies/llm.context";
import {
  AgentExecutionResult,
  AgentSpecialtyType,
  ChatMessageRecord,
  LLMProviderType,
  SessionState,
  TravelState,
} from "../types";
import { parseTravelDate } from "../utils/date-parser";
import { CsvAnalystAgent } from "./documents/csv-analyst.agent";
import { HotelAgent } from "./hotel/hotel.agent";
import { QuoteAgent } from "./quote/quote.agent";
import { QuoteInputFile } from "./quote/quote-input.reader";
import { QuoteDraftInput } from "./quote/quote.schema";
import { PdfSpecialistAgent } from "./documents/pdf-specialist.agent";
import {
  BusAgent,
  CarRentalAgent,
  ChauffeurAgent,
  FerryAgent,
  FlightAgent,
  GeneralMiaAgent,
  TrainAgent,
} from "./transport/transport-specialist.agents";

const IntentClassificationSchema = z.object({
  specialty: z.enum([
    "flight",
    "car_rental",
    "chauffeur",
    "ferry",
    "train",
    "bus",
    "pdf_specialist",
    "csv_analyst",
    "general_assistant",
  ]),
  extractedOrigin: z.string().optional(),
  extractedDestination: z.string().optional(),
});

export interface AgentRouterInput {
  sessionId: string;
  userId?: string;
  message: string;
  preferredProvider?: LLMProviderType;
  // Modo cotización: el mensaje y los adjuntos se convierten en un borrador de cotización.
  mode?: "quote";
  currentDraft?: QuoteDraftInput;
  quoteFiles?: QuoteInputFile[];
}

// Intención explícita de cotizar ("cotiza", "cotízame", "cotización"...).
const QUOTE_INTENT = /\bcotiz(?:a|ar|ame|en|e|aci[oó]n|aciones)\b|\bcot[ií]zame\b/i;

export interface AgentRouterDependencies {
  sessionRepo?: IChatSessionRepository;
  vectorStoreRepo?: IVectorStoreRepository;
  webSearchRepo?: IWebSearchRepository;
  llm?: LLMStrategyContext;
  guardrails?: GuardrailsService;
}

export class AgentRouterOrchestrator {
  private readonly sessionRepo: IChatSessionRepository;
  private readonly vectorStoreRepo: IVectorStoreRepository;
  private readonly webSearchRepo: IWebSearchRepository;
  private readonly llm: LLMStrategyContext;
  private readonly guardrails: GuardrailsService;

  private readonly flightAgent: FlightAgent;
  private readonly carRentalAgent: CarRentalAgent;
  private readonly chauffeurAgent: ChauffeurAgent;
  private readonly ferryAgent: FerryAgent;
  private readonly trainAgent: TrainAgent;
  private readonly busAgent: BusAgent;
  private readonly hotelAgent: HotelAgent;
  private readonly pdfAgent: PdfSpecialistAgent;
  private readonly csvAgent: CsvAnalystAgent;
  private readonly quoteAgent: QuoteAgent;
  private readonly generalAgent: GeneralMiaAgent;

  constructor(deps: AgentRouterDependencies = {}) {
    this.sessionRepo = deps.sessionRepo || new ChatSessionRepository();
    this.vectorStoreRepo = deps.vectorStoreRepo || new SupabaseVectorRepository();
    this.webSearchRepo = deps.webSearchRepo || new WebSearchRepository();
    this.llm = deps.llm || llmContext;
    this.guardrails = deps.guardrails || new GuardrailsService();

    this.flightAgent = new FlightAgent(
      new FlightRepository(this.webSearchRepo),
      this.llm,
      this.guardrails
    );
    this.carRentalAgent = new CarRentalAgent(
      new CarRentalRepository(this.webSearchRepo),
      this.llm,
      this.guardrails
    );
    this.chauffeurAgent = new ChauffeurAgent(
      new ChauffeurRepository(this.webSearchRepo),
      this.llm,
      this.guardrails
    );
    this.ferryAgent = new FerryAgent(
      new FerryRepository(this.webSearchRepo),
      this.llm,
      this.guardrails
    );
    this.trainAgent = new TrainAgent(
      new TrainRepository(this.webSearchRepo),
      this.llm,
      this.guardrails
    );
    this.busAgent = new BusAgent(
      new BusRepository(this.webSearchRepo),
      this.llm,
      this.guardrails
    );
    this.hotelAgent = new HotelAgent(new HotelServiceRepository());
    this.pdfAgent = new PdfSpecialistAgent(
      this.vectorStoreRepo,
      this.llm,
      this.guardrails
    );
    this.csvAgent = new CsvAnalystAgent(
      this.vectorStoreRepo,
      this.llm,
      this.guardrails
    );
    this.quoteAgent = new QuoteAgent(
      this.llm,
      this.guardrails,
      undefined,
      this.flightAgent,
      this.carRentalAgent,
      this.busAgent,
      this.hotelAgent
    );
    this.generalAgent = new GeneralMiaAgent(this.llm, this.guardrails);
  }

  public async routeAndExecute(
    input: AgentRouterInput
  ): Promise<AgentExecutionResult> {
    const startTime = Date.now();
    const userId = input.userId || "anonymous";
    const { sessionId, preferredProvider } = input;

    // 1. Validate & sanitize input message via GuardrailsService
    const { sanitizedMessage } = this.guardrails.validateUserMessage(
      input.message
    );

    // 2. Load session & enforce message quota
    const session = await this.sessionRepo.getOrCreateSession(
      sessionId,
      userId
    );
    this.guardrails.validateSessionQuota(session, "message");

    // 3. Fetch sliding window chat history
    const recentHistory = await this.sessionRepo.getRecentMessages(
      sessionId,
      env.slidingWindowMessages
    );

    // 4. Classify intent into one of the specialties (el modo/intención de cotizar tiene prioridad)
    const classification: {
      specialty: AgentSpecialtyType;
      extractedOrigin?: string;
      extractedDestination?: string;
    } =
      input.mode === "quote" || QUOTE_INTENT.test(sanitizedMessage)
        ? { specialty: "quote_agent" }
        : await this.classifyIntent(
            sanitizedMessage,
            session,
            recentHistory,
            preferredProvider
          );

    // Pre-merge any route hints detected during classification into session.travelState
    const workingSession: SessionState = {
      ...session,
      travelState: {
        ...session.travelState,
        ...(classification.extractedOrigin
          ? { origin: classification.extractedOrigin }
          : {}),
        ...(classification.extractedDestination
          ? { destination: classification.extractedDestination }
          : {}),
      },
    };

    // 5. Delegate execution to the selected specialist agent
    const executionParams = {
      session: workingSession,
      userMessage: sanitizedMessage,
      recentHistory,
      preferredProvider,
    };

    let result: AgentExecutionResult;

    switch (classification.specialty) {
      case "flight":
        result = await this.flightAgent.execute(executionParams);
        break;
      case "car_rental":
        result = await this.carRentalAgent.execute(executionParams);
        break;
      case "chauffeur":
        result = await this.chauffeurAgent.execute(executionParams);
        break;
      case "ferry":
        result = await this.ferryAgent.execute(executionParams);
        break;
      case "train":
        result = await this.trainAgent.execute(executionParams);
        break;
      case "bus":
        result = await this.busAgent.execute(executionParams);
        break;
      case "pdf_specialist":
        result = await this.pdfAgent.execute(executionParams);
        break;
      case "csv_analyst":
        result = await this.csvAgent.execute(executionParams);
        break;
      case "quote_agent":
        result = await this.quoteAgent.execute({
          ...executionParams,
          currentDraft: input.currentDraft,
          files: input.quoteFiles,
        });
        break;
      case "general_assistant":
      default:
        result = await this.generalAgent.execute(executionParams);
        break;
    }

    // 6. Update session state (messagesUsed + 1 and merged travelState)
    const newMessagesUsed = session.messagesUsed + 1;
    const mergedTravelState: TravelState = {
      ...workingSession.travelState,
      ...(result.updatedTravelState || {}),
    };

    await this.sessionRepo.updateSessionState(sessionId, {
      messagesUsed: newMessagesUsed,
      travelState: mergedTravelState,
    });

    // Update final metadata with total orchestration latency and accurate quota
    const totalLatencyMs = Date.now() - startTime;
    result.metadata = {
      ...result.metadata,
      sessionId,
      latencyMs: totalLatencyMs,
      quota: {
        messagesUsed: newMessagesUsed,
        maxMessages: session.maxMessages,
        messagesRemaining: Math.max(0, session.maxMessages - newMessagesUsed),
        filesUploaded: session.filesUploaded,
        maxFiles: session.maxFiles,
      },
    };
    result.updatedTravelState = mergedTravelState;

    // 7. Persist both user message and assistant response in ChatSessionRepository
    const nowIso = new Date().toISOString();
    const attachedNames = (input.quoteFiles ?? []).map((f) => f.fileName);
    const userMessageRecord: ChatMessageRecord = {
      sessionId,
      role: "user",
      content:
        attachedNames.length > 0
          ? `${sanitizedMessage}\n📎 ${attachedNames.join(", ")}`
          : sanitizedMessage,
      createdAt: nowIso,
    };

    const assistantMessageRecord: ChatMessageRecord = {
      sessionId,
      role: "assistant",
      content: result.answer,
      uiPayload: result.uiPayload,
      metadata: result.metadata,
      createdAt: new Date(Date.now() + 1).toISOString(),
    };

    await this.sessionRepo.saveMessage(userMessageRecord);
    await this.sessionRepo.saveMessage(assistantMessageRecord);

    return result;
  }

  // Alias methods for convenience across controllers/services
  public async handleUserMessage(
    input: AgentRouterInput
  ): Promise<AgentExecutionResult> {
    return this.routeAndExecute(input);
  }

  public async execute(
    input: AgentRouterInput
  ): Promise<AgentExecutionResult> {
    return this.routeAndExecute(input);
  }

  private async classifyIntent(
    message: string,
    session: SessionState,
    recentHistory: ChatMessageRecord[],
    preferredProvider?: LLMProviderType
  ): Promise<{
    specialty: AgentSpecialtyType;
    extractedOrigin?: string;
    extractedDestination?: string;
  }> {
    const lower = message.toLowerCase();
    const hasPdf = session.attachedDocuments.some((d) => d.fileType === "pdf");
    const hasCsv = session.attachedDocuments.some((d) => d.fileType === "csv");

    // 1. Explicit Document Specialist rules
    if (
      /\b(csv|excel|tabla|filas?|columnas?|promedio|suma\s+total|estad[ií]stic[ao]s?|kpi|registros)\b/i.test(
        lower
      ) &&
      (hasCsv || /\bcsv\b/i.test(lower))
    ) {
      return { specialty: "csv_analyst" };
    }

    if (
      /\b(pdf|p[aá]ginas?|cl[aá]usulas?|contrato|p[oó]liza|factura|itinerario\s+adjunto|documento\s+subido|archivo\s+subido)\b/i.test(
        lower
      ) &&
      (hasPdf || /\bpdf\b/i.test(lower))
    ) {
      return { specialty: "pdf_specialist" };
    }

    // Generic reference to "el archivo / el documento / resúmelo" when a file is attached
    if (
      /\b(este\s+archivo|el\s+archivo|el\s+documento|res[uú]melo|anal[ií]zalo|qu[eé]\s+dice\s+el\s+documento|extrae\s+los\s+datos)\b/i.test(
        lower
      )
    ) {
      const latestDoc =
        session.attachedDocuments[session.attachedDocuments.length - 1];
      if (latestDoc) {
        return {
          specialty:
            latestDoc.fileType === "csv" ? "csv_analyst" : "pdf_specialist",
        };
      }
    }

    // 2. Fast deterministic keyword rules for the 6 Transport Specialties
    // Chauffeur / Private Driver (check before car_rental so "auto con chofer" routes to chauffeur)
    if (
      /\b(chofer|ch[oó]fer|conductor\s+privado|con\s+conductor|transporte\s+ejecutivo|traslado\s+privado|suburban\s+con\s+chofer|van\s+con\s+chofer|chauffeur|transfer\s+privado)\b/i.test(
        lower
      )
    ) {
      return { specialty: "chauffeur" };
    }

    // Car Rental (without driver)
    if (
      /\b(rentar?\s+(un\s+)?auto|renta\s+de\s+autos?|alquiler\s+de\s+(autos?|coches?)|arrendadora|hertz|avis|europcar|enterprise|national\s+car|rent\s+a\s+car|rentar?\s+coche|rentar?\s+camioneta)\b/i.test(
        lower
      )
    ) {
      return { specialty: "car_rental" };
    }

    // Ferry / Maritime
    if (
      /\b(ferry|ferrys|ferries|transbordador|barco|naviera|ultramar|winjet|baja\s+ferries|cruzar\s+en\s+ferry|puerto\s+mar[ií]timo|isla\s+mujeres|cozumel)\b/i.test(
        lower
      )
    ) {
      return { specialty: "ferry" };
    }

    // Train / Rail
    if (
      /\b(tren|trenes|ferrocarril|tren\s+maya|chepe|el\s+insurgente|eurostar|renfe|ave\b|amtrak|estaci[oó]n\s+de\s+tren)\b/i.test(
        lower
      )
    ) {
      return { specialty: "train" };
    }

    // Bus / Coach
    if (
      /\b(autob[uú]s|autobuses|camiones|cami[oó]n|central\s+camionera|terminal\s+de\s+autobuses|tapo|etn|ado\b|primera\s+plus|futura|estrella\s+blanca|turistar)\b/i.test(
        lower
      )
    ) {
      return { specialty: "bus" };
    }

    // Flight / Airlines
    if (
      /\b(vuelo|vuelos|volar|avi[oó]n|aerol[ií]neas?|aeropuerto|aerom[eé]xico|volaris|viva\s*aerobus|escalas?|iata)\b/i.test(
        lower
      )
    ) {
      return { specialty: "flight" };
    }

    // 3a. Respuesta corta con solo fecha o pasajeros ("mañana", "el 15 de noviembre",
    // "somos 3 personas"): continúa con el servicio activo de la sesión.
    if (
      session.travelState.activeService &&
      message.length <= 80 &&
      (parseTravelDate(message) !== null ||
        /^\s*(?:somos\s+)?\d+\s*(?:pasajeros?|personas?|adultos?)\s*[.!]?\s*$/i.test(
          message
        ))
    ) {
      return { specialty: session.travelState.activeService };
    }

    // 3. Contextual follow-up (e.g., "¿y de regreso?", "¿y saliendo de Monterrey?") when activeService exists
    if (
      session.travelState.activeService &&
      /\b(regreso|saliendo\s+de|ahora\s+de|cambiar\s+destino|para\s+\d+\s+personas|horarios|terminales|requisitos)\b/i.test(
        lower
      )
    ) {
      return { specialty: session.travelState.activeService };
    }

    // 4. LLM Intent Classification fallback for ambiguous queries
    try {
      const historySnippet = recentHistory
        .slice(-3)
        .map((m) => `${m.role}: ${m.content.slice(0, 160)}`)
        .join("\n");

      const classifierSystem = `Eres el Clasificador de Intenciones del Orquestador MIA.
Clasifica el mensaje del usuario en EXACTAMENTE UNA de las siguientes 9 especialidades:
- "flight": vuelos, aviones, aerolíneas, aeropuertos.
- "car_rental": renta/alquiler de autos sin chofer, arrendadoras.
- "chauffeur": transporte ejecutivo con chofer privado, conductor privado, traslados VIP.
- "ferry": ferrys, transbordadores marítimos, barcos de pasajeros.
- "train": trenes de pasajeros, rutas ferroviarias.
- "bus": autobuses foráneos, líneas de autobús, centrales camioneras.
- "pdf_specialist": preguntas o análisis sobre documentos PDF subidos.
- "csv_analyst": análisis de datos, sumas, tablas o preguntas sobre archivos CSV subidos.
- "general_assistant": saludos, preguntas generales de viajes sin medio específico, ayuda sobre qué puede hacer MIA.

Responde ÚNICAMENTE con un JSON válido:
{
  "specialty": "flight" | "car_rental" | "chauffeur" | "ferry" | "train" | "bus" | "pdf_specialist" | "csv_analyst" | "general_assistant",
  "extractedOrigin": "Ciudad origen opcional",
  "extractedDestination": "Ciudad destino opcional"
}`;

      const classifierUser = `Estado de viaje actual: ${JSON.stringify(session.travelState)}
Archivos en sesión: ${session.attachedDocuments.map((d) => `${d.fileName} (${d.fileType})`).join(", ") || "Ninguno"}
Historial:
${historySnippet || "Sin historial"}
Mensaje a clasificar: "${message}"`;

      const llmClass = await this.llm.invokeWithFallback(
        [
          new SystemMessage(classifierSystem),
          new HumanMessage(classifierUser),
        ],
        {
          temperature: 0.0,
          maxOutputTokens: 250,
          preferredProvider,
        }
      );

      const jsonStr = this.guardrails.extractJsonString(llmClass.output);
      if (jsonStr) {
        const parsed = IntentClassificationSchema.safeParse(JSON.parse(jsonStr));
        if (parsed.success) {
          return parsed.data;
        }
      }
    } catch {
      // Fallback to general_assistant if classification fails
    }

    return { specialty: "general_assistant" };
  }
}
