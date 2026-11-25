import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, test } from "vitest";
import LinesEditorHarness from "../../../test/LinesEditorHarness.svelte";
import { ApiError } from "../errors.ts";
import Alert from "./Alert.svelte";

const products = [
  {
    id: "p1",
    sku: "KOPI-250",
    name: "Kopi Arabika 250g",
    salePrice: "85000.00",
    purchasePrice: "60000.00",
    vatRate: "11.00",
    revenueAccountId: "rev",
    expenseAccountId: "inv",
  },
];
const accounts = [{ id: "rev", code: "4-1000", name: "Pendapatan Penjualan" }];

describe("components", () => {
  test("the lines editor fills a line from a product and shows live totals", async () => {
    render(LinesEditorHarness, { props: { products, accounts } });
    await fireEvent.change(screen.getByLabelText("Produk"), { target: { value: "p1" } });
    expect((screen.getByLabelText("Keterangan") as HTMLInputElement).value).toBe("Kopi Arabika 250g");
    await fireEvent.input(screen.getByLabelText("Jumlah"), { target: { value: "3" } });
    expect(screen.getByTestId("total").textContent).toBe("Rp 283.050,00");
    await fireEvent.click(screen.getByText("+ Tambah baris"));
    expect(screen.getAllByLabelText("Produk")).toHaveLength(2);
  });

  test("the alert shows the message and the trace code of a failed request", () => {
    render(Alert, {
      props: {
        error: new ApiError(409, { status: 409, detail: "The invoice is already issued", traceId: "abc123" }, "/x"),
      },
    });
    expect(screen.getByRole("alert").textContent).toContain("The invoice is already issued");
    expect(screen.getByRole("alert").textContent).toContain("abc123");
  });
});
