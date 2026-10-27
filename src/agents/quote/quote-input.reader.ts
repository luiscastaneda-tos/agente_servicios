import ExcelJS from "exceljs";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { stripPrices } from "../../utils/price-filter";

export interface QuoteInputFile {
  fileName: string;
  mimeType: string;
  kind: "pdf" | "csv" | "excel" | "image";
  buffer: Buffer;
}

export interface QuoteReadResult {
  // Un bloque de texto por archivo (ya sin precios) listo para el prompt.
  textBlocks: string[];
  // Imágenes como data URI base64 para la visión del modelo.
  images: Array<{ fileName: string; dataUri: string }>;
  // Avisos legibles (PDF escaneado, archivo ilegible, etc.).
  warnings: string[];
}

const MAX_CHARS_PER_FILE = 12000;
const MAX_CHARS_TOTAL = 30000;
const MAX_ROWS_PER_SHEET = 200;
const MAX_SHEETS = 5;
const MAX_IMAGES = 3;
const MAX_PDF_PAGES = 30;

// Columnas cuyo encabezado habla de dinero: se descartan completas, lleven o no moneda.
const PRICE_HEADER = /precio|price|total|costo|cost|tarifa|importe|monto|amount/i;

// El nombre del archivo va dentro de una etiqueta del prompt: sin comillas, <, > ni saltos de línea.
const promptSafeName = (name: string): string =>
  name.replace(/["<>\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "archivo";

const clip = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}\n[...contenido recortado]` : value;

function cellToText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const v = value as unknown as Record<string, unknown>;
    if (Array.isArray(v.richText)) {
      return (v.richText as Array<{ text?: string }>)
        .map((r) => r.text ?? "")
        .join("");
    }
    if ("result" in v) return cellToText(v.result as ExcelJS.CellValue);
    if ("text" in v) return String(v.text ?? "");
    if ("error" in v) return "";
    return "";
  }
  return String(value);
}

// Limpia una tabla celda por celda (así un importe no puede "comerse" una fecha vecina):
// vacía las columnas de precio según su encabezado y quita montos de las demás celdas.
// Conserva la cantidad de filas para poder numerarlas.
function cleanTable(rows: string[][]): string[][] {
  const headerIdx = rows.findIndex((r) => r.some((c) => c.trim() !== ""));
  const priceCols = new Set<number>();
  if (headerIdx >= 0) {
    rows[headerIdx].forEach((cell, col) => {
      if (PRICE_HEADER.test(cell)) priceCols.add(col);
    });
  }
  return rows.map((row) =>
    row.map((cell, col) =>
      priceCols.has(col) ? "" : stripPrices(cell).replace(/\s+/g, " ").trim()
    )
  );
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

async function readPdf(
  file: QuoteInputFile
): Promise<{ text: string; truncated: boolean }> {
  const blob = new Blob([new Uint8Array(file.buffer)], {
    type: "application/pdf",
  });
  const allPages = await new PDFLoader(blob, { splitPages: true }).load();
  const pages = allPages.slice(0, MAX_PDF_PAGES);
  const text = pages
    .map((page, idx) => {
      const pageNumber = page.metadata?.loc?.pageNumber ?? idx + 1;
      const content = page.pageContent.replace(/\u0000/g, "").trim();
      return content ? `[Página ${pageNumber}]\n${content}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
  return { text, truncated: allPages.length > MAX_PDF_PAGES };
}

async function readExcel(file: QuoteInputFile): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.buffer as unknown as ExcelJS.Buffer);

  const sections: string[] = [];
  workbook.worksheets.slice(0, MAX_SHEETS).forEach((sheet) => {
    const numbers: number[] = [];
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rows.length >= MAX_ROWS_PER_SHEET) return;
      numbers.push(rowNumber);
      rows.push(
        (row.values as ExcelJS.CellValue[])
          .slice(1)
          .map(cellToText)
          .map((c) => c.replace(/\s+/g, " ").trim())
      );
    });
    const lines = cleanTable(rows)
      .map((cells, i) => ({ n: numbers[i], cells }))
      .filter(({ cells }) => cells.some((c) => c !== ""))
      .map(({ n, cells }) => `Fila ${n}: ${cells.join(" | ")}`);
    if (lines.length > 0) {
      sections.push(`[Hoja "${sheet.name}"]\n${lines.join("\n")}`);
    }
  });
  return sections.join("\n\n");
}

function readCsv(file: QuoteInputFile): string {
  const raw = file.buffer.toString("utf-8").replace(/^\uFEFF/, "");
  const lines = raw
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(0, MAX_ROWS_PER_SHEET + 1);
  const first = lines[0] ?? "";
  const delimiter =
    (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ";" : ",";
  return cleanTable(lines.map((line) => parseCsvLine(line, delimiter)))
    .filter((cells) => cells.some((c) => c !== ""))
    .map((cells) => cells.join(" | "))
    .join("\n");
}

export async function readQuoteFiles(
  files: QuoteInputFile[]
): Promise<QuoteReadResult> {
  const result: QuoteReadResult = { textBlocks: [], images: [], warnings: [] };
  let totalChars = 0;

  for (const file of files) {
    const name = promptSafeName(file.fileName);
    try {
      if (file.kind === "image") {
        if (result.images.length >= MAX_IMAGES) {
          result.warnings.push(
            `Solo leo ${MAX_IMAGES} imágenes por mensaje; omití "${name}".`
          );
          continue;
        }
        result.images.push({
          fileName: name,
          dataUri: `data:${file.mimeType};base64,${file.buffer.toString("base64")}`,
        });
        continue;
      }

      let text = "";
      if (file.kind === "pdf") {
        const pdf = await readPdf(file);
        text = pdf.text;
        if (pdf.truncated) {
          text += `\n\n[Solo se leyeron las primeras ${MAX_PDF_PAGES} páginas]`;
          result.warnings.push(
            `"${name}" tiene más de ${MAX_PDF_PAGES} páginas; solo leí las primeras ${MAX_PDF_PAGES}.`
          );
        }
      } else if (file.kind === "excel") text = await readExcel(file);
      else text = readCsv(file);

      text = stripPrices(text).trim();
      if (text.length < 20) {
        result.warnings.push(
          file.kind === "pdf"
            ? `No pude extraer texto de "${name}" (¿es un PDF escaneado?). Si es así, súbelo como imagen.`
            : `"${name}" no tiene contenido legible.`
        );
        continue;
      }

      const remaining = Math.max(0, MAX_CHARS_TOTAL - totalChars);
      if (remaining === 0) {
        result.warnings.push(`Omití "${name}" por exceder el tamaño total que puedo leer.`);
        continue;
      }
      const clipped = clip(text, Math.min(MAX_CHARS_PER_FILE, remaining));
      totalChars += clipped.length;
      result.textBlocks.push(
        `<archivo nombre="${name}" tipo="${file.kind}">\n${clipped}\n</archivo>`
      );
    } catch (err) {
      console.warn(
        `[QuoteAgent] No se pudo leer "${name}":`,
        err instanceof Error ? err.message : err
      );
      result.warnings.push(`No pude leer "${name}".`);
    }
  }

  return result;
}
