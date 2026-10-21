import { NextFunction, Request, Response } from "express";
import multer from "multer";
import { env } from "../config/env";
import { AppError } from "../utils/errors";

export function errorHandlerMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      res.status(400).json({
        ok: false,
        error: {
          code: "FILE_TOO_LARGE",
          message: `El archivo excede el tamaño máximo permitido de ${env.maxFileSizeMb} MB.`,
          retryable: false,
        },
      });
      return;
    }
    res.status(400).json({
      ok: false,
      error: {
        code: "UPLOAD_ERROR",
        message: err.message,
        retryable: false,
      },
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        retryable: err.retryable,
        details: env.nodeEnv === "development" ? err.details : undefined,
      },
    });
    return;
  }

  const unknownMessage =
    err instanceof Error ? err.message : "Error interno inesperado.";

  console.error("[MIA_AI_ERROR]", err);

  res.status(500).json({
    ok: false,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Ocurrió un problema al procesar tu solicitud. Por favor intenta nuevamente.",
      retryable: true,
      details: env.nodeEnv === "development" ? unknownMessage : undefined,
    },
  });
}
