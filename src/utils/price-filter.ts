// Montos monetarios: "$220", "$180.00 MXN", "MXN 350", "desde 220 pesos", "USD 40".
// - Con símbolo/código delante ($, MXN, USD...) cualquier número que lo siga es dinero.
// - Sin símbolo, el número debe ir seguido de la moneda y tener forma de importe
//   (miles con separador o hasta 2 decimales): "01,2500 MXN" no es un importe, así
//   que "2026-12-01,2500 MXN" pierde solo "2500 MXN" y no la fecha.
// - El lookbehind evita que el número se enganche a una fecha o a otro número previo
//   ("12-01", "10/01", "2026-12-01").
const NUMBER = String.raw`\d+(?:[.,]\d+)*`;
const AMOUNT = String.raw`(?:\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,]\d{1,2})?`;
const CURRENCY = String.raw`(?:MXN|USD|EUR|pesos|d[oó]lares|euros)`;
const PREFIX = String.raw`(?:(?:desde|a partir de|from|por)\s+)?`;
const PRICE_PATTERN = new RegExp(
  PREFIX +
    String.raw`(?:(?:US\$|MXN|USD|EUR)\s?|\$\s?)${NUMBER}(?:\s?${CURRENCY}\b)?` +
    "|" +
    PREFIX +
    String.raw`(?<!\d|\d[-/.])\b${AMOUNT}\s?${CURRENCY}\b`,
  "gi"
);

export function stripPrices(text: string): string {
  return text
    .replace(PRICE_PATTERN, "")
    .replace(/\|\s*Precio[^|]*\|/gi, "|")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function stripPricesFromList(items: string[]): string[] {
  return items.map(stripPrices).filter((item) => item.length > 0);
}

// Los LLM devuelven null para datos que no conocen; los esquemas esperan campo ausente.
export function dropNulls<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => dropNulls(item)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const clean: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (val !== null) clean[key] = dropNulls(val);
    }
    return clean as T;
  }
  return value;
}

// Parsea JSON de un LLM tolerando comas sobrantes antes de } o ].
export function parseLenientJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(text.replace(/,\s*([}\]])/g, "$1"));
  }
}
