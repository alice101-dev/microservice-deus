import { describe, expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { rupiah, tanggal, winAnsi } from "../src/format";
import { invoiceEmail, invoicePdf } from "../src/invoice";

const invoice = {
  invoiceId: "i-1",
  number: "INV/2026/0001",
  issueDate: "2026-10-28",
  dueDate: "2026-11-11",
  customer: { name: "PT Pelanggan Setia", address: "Jl. Merdeka 1", taxId: "0123456789012345" },
  lines: Array.from({ length: 60 }, (_, index) => ({
    description: `Kopi Arabika 250g ${index + 1}`,
    quantity: "3",
    unitPrice: "85000.00",
    amount: "255000.00",
  })),
  subtotal: "15300000.00",
  vatTotal: "1683000.00",
  total: "16983000.00",
  notes: "Transfer ke BCA 123-456-7890",
};

describe("invoice documents", () => {
  test("formats rupiah, Indonesian dates and PDF-safe text", () => {
    expect(rupiah("1500000.00")).toBe("Rp 1.500.000,00");
    expect(rupiah("85000.5")).toBe("Rp 85.000,50");
    expect(rupiah("-6500.00")).toBe("-Rp 6.500,00");
    expect(rupiah("0.00")).toBe("Rp 0,00");
    expect(tanggal("2026-03-05")).toBe("5 Maret 2026");
    expect(winAnsi("Café ✓")).toBe("Cafe ?");
  });

  test("writes the email and a multi-page PDF", async () => {
    const company = {
      organizationId: "o",
      legalName: "PT Maju Bersama",
      taxId: null,
      address: null,
      currency: "IDR" as const,
      fiscalYearStartMonth: 1,
    };
    const email = invoiceEmail(invoice, company);
    expect(email.subject).toBe("Invoice INV/2026/0001 dari PT Maju Bersama");
    expect(email.text).toContain("sebesar Rp 16.983.000,00");
    expect(email.text).toContain("paling lambat 11 November 2026");
    const bytes = await invoicePdf(invoice, company);
    const parsed = await PDFDocument.load(bytes);
    expect(parsed.getPageCount()).toBe(2);
    expect(parsed.getTitle()).toBe("Invoice INV/2026/0001");
  });
});
