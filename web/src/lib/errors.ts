import { log } from "./telemetry";

export interface Problem {
  type?: string;
  title?: string;
  status: number;
  code?: string;
  detail?: string;
  traceId?: string;
  errors?: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Problem,
    readonly path: string,
  ) {
    super(problem.detail ?? problem.title ?? `Request failed with status ${status}`);
    this.name = "ApiError";
  }

  get traceId() {
    return this.problem.traceId;
  }

  get fieldErrors(): Array<{ path?: string; message: string }> {
    return Array.isArray(this.problem.errors) ? (this.problem.errors as Array<{ path?: string; message: string }>) : [];
  }
}

export function isNetworkError(error: unknown) {
  return error instanceof TypeError && /fetch|network|load failed/i.test(error.message);
}

export function messageOf(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status >= 500) return "Terjadi gangguan pada server. Coba lagi beberapa saat lagi.";
    if (error.status === 400 && error.fieldErrors.length > 0) {
      return `Data tidak valid: ${error.fieldErrors.map((field) => field.path?.replace(/^\//, "") ?? field.message).join(", ")}`;
    }
    return error.message;
  }
  if (isNetworkError(error)) return "Tidak dapat terhubung ke server. Periksa koneksi Anda.";
  return "Terjadi kesalahan yang tidak terduga.";
}

export function reportError(error: unknown, context: Record<string, string | number | boolean | undefined> = {}) {
  const attributes = {
    ...context,
    ...(error instanceof ApiError
      ? {
          "http.response.status_code": error.status,
          "url.path": error.path,
          "error.code": error.problem.code,
          "upstream.trace_id": error.traceId,
        }
      : {}),
  };
  const expected = error instanceof ApiError && error.status < 500;
  log(expected ? "warn" : "error", expected ? "request rejected" : "unexpected error", attributes, error);
}
