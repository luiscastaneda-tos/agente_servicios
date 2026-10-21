import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import {
  GuardrailsService,
  TravelStateSchema,
  UIPayloadSchema,
} from "../../guardrails/guardrails.service";
import {
  ITransportServiceRepository,
  TransportSearchQuery,
} from "../../repositories/interfaces/repositories.interface";
import { LLMStrategyContext, llmContext } from "../../strategies/llm.context";
import {
  AgentExecutionResult,
  ChatMessageRecord,
  LLMProviderType,
  SessionState,
  TransportOptionItem,
  TransportServiceType,
  TravelState,
  UIPayload,
} from "../../types";

const TransportOptionSchema: z.ZodType<
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
  serviceClass: z.string().optional(),
  vehicleCategory: z.string().optional(),
  highlights: z.array(z.string()).default([]),
  sourceUrl: z.string().optional(),
});

const TransportLLMResponseSchema = z.object({
  answer: z.string().min(1),
  updatedTravelState: TravelStateSchema.optional(),
  options: z.array(TransportOptionSchema).default([]),
  suggestedActions: z.array(z.string()).default([]),
});

const GeneralAssistantLLMResponseSchema = z.object({
  answer: z.string().min(1),
  updatedTravelState: TravelStateSchema.optional(),
  uiPayload: UIPayloadSchema.optional(),
  suggestedActions: z.array(z.string()).default([]),
});

export interface TransportAgentExecuteParams {
  session: SessionState;
  userMessage: string;
  recentHistory: ChatMessageRecord[];
  preferredProvider?: LLMProviderType;
}

export abstract class BaseTransportSpecialistAgent {
  public abstract readonly serviceType: TransportServiceType;
  protected abstract readonly serviceTitle: string;
  protected abstract readonly specialtyInstructions: string;

  constructor(
    protected readonly repository: ITransportServiceRepository,
    protected readonly llm: LLMStrategyContext = llmContext,
    protected readonly guardrails: GuardrailsService = new GuardrailsService()
  ) {}

  public async execute(
    params: TransportAgentExecuteParams
  ): Promise<AgentExecutionResult> {
    const startTime = Date.now();
    const { session, userMessage, recentHistory, preferredProvider } = params;

    // 1. Merge existing session travelState with newly extracted route entities from user message
    const extractedFromMsg = this.extractRouteHints(
      userMessage,
      session.travelState
    );
    const mergedQueryState: TravelState = {
      ...session.travelState,
      ...extractedFromMsg,
      activeService: this.serviceType,
    };

    const searchQuery: TransportSearchQuery = {
      origin: mergedQueryState.origin,
      destination: mergedQueryState.destination,
      date: mergedQueryState.departureDate,
      passengers: mergedQueryState.passengers,
      extraContext: userMessage,
    };

    // 2. Real-time web search via specialized Transport Repository
    const { rawSearchContext, webSources } =
      await this.repository.searchServiceInfo(searchQuery);

    const historyText = recentHistory
      .slice(-4)
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n");

    const systemPrompt = `Eres el Agente Especialista en ${this.serviceTitle} de MIA (Noktos Corporate Travel & Mobility Intelligence).
${this.specialtyInstructions}

REGLAS ESTRICTAS DE NEGOCIO Y GUARDRAILS:
1. PROHIBIDO INVENTAR O MOSTRAR PRECIOS EN VIVO: NO incluyas tarifas monetarias ($ MXN / USD) ni precios dinámicos en tiempo real. Enfócate en operadores reales, rutas, terminales/aeropuertos/puertos/estaciones, duración estimada, frecuencias, categorías de servicio y requisitos.
2. MEMORIA DE ESTADO COMPARTIDA (TravelState): Fusiona el estado de viaje actual de la sesión con cualquier nuevo dato del usuario (origen, destino, fecha, pasajeros). Si el usuario ya había mencionado un origen/destino en mensajes anteriores (ej. "de CDMX a Oaxaca") y ahora pregunta "¿y en ${this.serviceTitle.toLowerCase()}?", mantén ese mismo origen y destino.
3. Responde ÚNICAMENTE con un objeto JSON válido con la siguiente estructura exacta:
{
  "answer": "Explicación clara, ejecutiva y útil en Markdown (SIN precios en vivo)...",
  "updatedTravelState": {
    "activeService": "${this.serviceType}",
    "origin": "Ciudad de origen (si aplica)",
    "destination": "Ciudad de destino (si aplica)",
    "departureDate": "Fecha mencionada (si aplica)",
    "passengers": 1,
    "withDriver": ${this.serviceType === "chauffeur" ? "true" : "false"}
  },
  "options": [
    {
      "provider": "Nombre de la aerolínea / línea de autobús / naviera / arrendadora / ferroviaria",
      "serviceName": "Nombre del servicio o ruta",
      "departurePoint": "Aeropuerto / Terminal / Puerto / Estación de salida",
      "arrivalPoint": "Aeropuerto / Terminal / Puerto / Estación de llegada",
      "estimatedDuration": "Duración estimada ej. 1h 25m o 6h 30m",
      "frequencyOrSchedule": "Frecuencia ej. Salidas cada hora / 3 vuelos diarios",
      "serviceClass": "Clase ej. Ejecutiva, Primera, Turista, Lujo",
      "vehicleCategory": "Categoría de unidad ej. Boeing 737, SUV Ejecutiva, Autobús Doble Piso",
      "highlights": ["Ventaja o requisito 1", "Ventaja o requisito 2"],
      "sourceUrl": "URL de referencia si está disponible"
    }
  ],
  "suggestedActions": [
    "Acción sugerida 1",
    "Acción sugerida 2",
    "Comparar esta misma ruta en otro medio de transporte"
  ]
}`;

    const userPrompt = `Estado de viaje acumulado en la sesión (TravelState actual):
${JSON.stringify(mergedQueryState, null, 2)}

Historial reciente de conversación:
${historyText || "Sin mensajes previos."}

Contexto de búsqueda web en tiempo real:
<contexto_web>
${rawSearchContext}
</contexto_web>

Mensaje actual del usuario: "${userMessage}"

Genera el objeto JSON con las mejores opciones reales de ${this.serviceTitle}.`;

    const llmResult = await this.llm.invokeWithFallback(
      [new SystemMessage(systemPrompt), new HumanMessage(userPrompt)],
      {
        temperature: 0.2,
        maxOutputTokens: 2048,
        preferredProvider,
      }
    );

    const parsed = this.parseTransportOutput(
      llmResult.output,
      mergedQueryState,
      webSources
    );

    const finalTravelState: Partial<TravelState> = {
      ...mergedQueryState,
      ...parsed.updatedTravelState,
      activeService: this.serviceType,
    };

    const routeLabel =
      finalTravelState.origin && finalTravelState.destination
        ? `${finalTravelState.origin} → ${finalTravelState.destination}`
        : finalTravelState.destination ||
          finalTravelState.origin ||
          "Ruta Consultada";

    const uiPayload: UIPayload = {
      type: "transport_options",
      serviceType: this.serviceType,
      title: `${this.serviceTitle}: ${routeLabel}`,
      route: {
        origin: finalTravelState.origin,
        destination: finalTravelState.destination,
        date: finalTravelState.departureDate,
        passengers: finalTravelState.passengers,
      },
      options: parsed.options,
    };

    const latencyMs = Date.now() - startTime;
    const messagesUsed = session.messagesUsed + 1;

    return {
      answer: parsed.answer,
      uiPayload,
      suggestedActions: parsed.suggestedActions,
      updatedTravelState: finalTravelState,
      metadata: {
        sessionId: session.sessionId,
        agentUsed: this.serviceType,
        providerUsed: llmResult.providerUsed,
        modelUsed: llmResult.modelUsed,
        fallbackTriggered: llmResult.fallbackTriggered,
        tokenUsage: llmResult.tokenUsage,
        latencyMs,
        sources: [],
        webSourcesUsed: webSources.map((w) => ({ title: w.title, url: w.url })),
        quota: {
          messagesUsed,
          maxMessages: session.maxMessages,
          messagesRemaining: Math.max(0, session.maxMessages - messagesUsed),
          filesUploaded: session.filesUploaded,
          maxFiles: session.maxFiles,
        },
      },
    };
  }

  protected extractRouteHints(
    message: string,
    currentState: TravelState
  ): Partial<TravelState> {
    const hints: Partial<TravelState> = {};

    // Pattern: "de X a Y" or "desde X hasta/hacia/a Y"
    const routeMatch = message.match(
      /\b(?:de|desde)\s+([A-Za-zÁÉÍÓÚáéíóúÑñ\s]{2,30}?)\s+(?:a|hacia|hasta|para)\s+([A-Za-zÁÉÍÓÚáéíóúÑñ\s]{2,30}?)(?:[,.?¿!]|$|\s+(?:el|en|para|con|mañana|hoy))/i
    );

    if (routeMatch) {
      const candidateOrigin = routeMatch[1].trim();
      const candidateDest = routeMatch[2].trim();
      const stopWords = new Set([
        "ir",
        "viajar",
        "vuelo",
        "vuelos",
        "autobús",
        "autobus",
        "camión",
        "tren",
        "ferry",
        "auto",
        "autos",
        "renta",
        "chofer",
      ]);
      if (!stopWords.has(candidateOrigin.toLowerCase())) {
        hints.origin = candidateOrigin;
      }
      if (!stopWords.has(candidateDest.toLowerCase())) {
        hints.destination = candidateDest;
      }
    } else if (!currentState.destination) {
      const destOnlyMatch = message.match(
        /\b(?:en|hacia|para|a)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑa-záéíóúñ]+){0,2})/
      );
      if (destOnlyMatch && destOnlyMatch[1]) {
        hints.destination = destOnlyMatch[1].trim();
      }
    }

    const paxMatch = message.match(/(\d+)\s*(?:pasajeros?|personas?|adultos?)/i);
    if (paxMatch) {
      hints.passengers = Number(paxMatch[1]);
    }

    return hints;
  }

  private parseTransportOutput(
    rawOutput: string,
    fallbackState: TravelState,
    webSources: Array<{ title: string; url: string; snippet: string }>
  ): {
    answer: string;
    updatedTravelState?: Partial<TravelState>;
    options: TransportOptionItem[];
    suggestedActions: string[];
  } {
    const jsonCandidate = this.guardrails.extractJsonString(rawOutput);
    if (jsonCandidate) {
      try {
        const parsed = JSON.parse(jsonCandidate);
        const validated = TransportLLMResponseSchema.safeParse(parsed);
        if (validated.success) {
          return {
            answer: validated.data.answer,
            updatedTravelState: validated.data.updatedTravelState,
            options: validated.data.options,
            suggestedActions:
              validated.data.suggestedActions.length > 0
                ? validated.data.suggestedActions.slice(0, 4)
                : this.getDefaultSuggestedActions(fallbackState),
          };
        }
      } catch {
        // Fallback below
      }
    }

    const sanitized = this.guardrails.sanitizeAndValidateOutput(rawOutput);
    const fallbackOptions: TransportOptionItem[] =
      sanitized.uiPayload.options && sanitized.uiPayload.options.length > 0
        ? sanitized.uiPayload.options
        : webSources.slice(0, 3).map((src) => ({
            provider: src.title.slice(0, 60),
            serviceName: this.serviceTitle,
            departurePoint: fallbackState.origin || "Origen por definir",
            arrivalPoint: fallbackState.destination || "Destino por definir",
            highlights: [src.snippet.slice(0, 140)],
            sourceUrl: src.url,
          }));

    return {
      answer: sanitized.answer,
      updatedTravelState: sanitized.updatedTravelState || fallbackState,
      options: fallbackOptions,
      suggestedActions: this.getDefaultSuggestedActions(fallbackState),
    };
  }

  private getDefaultSuggestedActions(state: TravelState): string[] {
    const routeSuffix =
      state.origin && state.destination
        ? ` de ${state.origin} a ${state.destination}`
        : "";
    return [
      `Comparar vuelos${routeSuffix}`,
      `Ver opciones en autobús ejecutivo${routeSuffix}`,
      `Consultar renta de auto o chofer privado en destino`,
    ];
  }
}

export class FlightAgent extends BaseTransportSpecialistAgent {
  public readonly serviceType: TransportServiceType = "flight";
  protected readonly serviceTitle = "Vuelos y Aerolíneas";
  protected readonly specialtyInstructions =
    "Especialista en rutas aéreas comerciales, aerolíneas nacionales e internacionales (ej. Aeroméxico, Volaris, Viva Aerobus, Iberia, American Airlines), códigos IATA de aeropuertos de salida y llegada, vuelos directos vs con escala, duración estimada de vuelo y políticas de equipaje.";
}

export class CarRentalAgent extends BaseTransportSpecialistAgent {
  public readonly serviceType: TransportServiceType = "car_rental";
  protected readonly serviceTitle = "Renta de Autos (Sin Chofer)";
  protected readonly specialtyInstructions =
    "Especialista en arrendadoras de vehículos (ej. Hertz, Avis, Enterprise, National, Europcar, Casanova Rent), categorías de flota (Sedán Compacto, SUV Intermedia, Camioneta Familiar, Pick-up), módulos de recolección en aeropuerto o centro, y requisitos de contratación (licencia vigente, tarjeta de crédito para depósito en garantía, coberturas LDW/PLI).";
}

export class ChauffeurAgent extends BaseTransportSpecialistAgent {
  public readonly serviceType: TransportServiceType = "chauffeur";
  protected readonly serviceTitle = "Transporte Ejecutivo con Chofer Privado";
  protected readonly specialtyInstructions =
    "Especialista en renta de vehículos ejecutivos con conductor privado / chofer bilingüe, traslados corporativos punto a punto, servicio por hora o por día completo, camionetas Suburban / SUV blindadas o ejecutivas, Mercedes-Benz Sprinter / Vans para grupos corporativos y protocolos de recepción Meet & Greet en aeropuerto.";
}

export class FerryAgent extends BaseTransportSpecialistAgent {
  public readonly serviceType: TransportServiceType = "ferry";
  protected readonly serviceTitle = "Ferrys y Transbordadores Marítimos";
  protected readonly specialtyInstructions =
    "Especialista en rutas marítimas de pasajeros y carga rodada (ej. Ultramar, Winjet, Xcaret Xailing en el Caribe; Baja Ferries y TMC en el Mar de Cortés), puertos y terminales marítimas de embarque, duración de la travesía, frecuencias y capacidad para pasajeros o vehículos.";
}

export class TrainAgent extends BaseTransportSpecialistAgent {
  public readonly serviceType: TransportServiceType = "train";
  protected readonly serviceTitle = "Trenes de Pasajeros";
  protected readonly specialtyInstructions =
    "Especialista en rutas ferroviarias turísticas, regionales e interurbanas (ej. Tren Maya, Chepe Express, Tren Interurbano El Insurgente, Amtrak, Renfe AVE, Eurostar), estaciones de salida y llegada, clases de servicio (Turista, Ejecutiva, Premier) y tiempos de recorrido.";
}

export class BusAgent extends BaseTransportSpecialistAgent {
  public readonly serviceType: TransportServiceType = "bus";
  protected readonly serviceTitle = "Autobuses Foráneos y Ejecutivos";
  protected readonly specialtyInstructions =
    "Especialista en líneas de autobuses terrestres (ej. ETN Turistar Lujo, ADO Platino / GL, Primera Plus, Estrella Blanca, Futura Select, Ómnibus de México), centrales camioneras específicas (ej. TAPO, Terminal Norte, Observatorio, Sur Taxqueña), clases de servicio (Lujo, Ejecutivo, Primera) y duración aproximada por carretera.";
}

export class GeneralMiaAgent {
  constructor(
    private readonly llm: LLMStrategyContext = llmContext,
    private readonly guardrails: GuardrailsService = new GuardrailsService()
  ) {}

  public async execute(
    params: TransportAgentExecuteParams
  ): Promise<AgentExecutionResult> {
    const startTime = Date.now();
    const { session, userMessage, recentHistory, preferredProvider } = params;

    const historyText = recentHistory
      .slice(-5)
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n");

    const systemPrompt = `Eres MIA, la Asistente Inteligente de Viajes Corporativos e Inteligencia Documental de Noktos.
Tu misión es asistir al usuario con calidez, precisión ejecutiva y estructura clara.

CAPACIDADES DE MIA:
1. Especialistas de Transporte (sin precios en vivo, enfocados en rutas, operadores, horarios, terminales y requisitos):
   - Vuelos (FlightAgent)
   - Renta de Autos sin chofer (CarRentalAgent)
   - Transporte Ejecutivo con Chofer Privado (ChauffeurAgent)
   - Ferrys y Transbordadores (FerryAgent)
   - Trenes de Pasajeros (TrainAgent)
   - Autobuses Ejecutivos (BusAgent)
2. Inteligencia Documental (RAG con Tokenización):
   - Especialista en PDFs (itinerarios, pólizas, reservas, facturas)
   - Analista de Datos CSV (reportes de gastos, tablas comparativas, estadísticas)

Si el usuario menciona un origen, destino, fecha o número de pasajeros, actualízalo en "updatedTravelState".
Responde ÚNICAMENTE con un objeto JSON válido:
{
  "answer": "Respuesta amable, estructurada en Markdown...",
  "updatedTravelState": {
    "origin": "Origen si se mencionó",
    "destination": "Destino si se mencionó"
  },
  "uiPayload": {
    "type": "summary_cards" | "none",
    "title": "Capacidades de MIA Noktos",
    "cards": [
      {
        "label": "Servicio o Recomendación",
        "value": "Detalle",
        "description": "Descripción breve"
      }
    ]
  },
  "suggestedActions": [
    "Buscar vuelos de CDMX a Monterrey",
    "Comparar opciones de autobús o tren",
    "Rentar auto o servicio con chofer",
    "Subir un archivo PDF o CSV para analizar"
  ]
}`;

    const userPrompt = `Estado de viaje actual en la sesión:
${JSON.stringify(session.travelState, null, 2)}

Documentos adjuntos en la sesión (${session.attachedDocuments.length}/${session.maxFiles}):
${
  session.attachedDocuments.length > 0
    ? session.attachedDocuments.map((d) => `- ${d.fileName} (${d.fileType.toUpperCase()})`).join("\n")
    : "Ningún archivo subido aún."
}

Historial reciente:
${historyText || "Inicio de conversación."}

Mensaje del usuario: "${userMessage}"

Responde únicamente con el JSON válido.`;

    const llmResult = await this.llm.invokeWithFallback(
      [new SystemMessage(systemPrompt), new HumanMessage(userPrompt)],
      {
        temperature: 0.3,
        maxOutputTokens: 1500,
        preferredProvider,
      }
    );

    let answer = llmResult.output;
    let uiPayload: UIPayload = { type: "none" };
    let suggestedActions: string[] = [
      "Buscar vuelos de Ciudad de México a Cancún",
      "Consultar autobuses ejecutivos o trenes",
      "Renta de autos o chofer privado ejecutivo",
      "Subir un PDF o CSV para análisis inteligente",
    ];
    let updatedTravelState: Partial<TravelState> | undefined;

    const jsonString = this.guardrails.extractJsonString(llmResult.output);
    if (jsonString) {
      try {
        const parsed = JSON.parse(jsonString);
        const validated = GeneralAssistantLLMResponseSchema.safeParse(parsed);
        if (validated.success) {
          answer = validated.data.answer;
          uiPayload = validated.data.uiPayload || { type: "none" };
          if (validated.data.suggestedActions.length > 0) {
            suggestedActions = validated.data.suggestedActions.slice(0, 4);
          }
          updatedTravelState = validated.data.updatedTravelState;
        }
      } catch {
        const sanitized = this.guardrails.sanitizeAndValidateOutput(
          llmResult.output
        );
        answer = sanitized.answer;
        uiPayload = sanitized.uiPayload;
        suggestedActions = sanitized.suggestedActions;
        updatedTravelState = sanitized.updatedTravelState;
      }
    } else {
      const sanitized = this.guardrails.sanitizeAndValidateOutput(
        llmResult.output
      );
      answer = sanitized.answer;
      uiPayload = sanitized.uiPayload;
      suggestedActions = sanitized.suggestedActions;
      updatedTravelState = sanitized.updatedTravelState;
    }

    const latencyMs = Date.now() - startTime;
    const messagesUsed = session.messagesUsed + 1;

    return {
      answer,
      uiPayload,
      suggestedActions,
      updatedTravelState,
      metadata: {
        sessionId: session.sessionId,
        agentUsed: "general_assistant",
        providerUsed: llmResult.providerUsed,
        modelUsed: llmResult.modelUsed,
        fallbackTriggered: llmResult.fallbackTriggered,
        tokenUsage: llmResult.tokenUsage,
        latencyMs,
        sources: [],
        quota: {
          messagesUsed,
          maxMessages: session.maxMessages,
          messagesRemaining: Math.max(0, session.maxMessages - messagesUsed),
          filesUploaded: session.filesUploaded,
          maxFiles: session.maxFiles,
        },
      },
    };
  }
}
