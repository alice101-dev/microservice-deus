import type { ProfileRef } from "@deus/clients";
import { PDFDocument, type PDFFont, rgb, StandardFonts } from "pdf-lib";
import { rupiah, tanggal, winAnsi } from "./format";

export interface InvoiceData {
  invoiceId: string;
  number: string;
  issueDate: string;
  dueDate: string;
  customer: { name: string; address: string | null; taxId: string | null };
  lines: Array<{ description: string; quantity: string; unitPrice: string; amount: string }>;
  subtotal: string;
  vatTotal: string;
  total: string;
  notes: string | null;
}

export function invoiceEmail(invoice: InvoiceData, company: ProfileRef | null) {
  const seller = company?.legalName ?? "Deus";
  const subject = `Invoice ${invoice.number} dari ${seller}`;
  const text = [
    `Yth. ${invoice.customer.name},`,
    "",
    `Terlampir invoice ${invoice.number} tertanggal ${tanggal(invoice.issueDate)} sebesar ${rupiah(invoice.total)}.`,
    `Mohon dibayar paling lambat ${tanggal(invoice.dueDate)}.`,
    "",
    "Terima kasih,",
    seller,
  ].join("\n");
  return { subject, text };
}

export async function invoicePdf(invoice: InvoiceData, company: ProfileRef | null) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Invoice ${invoice.number}`);
  pdf.setCreator("deus");
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([595.28, 841.89]);
  let y = 790;
  const left = 50;
  const right = 545;
  const write = (text: string, x: number, size = 10, font: PDFFont = regular) =>
    page.drawText(winAnsi(text), { x, y, size, font, color: rgb(0.1, 0.1, 0.1) });
  const writeRight = (text: string, x: number, size = 10, font: PDFFont = regular) =>
    write(text, x - font.widthOfTextAtSize(winAnsi(text), size), size, font);
  const line = () => page.drawLine({ start: { x: left, y: y - 4 }, end: { x: right, y: y - 4 }, thickness: 0.5 });

  write(company?.legalName ?? "Deus", left, 16, bold);
  writeRight("INVOICE", right, 16, bold);
  y -= 16;
  if (company?.address) write(company.address, left, 9);
  writeRight(invoice.number, right, 10, bold);
  y -= 13;
  if (company?.taxId) write(`NPWP ${company.taxId}`, left, 9);
  writeRight(`Tanggal ${tanggal(invoice.issueDate)}`, right, 9);
  y -= 13;
  writeRight(`Jatuh tempo ${tanggal(invoice.dueDate)}`, right, 9);
  y -= 30;
  write("Kepada", left, 9, bold);
  y -= 13;
  write(invoice.customer.name, left, 10);
  y -= 13;
  if (invoice.customer.address) {
    write(invoice.customer.address, left, 9);
    y -= 13;
  }
  if (invoice.customer.taxId) {
    write(`NPWP ${invoice.customer.taxId}`, left, 9);
    y -= 13;
  }
  y -= 18;
  write("Keterangan", left, 9, bold);
  writeRight("Jumlah", 330, 9, bold);
  writeRight("Harga", 435, 9, bold);
  writeRight("Total", right, 9, bold);
  line();
  y -= 18;
  for (const item of invoice.lines) {
    if (y < 120) {
      page = pdf.addPage([595.28, 841.89]);
      y = 790;
    }
    write(item.description.slice(0, 60), left, 9);
    writeRight(item.quantity, 330, 9);
    writeRight(rupiah(item.unitPrice), 435, 9);
    writeRight(rupiah(item.amount), right, 9);
    y -= 15;
  }
  line();
  y -= 20;
  for (const [label, value, font] of [
    ["Subtotal", invoice.subtotal, regular],
    ["PPN", invoice.vatTotal, regular],
    ["Total", invoice.total, bold],
  ] as const) {
    writeRight(label, 435, 10, font);
    writeRight(rupiah(value), right, 10, font);
    y -= 15;
  }
  if (invoice.notes) {
    y -= 15;
    write(invoice.notes.slice(0, 100), left, 9);
  }
  return pdf.save();
}
