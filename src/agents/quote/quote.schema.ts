import { z } from "zod";
import {
  HotelQuoteItem,
  QuoteDraft,
  QuoteItem,
  QuoteMissingField,
  QuoteServiceType,
} from "../../types";
import { parseTravelDate } from "../../utils/date-parser";
import { stripPrices } from "../../utils/price-filter";
import { TransportOptionSchema } from "../../guardrails/guardrails.service";

// Opción encontrada por un agente de transporte (mismo shape que TransportOptionSchema)
// más un id propio, generado por nosotros, para que el cliente marque su preferida.
const QuoteFoundOptionSchema = z
  .object({ id: z.string().max(64) })
  .and(TransportOptionSchema);

const withFoundOptions = {
  foundOptions: z.array(QuoteFoundOptionSchema).max(3).optional(),
  preferredOptionId: z.string().max(64).nullable().optional(),
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HOUR = /^([01]?\d|2[0-3]):[0-5]\d$/;

// Límites del esquema de bacl (bacl/api/modules/cotizacionesIa/cotizacionesIa.schema.js):
// el borrador se recorta a ellos para que "Confirmar" nunca falle con un 400 por longitud.
export const MAX_QUOTE_ITEMS = 20;
const MAX_NOTES_ITEM = 1000;
const MAX_NOTES_DRAFT = 2000;

// Texto libre del modelo: sin montos, sin espacios sobrantes y recortado a `max`.
const textMax = (max: number) =>
  z
    .string()
    .transform((v) => stripPrices(v).trim().slice(0, max).trim())
    .optional();

// Fecha ISO; si el modelo mandó otra forma ("10 de noviembre") se intenta resolver, si no se descarta.
const isoDate = z
  .string()
  .transform((v): string | undefined => {
    const raw = v.trim();
    if (ISO_DATE.test(raw)) return raw;
    const parsed = parseTravelDate(raw);
    return parsed ? parsed.iso : undefined;
  })
  .optional();

const hour = z
  .string()
  .transform((v): string | undefined => {
    const raw = v.trim();
    if (!HOUR.test(raw)) return undefined;
    const [h, m] = raw.split(":");
    return `${h.padStart(2, "0")}:${m}`;
  })
  .optional();

// Entero positivo acotado a `max` (bacl rechaza valores mayores).
const countMax = (max: number) =>
  z
    .union([z.number(), z.string()])
    .transform((v): number | undefined => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) && n > 0 ? Math.min(n, max) : undefined;
    })
    .optional();

const base = {
  id: z.string().transform((v) => v.slice(0, 64)).optional(),
  travelers: countMax(100),
  travelerNames: z
    .array(z.string())
    .transform((arr) =>
      arr
        .map((n) => n.trim().slice(0, 120).trim())
        .filter(Boolean)
        .slice(0, 100)
    )
    .optional(),
  notes: textMax(MAX_NOTES_ITEM),
};

const FlightSchema = z.object({
  ...base,
  type: z.literal("flight"),
  tripType: z.enum(["oneway", "roundtrip", "multicity"]).optional().catch(undefined),
  origin: textMax(120),
  destination: textMax(120),
  departureDate: isoDate,
  returnDate: isoDate,
  airline: textMax(80),
  cabin: textMax(40),
  flightNumber: textMax(20),
  ...withFoundOptions,
});

const CarRentalSchema = z.object({
  ...base,
  type: z.literal("car_rental"),
  pickupLocation: textMax(160),
  dropoffLocation: textMax(160),
  pickupDate: isoDate,
  dropoffDate: isoDate,
  pickupTime: hour,
  dropoffTime: hour,
  carCategory: textMax(80),
  withDriver: z.boolean().optional().catch(undefined),
  ...withFoundOptions,
});

// Opción de hotel encontrada por el microservicio interno de búsqueda (no reutiliza
// TransportOptionSchema: sus campos de transporte no aplican a hotel).
const HotelFoundOptionSchema = z.object({
  id: z.string().max(64),
  hotelName: textMax(160),
  city: textMax(120),
  address: textMax(200),
  rating: z.number().optional(),
  roomVariants: z
    .array(
      z.object({
        roomType: textMax(80),
        boardDescription: textMax(120),
      })
    )
    .max(3)
    .optional(),
  cancellationNote: textMax(80),
  thumbnailUrl: textMax(500),
});

const HotelRoomSchema = z.object({
  roomType: textMax(80),
  leadGuest: textMax(120),
  additionalGuests: z.array(z.string().trim().max(120)).max(20).optional(),
});

const HotelSchema = z.object({
  ...base,
  type: z.literal("hotel"),
  city: textMax(120),
  hotelName: textMax(160),
  checkIn: isoDate,
  checkOut: isoDate,
  rooms: z.array(HotelRoomSchema).max(50).optional(),
  foundOptions: z.array(HotelFoundOptionSchema).max(3).optional(),
  preferredOptionId: z.string().max(64).nullable().optional(),
});

const BusSchema = z.object({
  ...base,
  type: z.literal("bus"),
  origin: textMax(120),
  destination: textMax(120),
  departureDate: isoDate,
  returnDate: isoDate,
  busLine: textMax(80),
  serviceClass: textMax(60),
  ...withFoundOptions,
});

// z.object descarta las claves desconocidas, así que cualquier "precio"/"total" que
// mande el modelo no llega al borrador.
export const QuoteItemSchema = z.discriminatedUnion("type", [
  FlightSchema,
  CarRentalSchema,
  HotelSchema,
  BusSchema,
]);

export const QuoteLLMResponseSchema = z.object({
  answer: z.string().default(""),
  resumen: textMax(MAX_NOTES_DRAFT),
  notas: textMax(MAX_NOTES_DRAFT),
  // Cada ítem se valida por separado para no perder todo el borrador por uno malo.
  items: z.array(z.unknown()).default([]),
  suggestedActions: z.array(z.string()).default([]),
});

// Campos sin los cuales Operaciones no puede cotizar (el front bloquea "Confirmar").
const REQUIRED_FIELDS: Record<
  QuoteServiceType,
  Array<{ field: string; label: string; anyOf?: string[] }>
> = {
  flight: [
    { field: "origin", label: "Origen" },
    { field: "destination", label: "Destino" },
    { field: "departureDate", label: "Fecha de salida" },
  ],
  car_rental: [
    { field: "pickupLocation", label: "Lugar de recogida" },
    { field: "pickupDate", label: "Fecha de recogida" },
    { field: "dropoffDate", label: "Fecha de devolución" },
  ],
  hotel: [
    { field: "city", label: "Ciudad u hotel", anyOf: ["city", "hotelName"] },
    { field: "checkIn", label: "Fecha de entrada" },
    { field: "checkOut", label: "Fecha de salida" },
  ],
  bus: [
    { field: "origin", label: "Origen" },
    { field: "destination", label: "Destino" },
    { field: "departureDate", label: "Fecha de salida" },
  ],
};

export const SERVICE_LABELS: Record<QuoteServiceType, string> = {
  flight: "Vuelo",
  car_rental: "Renta de auto",
  hotel: "Hotel",
  bus: "Autobús",
};

const hasValue = (value: unknown): boolean =>
  value !== undefined && value !== null && String(value).trim() !== "";

export function computeMissingFields(items: QuoteItem[]): QuoteMissingField[] {
  const missing: QuoteMissingField[] = [];
  for (const item of items) {
    for (const rule of REQUIRED_FIELDS[item.type]) {
      const keys = rule.anyOf ?? [rule.field];
      const record = item as unknown as Record<string, unknown>;
      if (!keys.some((k) => hasValue(record[k]))) {
        missing.push({ itemId: item.id, field: rule.field, label: rule.label });
      }
    }
    // "Requerido" para hotel incluye: al menos 1 habitación, y cada habitación
    // con roomType y leadGuest llenos. REQUIRED_FIELDS no puede expresar esto
    // (es por-escalar, no por-elemento de un arreglo), así que se verifica aparte.
    if (item.type === "hotel") {
      const rooms = (item as HotelQuoteItem).rooms ?? [];
      const incomplete =
        rooms.length === 0 ||
        rooms.some((r) => !hasValue(r.roomType) || !hasValue(r.leadGuest));
      if (incomplete) {
        missing.push({ itemId: item.id, field: "rooms", label: "Habitaciones" });
      }
    }
  }
  return missing;
}

// Pares [inicio, fin]: bacl rechaza fin < inicio. Si el modelo (o una edición) los deja
// al revés, se quita la fecha de fin y se avisa; si era obligatoria, computeMissingFields
// la volverá a pedir.
const DATE_PAIRS: Record<QuoteServiceType, Array<[string, string, string]>> = {
  flight: [["departureDate", "returnDate", "regreso"]],
  car_rental: [["pickupDate", "dropoffDate", "devolución"]],
  hotel: [["checkIn", "checkOut", "salida"]],
  bus: [["departureDate", "returnDate", "regreso"]],
};

export function fixDateOrder<T extends QuoteItem>(
  item: T
): { item: T; warnings: string[] } {
  const record = { ...(item as unknown as Record<string, unknown>) };
  const warnings: string[] = [];
  for (const [from, to, label] of DATE_PAIRS[item.type]) {
    const start = record[from];
    const end = record[to];
    if (typeof start === "string" && typeof end === "string" && end < start) {
      delete record[to];
      warnings.push(label);
    }
  }
  return { item: record as unknown as T, warnings };
}

// Quita las claves vacías para que el borrador viaje limpio.
export function compactItem<T extends QuoteItem>(item: T): T {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    // El loop genérico de arriba no mira dentro de los objetos de un arreglo:
    // sin este filtro, una habitación vacía ({}) sobreviviría dentro de `rooms`.
    if (key === "rooms" && Array.isArray(value)) {
      const rooms = (value as Array<Record<string, unknown>>).filter(
        (r) => hasValue(r?.roomType) || hasValue(r?.leadGuest)
      );
      if (rooms.length === 0) continue;
      clean[key] = rooms;
      continue;
    }
    clean[key] = value;
  }
  return clean as unknown as T;
}

// Validación laxa del currentDraft que manda el front (puede venir editado a mano).
export const QuoteDraftInputSchema = z.object({
  resumen: z.string().optional(),
  items: z.array(z.unknown()).default([]),
  notes: z.string().optional(),
  files: z
    .array(
      z.object({
        fileName: z.string(),
        mimeType: z.string().default("application/octet-stream"),
        sizeBytes: z.number().default(0),
        storagePath: z.string().nullable().default(null),
        uploadError: z.string().optional(),
      })
    )
    .default([]),
});

export type QuoteDraftInput = z.infer<typeof QuoteDraftInputSchema>;
export type { QuoteDraft };
