import axios from "axios";
import { env } from "../config/env";
import { HotelFoundOption } from "../types/index";

// Forma mínima del contrato del microservicio interno de hoteles que de verdad usamos
// (solo lectura: /locations/search y /hotels/search). No se importa su paquete ni se
// expone su nombre fuera de este archivo.
interface LocationSearchItem {
  destinationId: string;
  city?: string;
  state?: string;
  country?: string;
  label?: string;
}

interface HotelRoomRateResponse {
  roomSequence: number;
  roomType: string;
  boardCode: string;
  boardDescription: string;
}

interface HotelCancellationPolicyResponse {
  refundable: boolean;
  deadline?: string;
}

interface HotelRateResponse {
  tripProductId: string;
  rateClass: string;
  amount: number;
  currency: string;
  roomRates: HotelRoomRateResponse[];
  cancellationPolicy: HotelCancellationPolicyResponse;
  bookable: boolean;
}

interface HotelAddressResponse {
  street?: string;
  city?: string;
  postalCode?: string;
  countryCode?: string;
}

interface HotelItemResponse {
  hotelCode: string;
  hotelName: string;
  rating: number;
  address: HotelAddressResponse;
  hotelDetailId?: string;
  rates: HotelRateResponse[];
}

interface HotelSearchResponse {
  hotels: HotelItemResponse[];
}

export interface HotelSearchQuery {
  city: string;
  checkIn: string;
  checkOut: string;
  rooms?: number;
  guests?: number;
}

// Tipos de habitación que se consultan para armar las variantes informativas (single/
// doble/triple). La doble sigue siendo la base: determina el set de hoteles mostrado,
// igual que antes de esta funcionalidad, para no cambiar cuáles hoteles se ven.
const ROOM_TYPE_SGL = "NMO.HTL.RMT.SGL";
const ROOM_TYPE_DBL = "NMO.HTL.RMT.DBL";
const ROOM_TYPE_TPL = "NMO.HTL.RMT.TPL";

// Capacidad (adultos) de cada tipo de habitación, usada únicamente para armar la búsqueda
// de variantes — no refleja la cantidad real de huéspedes/habitaciones que pidió el
// cliente (eso se ignora aquí a propósito: son previsualizaciones de qué tipos de cuarto
// existen en el hotel, no una reserva literal de su grupo).
const ROOM_TYPE_CAPACITY: Record<string, number> = {
  [ROOM_TYPE_SGL]: 1,
  [ROOM_TYPE_DBL]: 2,
  [ROOM_TYPE_TPL]: 3,
};

const MAX_OPTIONS = 3;
const MAX_ROOM_VARIANTS = 3;
// Antes había una sola llamada a /hotels/search con timeout de 8s. Ahora se disparan 3
// llamadas en paralelo (una por tipo de habitación) con Promise.allSettled, así que el
// tiempo total de espera sigue siendo ~el de la más lenta, no la suma de las 3. Se baja
// el timeout por llamada a 6s para no triplicar el peor caso de espera del usuario.
const REQUEST_TIMEOUT_MS = 6000;
const LOCATION_TIMEOUT_MS = 8000;

export class HotelServiceRepository {
  private readonly baseUrl = env.hotelServiceUrl;

  // No atrapa errores internamente: el caller (enrichHotelOptions) decide qué hacer si
  // falla, igual que el resto de repositorios de este codebase.
  public async searchHotels(
    itemId: string,
    query: HotelSearchQuery
  ): Promise<HotelFoundOption[]> {
    const destinationId = await this.resolveDestinationId(query.city);
    if (!destinationId) return [];

    const [sglResult, dblResult, tplResult] = await Promise.allSettled([
      this.searchByRoomType(destinationId, query, ROOM_TYPE_SGL),
      this.searchByRoomType(destinationId, query, ROOM_TYPE_DBL),
      this.searchByRoomType(destinationId, query, ROOM_TYPE_TPL),
    ]);

    // La doble es la base: mismo comportamiento que antes de esta funcionalidad (si falla,
    // no hay hoteles que mostrar; el caller decide qué hacer con el throw/rechazo).
    if (dblResult.status === "rejected") throw dblResult.reason;
    const baseHotels = dblResult.value?.hotels ?? [];

    const sglHotels = sglResult.status === "fulfilled" ? sglResult.value?.hotels ?? [] : [];
    const tplHotels = tplResult.status === "fulfilled" ? tplResult.value?.hotels ?? [] : [];
    const sglByCode = this.indexByHotelCode(sglHotels);
    const tplByCode = this.indexByHotelCode(tplHotels);

    return baseHotels
      .slice(0, MAX_OPTIONS)
      .map((hotel, i) =>
        this.toFoundOption(itemId, hotel, i + 1, sglByCode, tplByCode)
      );
  }

  private indexByHotelCode(
    hotels: HotelItemResponse[]
  ): Map<string, HotelItemResponse> {
    const map = new Map<string, HotelItemResponse>();
    for (const hotel of hotels) {
      if (hotel.hotelCode) map.set(hotel.hotelCode, hotel);
    }
    return map;
  }

  private async searchByRoomType(
    destinationId: string,
    query: HotelSearchQuery,
    roomType: string
  ): Promise<HotelSearchResponse> {
    const { rooms, passengers } = this.buildOccupancy(roomType);

    const response = await axios.post<HotelSearchResponse>(
      `${this.baseUrl}/hotels/search`,
      {
        destinationId,
        checkIn: query.checkIn,
        checkOut: query.checkOut,
        rooms,
        passengers,
      },
      { params: { provider: "nemo" }, timeout: REQUEST_TIMEOUT_MS }
    );

    return response.data;
  }

  private async resolveDestinationId(
    city: string
  ): Promise<string | undefined> {
    // "q" es sensible a acentos: se manda la ciudad tal cual la extrajo el LLM.
    const response = await axios.get<LocationSearchItem[]>(
      `${this.baseUrl}/locations/search`,
      { params: { q: city, limit: 1 }, timeout: LOCATION_TIMEOUT_MS }
    );
    return response.data?.[0]?.destinationId;
  }

  // Una habitación, con la cantidad de adultos que corresponde a la capacidad de
  // `roomType` (SGL→1, DBL→2, TPL→3). Esto es independiente de rooms/guests que haya
  // pedido el cliente: son previsualizaciones de variantes de cuarto, no su reserva real.
  private buildOccupancy(roomType: string): {
    rooms: Array<{ roomSequence: number; roomType: string }>;
    passengers: Array<{ ageType: "ADT"; roomSequence: number }>;
  } {
    const capacity = ROOM_TYPE_CAPACITY[roomType] ?? 1;

    const rooms = [{ roomSequence: 1, roomType }];

    const passengers = Array.from({ length: capacity }, () => ({
      ageType: "ADT" as const,
      roomSequence: 1,
    }));

    return { rooms, passengers };
  }

  // Nunca copia amount/currency/tripProductId/hotelCode a un campo visible para el cliente.
  private toFoundOption(
    itemId: string,
    hotel: HotelItemResponse,
    index: number,
    sglByCode: Map<string, HotelItemResponse>,
    tplByCode: Map<string, HotelItemResponse>
  ): HotelFoundOption {
    const bestRate = hotel.rates?.[0];

    // Cuando el hotel solo tiene una tarifa real cargada, buscar por SGL o por DBL
    // devuelve la misma habitación (cabe en ambas capacidades) -- se deduplica por
    // contenido para no mostrar la misma variante dos veces.
    const seen = new Set<string>();
    const roomVariants = [
      this.extractVariant(hotel),
      this.extractVariant(sglByCode.get(hotel.hotelCode)),
      this.extractVariant(tplByCode.get(hotel.hotelCode)),
    ]
      .filter((v): v is { roomType: string; boardDescription: string } => v !== undefined)
      .filter((v) => {
        const key = `${v.roomType}|${v.boardDescription}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, MAX_ROOM_VARIANTS);

    return {
      id: `${itemId}-opt-${index}`,
      hotelName: hotel.hotelName,
      city: hotel.address?.city,
      address: hotel.address?.street,
      rating: hotel.rating,
      roomVariants: roomVariants.length > 0 ? roomVariants : undefined,
      cancellationNote: this.buildCancellationNote(bestRate?.cancellationPolicy),
    };
  }

  // Primer rate, primera habitación de ese hotel — mismo criterio que antes de esta
  // funcionalidad para elegir qué rate representa al hotel. Falta de variante (hotel no
  // encontrado en esa búsqueda, o sin rates) es esperado y no un error.
  private extractVariant(
    hotel: HotelItemResponse | undefined
  ): { roomType: string; boardDescription: string } | undefined {
    const roomRate = hotel?.rates?.[0]?.roomRates?.[0];
    if (!roomRate) return undefined;
    return {
      roomType: roomRate.roomType,
      boardDescription: roomRate.boardDescription,
    };
  }

  private buildCancellationNote(
    policy?: HotelCancellationPolicyResponse
  ): string | undefined {
    if (!policy) return undefined;
    return policy.refundable ? "Cancelación gratuita" : "Tarifa no reembolsable";
  }
}
