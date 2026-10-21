export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly details?: unknown;

  constructor(params: {
    statusCode: number;
    code: string;
    message: string;
    retryable?: boolean;
    details?: unknown;
  }) {
    super(params.message);
    this.name = "AppError";
    this.statusCode = params.statusCode;
    this.code = params.code;
    this.retryable = params.retryable ?? false;
    this.details = params.details;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export function createProvidersUnavailableError(details?: unknown): AppError {
  return new AppError({
    statusCode: 503,
    code: "AI_PROVIDERS_UNAVAILABLE",
    message:
      "Temporalmente nuestros proveedores de inteligencia artificial (Gemini y OpenAI) no están disponibles o excedieron el tiempo de espera. Por favor intenta enviar tu solicitud nuevamente en unos momentos.",
    retryable: true,
    details,
  });
}

export function createQuotaExceededError(message: string): AppError {
  return new AppError({
    statusCode: 429,
    code: "SESSION_QUOTA_EXCEEDED",
    message,
    retryable: false,
  });
}

export function createGuardrailBlockedError(message: string): AppError {
  return new AppError({
    statusCode: 400,
    code: "GUARDRAIL_BLOCKED",
    message,
    retryable: false,
  });
}
