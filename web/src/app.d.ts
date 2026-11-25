declare global {
  const __APP_VERSION__: string;
  const __APP_ENVIRONMENT__: string;
  namespace App {
    interface Error {
      message: string;
      traceId?: string;
    }
  }
}

export {};
