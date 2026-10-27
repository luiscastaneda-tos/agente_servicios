import { inflateRawSync } from "zlib";

// Un .xlsx es un ZIP. Antes de dárselo a exceljs (que lo descomprime entero en memoria)
// se comprueba que no sea una "zip bomb": se lee el directorio central y se descomprime
// cada entrada con un tope de salida, sin fiarse de los tamaños declarados, que un
// archivo malicioso puede falsear.

export const ZIP_MAX_ENTRIES = 200;
export const ZIP_MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;

export type ZipCheck =
  | { ok: true; entries: number; uncompressedBytes: number }
  | { ok: false; reason: string };

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export function inspectZip(
  buffer: Buffer,
  limits: { maxEntries?: number; maxUncompressedBytes?: number } = {}
): ZipCheck {
  const maxEntries = limits.maxEntries ?? ZIP_MAX_ENTRIES;
  const maxBytes = limits.maxUncompressedBytes ?? ZIP_MAX_UNCOMPRESSED_BYTES;
  const bad = (reason: string): ZipCheck => ({ ok: false, reason });

  // 1. Registro de fin del directorio central (EOCD), buscado desde el final.
  let eocd = -1;
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= lowest; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return bad("no es un archivo ZIP/xlsx válido");

  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (
    totalEntries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    return bad("usa un formato ZIP64 que no se admite");
  }
  if (totalEntries === 0) return bad("está vacío");
  if (totalEntries > maxEntries) {
    return bad(`contiene demasiados elementos internos (${totalEntries})`);
  }
  if (centralOffset + centralSize > buffer.length) {
    return bad("tiene el directorio dañado");
  }

  // 2. Recorre el directorio central y descomprime cada entrada con presupuesto.
  let budget = maxBytes;
  let used = 0;
  let pos = centralOffset;

  for (let n = 0; n < totalEntries; n++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== CENTRAL_SIG) {
      return bad("tiene el directorio dañado");
    }
    const method = buffer.readUInt16LE(pos + 10);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    pos += 46 + nameLen + extraLen + commentLen;

    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      return bad("usa un formato ZIP64 que no se admite");
    }
    if (
      localOffset + 30 > buffer.length ||
      buffer.readUInt32LE(localOffset) !== LOCAL_SIG
    ) {
      return bad("tiene un elemento interno dañado");
    }
    const dataStart =
      localOffset +
      30 +
      buffer.readUInt16LE(localOffset + 26) +
      buffer.readUInt16LE(localOffset + 28);
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) return bad("tiene un elemento interno dañado");

    const data = buffer.subarray(dataStart, dataEnd);
    let size: number;
    if (method === 0) {
      size = data.length;
    } else if (method === 8) {
      try {
        size = inflateRawSync(data, { maxOutputLength: Math.max(1, budget) }).length;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return bad(
          code === "ERR_BUFFER_TOO_LARGE"
            ? `al descomprimirse supera ${Math.round(maxBytes / (1024 * 1024))} MB`
            : "tiene un elemento interno dañado"
        );
      }
    } else {
      return bad("usa un método de compresión no admitido");
    }

    used += size;
    budget -= size;
    if (budget < 0) {
      return bad(`al descomprimirse supera ${Math.round(maxBytes / (1024 * 1024))} MB`);
    }
  }

  return { ok: true, entries: totalEntries, uncompressedBytes: used };
}
