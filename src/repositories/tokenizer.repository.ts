import { Document } from "@langchain/core/documents";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { CSVLoader } from "@langchain/community/document_loaders/fs/csv";
import { TokenTextSplitter } from "@langchain/textsplitters";
import { getEncoding } from "js-tiktoken";
import { v4 as uuidv4 } from "uuid";
// @ts-ignore - d3-dsv does not bundle types by default
import { csvParse } from "d3-dsv";
import { env } from "../config/env";
import type {
  ITokenizerRepository,
  TokenizedDocumentResult,
} from "./interfaces/repositories.interface";

export class TokenizerRepository implements ITokenizerRepository {
  private readonly encoding = getEncoding("cl100k_base");

  public countTokens(text: string): number {
    if (!text) return 0;
    return this.encoding.encode(text).length;
  }

  public async tokenizeFile(params: {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
    sessionId: string;
    userId: string;
  }): Promise<TokenizedDocumentResult> {
    const { buffer, fileName, mimeType, sessionId, userId } = params;
    const documentId = uuidv4();
    const lowerName = fileName.toLowerCase();
    const isCsv =
      mimeType.includes("csv") ||
      lowerName.endsWith(".csv") ||
      mimeType === "application/vnd.ms-excel";
    const fileType: "pdf" | "csv" = isCsv ? "csv" : "pdf";

    const splitter = new TokenTextSplitter({
      encodingName: "cl100k_base",
      chunkSize: env.chunkSizeTokens,
      chunkOverlap: env.chunkOverlapTokens,
    });

    if (fileType === "pdf") {
      const pdfBlob = new Blob([new Uint8Array(buffer)], {
        type: "application/pdf",
      });
      const loader = new PDFLoader(pdfBlob, {
        splitPages: true,
      });
      const rawPages = await loader.load();

      const splitDocs: Document[] = [];
      let chunkIndex = 0;
      let totalTokens = 0;

      for (let i = 0; i < rawPages.length; i++) {
        const pageDoc = rawPages[i];
        const pageNumber =
          pageDoc.metadata?.loc?.pageNumber ?? i + 1;
        const pageChunks = await splitter.splitDocuments([pageDoc]);

        for (const chunk of pageChunks) {
          const cleanedText = chunk.pageContent.replace(/\u0000/g, "").trim();
          if (!cleanedText) continue;

          const tokenCount = this.countTokens(cleanedText);
          totalTokens += tokenCount;

          splitDocs.push(
            new Document({
              pageContent: cleanedText,
              metadata: {
                sessionId,
                userId,
                documentId,
                fileName,
                fileType: "pdf",
                chunkIndex,
                pageOrRowRange: `Página ${pageNumber}`,
                tokenCount,
                isSummaryChunk: false,
              },
            })
          );
          chunkIndex++;
        }
      }

      const previewSummary = splitDocs
        .slice(0, 2)
        .map((d) => d.pageContent.slice(0, 300))
        .join(" ... ");

      return {
        documentId,
        fileName,
        fileType: "pdf",
        chunks: splitDocs,
        totalChunks: splitDocs.length,
        totalTokens,
        summaryText: previewSummary,
      };
    }

    // CSV processing with LangChain CSVLoader + d3-dsv statistical & schema summary
    const rawCsvText = buffer.toString("utf-8").replace(/^\uFEFF/, "");
    const parsedRows = csvParse(rawCsvText) as Array<Record<string, string>> & {
      columns?: string[];
    };
    const columns: string[] =
      parsedRows.columns && parsedRows.columns.length > 0
        ? parsedRows.columns
        : parsedRows.length > 0
          ? Object.keys(parsedRows[0])
          : [];

    const summaryText = this.buildCsvStatisticalSummary(
      fileName,
      columns,
      parsedRows
    );

    const chunks: Document[] = [];
    let totalTokens = 0;

    // 1. First chunk is ALWAYS the Statistical & Schema Summary Chunk
    const summaryTokens = this.countTokens(summaryText);
    totalTokens += summaryTokens;
    chunks.push(
      new Document({
        pageContent: summaryText,
        metadata: {
          sessionId,
          userId,
          documentId,
          fileName,
          fileType: "csv",
          chunkIndex: 0,
          pageOrRowRange: `Resumen Global (Filas 1-${parsedRows.length})`,
          tokenCount: summaryTokens,
          isSummaryChunk: true,
        },
      })
    );

    // 2. Load rows with LangChain CSVLoader and batch/split by token budget
    const csvBlob = new Blob([new Uint8Array(Buffer.from(rawCsvText, "utf-8"))], {
      type: "text/csv",
    });
    const csvLoader = new CSVLoader(csvBlob);
    const rowDocs = await csvLoader.load();

    // Group row documents into coherent multi-row blocks before TokenTextSplitter
    const rowsPerGroup = 20;
    let chunkIndex = 1;

    for (let start = 0; start < rowDocs.length; start += rowsPerGroup) {
      const end = Math.min(start + rowsPerGroup, rowDocs.length);
      const slice = rowDocs.slice(start, end);
      const combinedRowsText = slice
        .map((doc, idx) => `[Fila ${start + idx + 1}]\n${doc.pageContent}`)
        .join("\n\n");

      const rowGroupDoc = new Document({
        pageContent: combinedRowsText,
      });

      const subChunks = await splitter.splitDocuments([rowGroupDoc]);
      for (const subChunk of subChunks) {
        const cleaned = subChunk.pageContent.replace(/\u0000/g, "").trim();
        if (!cleaned) continue;
        const tokenCount = this.countTokens(cleaned);
        totalTokens += tokenCount;

        chunks.push(
          new Document({
            pageContent: cleaned,
            metadata: {
              sessionId,
              userId,
              documentId,
              fileName,
              fileType: "csv",
              chunkIndex,
              pageOrRowRange: `Filas ${start + 1}-${end}`,
              tokenCount,
              isSummaryChunk: false,
            },
          })
        );
        chunkIndex++;
      }
    }

    return {
      documentId,
      fileName,
      fileType: "csv",
      chunks,
      totalChunks: chunks.length,
      totalTokens,
      summaryText,
    };
  }

  private buildCsvStatisticalSummary(
    fileName: string,
    columns: string[],
    rows: Array<Record<string, string>>
  ): string {
    const totalRows = rows.length;
    const lines: string[] = [
      `=== RESUMEN ESTADÍSTICO Y ESQUEMA GLOBAL DEL ARCHIVO CSV: ${fileName} ===`,
      `Total de filas de datos: ${totalRows}`,
      `Total de columnas (${columns.length}): ${columns.join(", ")}`,
      "",
      "--- Estadísticas por Columna ---",
    ];

    for (const col of columns) {
      const rawValues = rows
        .map((r) => (r[col] !== undefined && r[col] !== null ? String(r[col]).trim() : ""))
        .filter((v) => v !== "");

      const numericValues = rawValues
        .map((v) => Number(v.replace(/[$,€£\s]/g, "").replace(/,/g, "")))
        .filter((n) => !Number.isNaN(n) && Number.isFinite(n));

      // Consider column numeric if at least 60% of non-empty values are numeric
      if (
        rawValues.length > 0 &&
        numericValues.length / rawValues.length >= 0.6
      ) {
        const sum = numericValues.reduce((acc, val) => acc + val, 0);
        const min = Math.min(...numericValues);
        const max = Math.max(...numericValues);
        const avg = sum / numericValues.length;
        lines.push(
          `• Columna "${col}" (Numérica, ${numericValues.length} valores válidos): Suma Total = ${sum.toFixed(2)} | Promedio = ${avg.toFixed(2)} | Mín = ${min} | Máx = ${max}`
        );
      } else {
        const freq = new Map<string, number>();
        for (const val of rawValues) {
          freq.set(val, (freq.get(val) || 0) + 1);
        }
        const topValues = Array.from(freq.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([val, count]) => `"${val}" (${count})`)
          .join(", ");
        lines.push(
          `• Columna "${col}" (Texto/Categórica, ${freq.size} valores únicos de ${rawValues.length} no vacíos): Valores más frecuentes = ${topValues || "N/A"}`
        );
      }
    }

    const sampleRows = rows.slice(0, 5);
    if (sampleRows.length > 0) {
      lines.push("", "--- Muestra de las primeras 5 filas ---");
      sampleRows.forEach((row, idx) => {
        lines.push(`Fila ${idx + 1}: ${JSON.stringify(row)}`);
      });
    }

    return lines.join("\n");
  }
}
