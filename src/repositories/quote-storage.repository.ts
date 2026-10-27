import { v4 as uuidv4 } from "uuid";
import { env } from "../config/env";
import { getSupabaseClient, isSupabaseConfigured } from "../config/supabase";
import { QuoteFileRef } from "../types";

// Segmento del usuario: debe producir el mismo resultado que `safeSegment` de bacl
// (bacl/api/modules/cotizacionesIa/cotizacionesIa.schema.js), porque bacl exige que el
// storage_path empiece con `${safeSegment(id_usuario)}/`. Mismas operaciones y en el mismo
// orden; no lo cambies sin cambiar el de bacl (y viceversa).
export const userSegment = (value: string): string =>
  String(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/\.{2,}/g, ".")
    .slice(-80) || "x";

// Segmento de sesión y de nombre de archivo. bacl rechaza rutas con ".." o que empiecen
// con "/": los puntos repetidos se colapsan y no puede quedar vacío ni empezar con punto.
export const safeSegment = (value: string): string =>
  userSegment(value)
    .replace(/\.{2,}/g, ".")
    .replace(/^[._-]+/, "") || "x";

/**
 * Guarda el original de cada adjunto de una cotización en el bucket privado de
 * Supabase Storage. Nunca lanza: si falla (bucket inexistente, sin credenciales)
 * devuelve la referencia con storagePath null y el motivo en uploadError, para que
 * el borrador se entregue igual.
 */
export class QuoteStorageRepository {
  public async uploadOriginal(params: {
    userId: string;
    sessionId: string;
    fileName: string;
    mimeType: string;
    buffer: Buffer;
  }): Promise<QuoteFileRef> {
    const ref: QuoteFileRef = {
      fileName: params.fileName.slice(0, 255),
      mimeType: params.mimeType,
      sizeBytes: params.buffer.length,
      storagePath: null,
    };

    if (!isSupabaseConfigured()) {
      return { ...ref, uploadError: "Supabase Storage no está configurado." };
    }

    const path = `${userSegment(params.userId)}/${safeSegment(
      params.sessionId
    )}/${uuidv4()}-${safeSegment(params.fileName)}`;

    try {
      const { error } = await getSupabaseClient()
        .storage.from(env.cotizacionesBucket)
        .upload(path, params.buffer, {
          contentType: params.mimeType,
          upsert: false,
        });

      if (error) {
        console.warn(
          `[QuoteStorage] No se pudo subir "${params.fileName}" a "${env.cotizacionesBucket}": ${error.message}`
        );
        return { ...ref, uploadError: error.message };
      }
      return { ...ref, storagePath: path };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[QuoteStorage] Error subiendo "${params.fileName}": ${message}`);
      return { ...ref, uploadError: message };
    }
  }
}
