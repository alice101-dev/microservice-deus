import type { HandleClientError } from "@sveltejs/kit/hooks";
import { ApiError, messageOf, reportError } from "#lib/errors.ts";
import { startTelemetry } from "#lib/telemetry.ts";

startTelemetry({ version: __APP_VERSION__, environment: __APP_ENVIRONMENT__ });

addEventListener("unhandledrejection", (event: PromiseRejectionEvent) =>
  reportError(event.reason, { "error.source": "unhandledrejection" }),
);
addEventListener("error", (event: ErrorEvent) =>
  reportError(event.error ?? event.message, { "error.source": "window" }),
);

export const handleError: HandleClientError = (caught) => {
  if (caught.kind === "framework") {
    return { message: caught.error.status === 404 ? "Halaman tidak ditemukan" : caught.error.message };
  }
  if (caught.kind === "app") return caught.error;
  reportError(caught.error, { "error.source": "sveltekit" });
  return {
    message: messageOf(caught.error),
    ...(caught.error instanceof ApiError && caught.error.traceId ? { traceId: caught.error.traceId } : {}),
  };
};
