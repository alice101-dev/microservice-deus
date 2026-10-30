import { expect, test } from "vitest";
import { currentPage, setPage, urlTemplate } from "./telemetry";

test("request and page names use the path with identifiers replaced, so they stay a short list", () => {
  expect(urlTemplate("/api/sales/invoices/0b7c43c4-2c64-4a36-9d0f-2f4d1d3f8a10/issue")).toBe(
    "/api/sales/invoices/:id/issue",
  );
  expect(urlTemplate("http://localhost/api/ledger/journals?page=2")).toBe("/api/ledger/journals");
  expect(urlTemplate("/api/reporting/periods/2026/10")).toBe("/api/reporting/periods/:id/:id");
});

test("the page a request comes from is the page being opened, with identifiers replaced", () => {
  setPage("http://localhost/payments/new?kind=receipt");
  expect(currentPage()).toBe("/payments/new");
  setPage(new URL("http://localhost/sales/82855612-bc35-47d9-b462-cdda108a4fe9"));
  expect(currentPage()).toBe("/sales/:id");
});
