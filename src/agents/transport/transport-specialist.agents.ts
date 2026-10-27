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
import { env } from "../../config/env";
import {
  formatDateEs,
  isPastDate,
  parseTravelDate,
} from "../../utils/date-parser";
import { dropNulls, parseLenientJson, stripPrices, stripPricesFromList } from "../../utils/price-filter";
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
  departureTimes: z.array(z.string()).default([]),
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
  // Si es true, el agente no busca opciones hasta tener fecha exacta de viaje.
  protected readonly requiresExactDate: boolean = false;

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

    let dateLabel: string | undefined;
    if (this.requiresExactDate) {
      const parsedDate = parseTravelDate(userMessage);
      if (parsedDate?.status === "ok") {
        mergedQueryState.departureDate = parsedDate.iso;
      } else if (
        mergedQueryState.departureDate &&
        isPastDate(mergedQueryState.departureDate)
      ) {
        // La fecha guardada de una sesión vieja ya no sirve
        mergedQueryState.departureDate = undefined;
      }

      const missingPlaces = !mergedQueryState.origin || !mergedQueryState.destination;
      if (parsedDate?.status === "past" || !mergedQueryState.departureDate || missingPlaces) {
        return this.buildClarificationResult({
          session,
          state: mergedQueryState,
          pastDateIso: parsedDate?.status === "past" ? parsedDate.iso : undefined,
          startTime,
        });
      }
      dateLabel = formatDateEs(mergedQueryState.departureDate);
    }

    const searchQuery: TransportSearchQuery = {
      origin: mergedQueryState.origin,
      destination: mergedQueryState.destination,
      date: dateLabel ?? mergedQueryState.departureDate,
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
1. PROHIBIDO MENCIONAR PRECIOS: NO incluyas tarifas, costos ni montos ($ MXN / USD / "pesos") en ninguna parte, aunque aparezcan en el contexto web. Enfócate en operadores reales (marca), rutas, terminales/aeropuertos/puertos/estaciones, horarios de salida, duración estimada, frecuencias, categorías de servicio y requisitos.
1b. NO INVENTES HORARIOS: usa en "departureTimes" únicamente horas que aparezcan en el contexto web (formato 24h, ej. "07:30"). Si no hay horarios confiables, deja "departureTimes" como [] y describe la frecuencia general en "frequencyOrSchedule" solo si el contexto la respalda; si no, omítela. Nunca rellenes con horas supuestas.
1c. "answer" es texto Markdown breve y directo (máx. ~120 palabras) para leer en un chat: NO incluyas JSON, bloques de código ni la lista completa de opciones (ya se muestra en tarjetas).
2. MEMORIA DE ESTADO COMPARTIDA (TravelState): Fusiona el estado de viaje actual de la sesión con cualquier nuevo dato del usuario (origen, destino, fecha, pasajeros). Si el usuario ya había mencionado un origen/destino en mensajes anteriores (ej. "de CDMX a Oaxaca") y ahora pregunta "¿y en ${this.serviceTitle.toLowerCase()}?", mantén ese mismo origen y destino.
${
  dateLabel
    ? `2b. FECHA DE VIAJE: el usuario viaja el ${dateLabel} (${mergedQueryState.departureDate}). Menciona esta fecha exacta en "answer" y usa "${mergedQueryState.departureDate}" en updatedTravelState.departureDate. Los horarios y la frecuencia son información de REFERENCIA GENERAL de la ruta: NO afirmes disponibilidad, asientos ni horarios exactos para esa fecha, e indica que deben confirmarse para ${dateLabel} en la terminal o el sitio oficial.\n`
    : ""
}3. Responde ÚNICAMENTE con un objeto JSON válido con la siguiente estructura exacta:
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
      "frequencyOrSchedule": "Frecuencia ej. Salidas cada hora / 3 vuelos diarios (solo si el contexto lo respalda)",
      "departureTimes": ["07:00", "08:30"],
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

${dateLabel ? `Fecha de viaje solicitada: ${dateLabel}.\n` : ""}Genera el objeto JSON con las mejores opciones reales de ${this.serviceTitle}.`;

    const llmResult = await this.llm.invokeWithFallback(
      [new SystemMessage(systemPrompt), new HumanMessage(userPrompt)],
      {
        temperature: 0.2,
        // Gemini 2.5 consume parte de este límite "pensando"; con 2048 el JSON llegaba cortado.
        maxOutputTokens: 8192,
        preferredProvider,
      }
    );

    const parsed = this.parseTransportOutput(
      llmResult.output,
      mergedQueryState,
      webSources
    );
    parsed.answer = stripPrices(parsed.answer);
    parsed.options = parsed.options.map((opt) => ({
      ...opt,
      highlights: stripPricesFromList(opt.highlights),
      frequencyOrSchedule: opt.frequencyOrSchedule
        ? stripPrices(opt.frequencyOrSchedule)
        : undefined,
    }));

    const finalTravelState: Partial<TravelState> = {
      ...mergedQueryState,
      ...parsed.updatedTravelState,
      activeService: this.serviceType,
    };

    if (dateLabel && mergedQueryState.departureDate) {
      // El LLM no decide la fecha: se queda la que entendió el parser.
      finalTravelState.departureDate = mergedQueryState.departureDate;
      if (!parsed.answer.toLowerCase().includes(dateLabel.toLowerCase())) {
        parsed.answer = `Viaje para el **${dateLabel}**.\n\n${parsed.answer}`;
      }
    }

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

  // Respuesta sin búsqueda web ni LLM: pide lo que falta para poder cotizar.
  private buildClarificationResult(params: {
    session: SessionState;
    state: TravelState;
    pastDateIso?: string;
    startTime: number;
  }): AgentExecutionResult {
    const { session, state, pastDateIso, startTime } = params;
    const route =
      state.origin && state.destination
        ? `de ${state.origin} a ${state.destination}`
        : "";

    const missing: string[] = [];
    if (!state.origin) missing.push("de dónde sales");
    if (!state.destination) missing.push("a dónde viajas");

    let answer: string;
    if (pastDateIso) {
      answer = `Esa fecha (${formatDateEs(pastDateIso)}) ya pasó. ¿Me indicas una fecha futura para tu viaje${route ? ` ${route}` : ""}?`;
    } else if (missing.length > 0) {
      answer = `Con gusto te ayudo con ${this.serviceTitle.toLowerCase()}. Para cotizar necesito saber ${missing.join(" y ")}, y la **fecha exacta** en la que quieres viajar. Si viajas más de una persona, dime cuántas.`;
    } else {
      answer = `Perfecto, ${this.serviceTitle.toLowerCase()} ${route}. ¿Para qué **fecha exacta** quieres viajar? Si son varias personas, dime cuántas.`;
    }

    const messagesUsed = session.messagesUsed + 1;
    return {
      answer,
      uiPayload: { type: "none" },
      suggestedActions: ["Mañana", "El próximo viernes", "Ida y vuelta"],
      updatedTravelState: {
        ...state,
        activeService: this.serviceType,
      },
      metadata: {
        sessionId: session.sessionId,
        agentUsed: this.serviceType,
        providerUsed: env.defaultProvider,
        modelUsed: "sin-llm",
        fallbackTriggered: false,
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        latencyMs: Date.now() - startTime,
        sources: [],
        webSourcesUsed: [],
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

    const stopWords = new Set([
      "ir", "viajar", "vuelo", "vuelos", "autobús", "autobus", "autobuses",
      "camión", "camion", "camiones", "tren", "trenes", "ferry", "ferrys",
      "auto", "autos", "renta", "chofer", "boleto", "boletos", "transporte",
      "viaje", "viajes", "corridas", "horarios",
    ]);
    const cityRe = "([A-Za-zÁÉÍÓÚáéíóúÑñ.]+(?:\\s+[A-Za-zÁÉÍÓÚáéíóúÑñ.]+){0,3}?)";
    const tail = "(?=\\s*(?:[,.?¿!]|$|\\s(?:el|en|con|mañana|hoy|para|que|por|\\d)))";
    const patterns: Array<{ re: RegExp; originIdx: number; destIdx: number }> = [
      // "para/a/hacia X desde Y"
      { re: new RegExp(`\\b(?:a|hacia|hasta|para)\\s+${cityRe}\\s+desde\\s+${cityRe}${tail}`, "i"), originIdx: 2, destIdx: 1 },
      // "desde Y a/hacia/hasta/para X"
      { re: new RegExp(`\\bdesde\\s+${cityRe}\\s+(?:a|hacia|hasta|para)\\s+${cityRe}${tail}`, "i"), originIdx: 1, destIdx: 2 },
      // "de Y a/hacia/hasta X"
      { re: new RegExp(`\\bde\\s+${cityRe}\\s+(?:a|hacia|hasta)\\s+${cityRe}${tail}`, "i"), originIdx: 1, destIdx: 2 },
    ];

    let routeFound = false;
    for (const { re, originIdx, destIdx } of patterns) {
      const m = message.match(re);
      if (!m) continue;
      const origin = m[originIdx].trim();
      const destination = m[destIdx].trim();
      if (stopWords.has(origin.toLowerCase()) || stopWords.has(destination.toLowerCase())) {
        continue;
      }
      hints.origin = this.normalizeCity(origin);
      hints.destination = this.normalizeCity(destination);
      routeFound = true;
      break;
    }

    if (!routeFound && !currentState.destination) {
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

  private normalizeCity(city: string): string {
    const aliases: Record<string, string> = {
      cdmx: "Ciudad de México",
      df: "Ciudad de México",
      "d.f.": "Ciudad de México",
      "mexico city": "Ciudad de México",
      gdl: "Guadalajara",
      mty: "Monterrey",
    };
    const key = city.trim().toLowerCase();
    if (aliases[key]) return aliases[key];
    return city.charAt(0).toUpperCase() + city.slice(1);
  }

  // Si el modelo se cortó a mitad del JSON, recupera al menos el texto de "answer".
  private salvageAnswer(raw: string): string | null {
    const m = raw.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (!m || !m[1]) return null;
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\$/, "");
    }
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
        const parsed = dropNulls(parseLenientJson(jsonCandidate));
        const validated = TransportLLMResponseSchema.safeParse(parsed);
        if (!validated.success) {
          console.warn(
            `[${this.serviceType}] Respuesta del LLM no cumple el esquema:`,
            JSON.stringify(validated.error.issues.slice(0, 5))
          );
        }
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
      } catch (err) {
        console.warn(
          `[${this.serviceType}] JSON del LLM inválido: ${(err as Error).message}. Inicio: ${jsonCandidate.slice(0, 200)}`
        );
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

    const looksLikeJson = /```json|^\s*\{/.test(rawOutput);
    const answer =
      this.salvageAnswer(rawOutput) ??
      (looksLikeJson
        ? "Encontré información de la ruta pero no pude estructurarla completa. Intenta de nuevo en un momento o consulta las fuentes de abajo."
        : sanitized.answer);

    return {
      answer,
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
  protected readonly requiresExactDate = true;
  protected readonly serviceTitle = "Autobuses Foráneos y Ejecutivos";
  protected readonly specialtyInstructions =
    "Especialista en líneas de autobuses terrestres (ej. ETN Turistar Lujo, ADO Platino / GL, Primera Plus, Estrella Blanca, Futura Select, Ómnibus de México), centrales camioneras específicas (ej. TAPO, Terminal Norte, Observatorio, Sur Taxqueña), clases de servicio (Lujo, Ejecutivo, Primera) y duración aproximada por carretera. Para CADA opción indica la MARCA/línea en \"provider\" (ej. ADO, ETN, Pullman de Morelos, Estrella Roja, Primera Plus), la terminal de salida y llegada, la clase de servicio y, solo si aparecen en el contexto web, los horarios de salida en \"departureTimes\". Si no hay horarios confiables, entrega igualmente la marca, terminal y clase, y recomienda confirmar corridas en la terminal o sitio oficial. Entrega entre 3 y 6 opciones distintas, una por marca.";
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
