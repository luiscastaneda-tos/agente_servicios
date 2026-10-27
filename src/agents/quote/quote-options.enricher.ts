import {
  BusAgent,
  CarRentalAgent,
  FlightAgent,
} from "../transport/transport-specialist.agents";
import {
  BusQuoteItem,
  CarRentalQuoteItem,
  FlightQuoteItem,
  LLMProviderType,
  QuoteFoundOption,
  QuoteItem,
  SessionState,
  TravelState,
} from "../../types";

export interface QuoteOptionsAgents {
  flightAgent: FlightAgent;
  carRentalAgent: CarRentalAgent;
  busAgent: BusAgent;
}

// Únicos tipos de ítem para los que hoy existe un agente de búsqueda de transporte.
type TransportQuoteItem = FlightQuoteItem | CarRentalQuoteItem | BusQuoteItem;

const MAX_OPTIONS_PER_ITEM = 3;
const SEARCH_TIMEOUT_MS = 12000;

function isTransportType(item: QuoteItem): item is TransportQuoteItem {
  return item.type === "flight" || item.type === "car_rental" || item.type === "bus";
}

// Ítems que todavía no tienen foundOptions y traen suficiente info para buscar.
function isEligible(item: QuoteItem): item is TransportQuoteItem {
  if (!isTransportType(item)) return false;
  if (item.foundOptions !== undefined) return false;
  switch (item.type) {
    case "flight":
    case "bus":
      return Boolean(item.origin && item.destination);
    case "car_rental":
      return Boolean(item.pickupLocation);
  }
}

function agentFor(
  item: TransportQuoteItem,
  agents: QuoteOptionsAgents
): FlightAgent | CarRentalAgent | BusAgent {
  switch (item.type) {
    case "flight":
      return agents.flightAgent;
    case "car_rental":
      return agents.carRentalAgent;
    case "bus":
      return agents.busAgent;
  }
}

// El agente de transporte necesita origin/destination/departureDate ya resueltos en
// travelState: así busca directo con los datos del ítem, sin re-parsear lenguaje natural.
function seedTravelStateFor(item: TransportQuoteItem): TravelState {
  switch (item.type) {
    case "flight":
    case "bus":
      return {
        activeService: item.type,
        origin: item.origin,
        destination: item.destination,
        departureDate: item.departureDate,
      };
    case "car_rental":
      return {
        activeService: item.type,
        destination: item.pickupLocation,
        departureDate: item.pickupDate,
      };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout de ${ms}ms excedido`)),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// Busca opciones reales (sin precio) para los ítems de flight/car_rental/bus que todavía
// no las tengan, reutilizando los agentes de transporte ya existentes (no reinventa la
// búsqueda ni la estructuración). Nunca lanza: si algo falla, el ítem simplemente se queda
// sin foundOptions.
export async function enrichWithFoundOptions(
  items: QuoteItem[],
  agents: QuoteOptionsAgents,
  session: SessionState,
  preferredProvider?: LLMProviderType
): Promise<QuoteItem[]> {
  const eligible = items.filter(isEligible);
  if (eligible.length === 0) return items;

  const settled = await Promise.allSettled(
    eligible.map((item) => {
      const agent = agentFor(item, agents);
      return withTimeout(
        agent.execute({
          session: { ...session, travelState: seedTravelStateFor(item) },
          userMessage: "Buscar opciones disponibles para este servicio.",
          recentHistory: [],
          preferredProvider,
        }),
        SEARCH_TIMEOUT_MS
      );
    })
  );

  const foundById = new Map<string, QuoteFoundOption[]>();
  eligible.forEach((item, idx) => {
    const result = settled[idx];
    if (result.status !== "fulfilled") return;
    const { uiPayload } = result.value;
    if (uiPayload.type !== "transport_options" || !uiPayload.options?.length) {
      return;
    }
    const options: QuoteFoundOption[] = uiPayload.options
      .slice(0, MAX_OPTIONS_PER_ITEM)
      .map((opt, i) => ({ ...opt, id: `${item.id}-opt-${i + 1}` }));
    foundById.set(item.id, options);
  });

  if (foundById.size === 0) return items;

  return items.map((item) => {
    const foundOptions = foundById.get(item.id);
    if (!foundOptions) return item;
    return { ...item, foundOptions, preferredOptionId: null } as QuoteItem;
  });
}
