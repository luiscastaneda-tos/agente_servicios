// Parser de fechas de viaje en español. Trabaja con strings ISO (YYYY-MM-DD) y
// aritmética UTC para que el resultado no dependa de la zona del servidor.
const TIME_ZONE = "America/Mexico_City";

const MONTHS: Record<string, number> = {
  enero: 1, ene: 1,
  febrero: 2, feb: 2,
  marzo: 3, mar: 3,
  abril: 4, abr: 4,
  mayo: 5, may: 5,
  junio: 6, jun: 6,
  julio: 7, jul: 7,
  agosto: 8, ago: 8,
  septiembre: 9, setiembre: 9, sep: 9, sept: 9,
  octubre: 10, oct: 10,
  noviembre: 11, nov: 11,
  diciembre: 12, dic: 12,
};

// Índice = Date.getUTCDay() (0 = domingo)
const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTH_NAMES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

// Una fecha sin año que cayó hace menos de esto se considera "ya pasó" (probable
// error del usuario); más antigua se interpreta como del año siguiente.
const RECENT_PAST_DAYS = 31;

export type ParsedTravelDate =
  | { status: "ok"; iso: string }
  | { status: "past"; iso: string };

const pad = (n: number): string => String(n).padStart(2, "0");
const toIso = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`;

const isoToUtc = (iso: string): Date => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

const utcToIso = (date: Date): string =>
  toIso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());

const addDays = (iso: string, days: number): string => {
  const date = isoToUtc(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return utcToIso(date);
};

const isValidDate = (y: number, m: number, d: number): boolean => {
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
};

export function todayIso(now: Date = new Date()): string {
  // en-CA formatea como YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function formatDateEs(iso: string): string {
  const date = isoToUtc(iso);
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} de ${
    MONTH_NAMES[date.getUTCMonth()]
  } de ${date.getUTCFullYear()}`;
}

export function isPastDate(iso: string, now: Date = new Date()): boolean {
  return iso < todayIso(now);
}

// Resuelve día/mes con año opcional respecto a hoy. Sin año: si ya pasó, o es
// reciente (se marca como pasada) o es del año siguiente.
function resolveDayMonth(
  day: number,
  month: number,
  explicitYear: number | undefined,
  today: string
): ParsedTravelDate | null {
  const currentYear = Number(today.slice(0, 4));

  if (explicitYear !== undefined) {
    if (!isValidDate(explicitYear, month, day)) return null;
    const iso = toIso(explicitYear, month, day);
    return { status: iso < today ? "past" : "ok", iso };
  }

  if (!isValidDate(currentYear, month, day)) return null;
  const thisYear = toIso(currentYear, month, day);
  if (thisYear >= today) return { status: "ok", iso: thisYear };

  const daysAgo = Math.round(
    (isoToUtc(today).getTime() - isoToUtc(thisYear).getTime()) / 86_400_000
  );
  if (daysAgo <= RECENT_PAST_DAYS) return { status: "past", iso: thisYear };

  if (!isValidDate(currentYear + 1, month, day)) return null;
  return { status: "ok", iso: toIso(currentYear + 1, month, day) };
}

const normalizeYear = (raw: string | undefined): number | undefined => {
  if (!raw) return undefined;
  const n = Number(raw);
  return raw.length === 2 ? 2000 + n : n;
};

/**
 * Devuelve la fecha de viaje mencionada en el mensaje o null si no hay ninguna.
 * Entiende: "mañana", "pasado mañana", "hoy", "el viernes", "el próximo lunes",
 * "este sábado", "15 de noviembre", "15/11", "15/11/2026" y "2026-11-15".
 */
export function parseTravelDate(
  message: string,
  now: Date = new Date()
): ParsedTravelDate | null {
  const text = message.toLowerCase();
  const today = todayIso(now);

  // 2026-11-15
  const isoMatch = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (isoMatch) {
    return resolveDayMonth(
      Number(isoMatch[3]),
      Number(isoMatch[2]),
      Number(isoMatch[1]),
      today
    );
  }

  // 15/11, 15-11, 15/11/2026, 15/11/26
  const numericMatch = text.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}|\d{2}))?\b/);
  if (numericMatch) {
    return resolveDayMonth(
      Number(numericMatch[1]),
      Number(numericMatch[2]),
      normalizeYear(numericMatch[3]),
      today
    );
  }

  // 15 de noviembre [de 2026]  |  15 nov
  const monthNames = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
  const namedMatch = text.match(
    new RegExp(
      `\\b(\\d{1,2})\\s*(?:de\\s+)?(${monthNames})\\.?(?:\\s+(?:de(?:l)?\\s+)?(\\d{4}))?\\b`
    )
  );
  if (namedMatch) {
    return resolveDayMonth(
      Number(namedMatch[1]),
      MONTHS[namedMatch[2]],
      namedMatch[3] ? Number(namedMatch[3]) : undefined,
      today
    );
  }

  // pasado mañana (antes que "mañana"), mañana, hoy
  if (/\bpasado\s+ma[ñn]ana\b/.test(text)) {
    return { status: "ok", iso: addDays(today, 2) };
  }
  // "por la mañana" / "en la mañana" es la hora del día, no la fecha
  if (/(?<!\bla\s)(?<!\bde\s)\bma[ñn]ana\b/.test(text)) {
    return { status: "ok", iso: addDays(today, 1) };
  }
  if (/\bhoy\b/.test(text)) {
    return { status: "ok", iso: today };
  }

  // el viernes / este sábado / el próximo lunes → siguiente ocurrencia (nunca hoy)
  const weekdayMatch = text.match(
    /\b(?:(?:el|este|pr[oó]ximo|el\s+pr[oó]ximo)\s+)?(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/
  );
  if (weekdayMatch) {
    const normalized = weekdayMatch[1]
      .replace("miercoles", "miércoles")
      .replace("sabado", "sábado");
    const target = WEEKDAYS.indexOf(normalized);
    const current = isoToUtc(today).getUTCDay();
    const diff = ((target - current + 7) % 7) || 7;
    return { status: "ok", iso: addDays(today, diff) };
  }

  return null;
}
