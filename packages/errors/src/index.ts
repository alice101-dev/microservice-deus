export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  instance?: string;
  traceId?: string;
  errors?: unknown;
}

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }

  get expose(): boolean {
    return this.status < 500;
  }
}

export class BadRequestError extends AppError {
  constructor(message = "The request is invalid", details?: unknown, options?: ErrorOptions) {
    super(400, "bad_request", message, details, options);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication is required", details?: unknown, options?: ErrorOptions) {
    super(401, "unauthorized", message, details, options);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "The action is not allowed", details?: unknown, options?: ErrorOptions) {
    super(403, "forbidden", message, details, options);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "The resource does not exist", details?: unknown, options?: ErrorOptions) {
    super(404, "not_found", message, details, options);
  }
}

export class ConflictError extends AppError {
  constructor(message = "The resource is in a conflicting state", details?: unknown, options?: ErrorOptions) {
    super(409, "conflict", message, details, options);
  }
}

export class UnprocessableError extends AppError {
  constructor(message = "The request cannot be processed", details?: unknown, options?: ErrorOptions) {
    super(422, "unprocessable", message, details, options);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = "The service is temporarily unavailable", details?: unknown, options?: ErrorOptions) {
    super(503, "service_unavailable", message, details, options);
  }
}

const TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  422: "Unprocessable Content",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

export function problem(
  status: number,
  code: string,
  detail: string | undefined,
  extra: Partial<Pick<Problem, "instance" | "traceId" | "errors">> = {},
): Problem {
  return {
    type: `urn:deus:error:${code}`,
    title: TITLES[status] ?? "Error",
    status,
    code,
    ...(detail === undefined ? {} : { detail }),
    ...extra,
  };
}

export function toProblem(error: unknown, extra: Partial<Pick<Problem, "instance" | "traceId">> = {}): Problem {
  if (error instanceof AppError) {
    return problem(error.status, error.code, error.expose ? error.message : undefined, {
      ...extra,
      ...(error.expose && error.details !== undefined ? { errors: error.details } : {}),
    });
  }
  return problem(500, "internal", undefined, extra);
}
