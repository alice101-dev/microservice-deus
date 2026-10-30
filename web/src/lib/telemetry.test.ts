import { expect, test } from "vitest";
import { urlTemplate } from "./telemetry";

test("request and page names use the path with identifiers replaced, so they stay a short list", () => {
  expect(urlTemplate("/api/sales/invoices/0b7c43c4-2c64-4a36-9d0f-2f4d1d3f8a10/issue")).toBe(
    "/api/sales/invoices/:id/issue",
  );
  expect(urlTemplate("http://localhost/api/ledger/journals?page=2")).toBe("/api/ledger/journals");
  expect(urlTemplate("/api/reporting/periods/2026/10")).toBe("/api/reporting/periods/:id/:id");
});
