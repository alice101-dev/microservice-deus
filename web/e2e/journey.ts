import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const SHOTS = process.env.SCREENSHOTS ?? "e2e/screenshots";
const email = `e2e+${Date.now()}@deus.example`;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: process.env.HEADED !== "1",
  slowMo: process.env.HEADED === "1" ? 350 : 0,
});
const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, locale: "id-ID" });
const problems: string[] = [];
page.on("console", (message) => {
  if (message.type() === "error") problems.push(`console: ${message.text()}`);
});
page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
page.on("response", (response) => {
  if (response.status() >= 500) problems.push(`${response.status()} ${response.url()}`);
});
const shot = (name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const step = (name: string) => process.stdout.write(`✓ ${name}\n`);

await page.goto(`${BASE}/`);
await page.waitForURL("**/login**");
step("unauthenticated visit redirects to login");
await page.getByRole("link", { name: "Daftar" }).click();
await page.getByLabel("Nama", { exact: true }).fill("Uji Coba");
await page.getByLabel("Email").fill(email);
await page.getByLabel(/Kata sandi/).fill("correct-horse-battery");
await page.getByRole("button", { name: "Buat akun" }).click();
await page.waitForURL("**/onboarding");
step("registered");

await page.getByLabel("Nama badan usaha").fill("PT Uji Coba Sejahtera");
await page.getByLabel("NPWP").fill("0123456789012345");
await page.getByLabel("Alamat").fill("Jl. Asia Afrika 8, Bandung");
await shot("01-onboarding");
await page.getByRole("button", { name: "Mulai" }).click();
await page.waitForURL(`${BASE}/`);
await page.getByText("Kas & bank").waitFor();
step("onboarded: organization, profile and default chart");

await page.goto(`${BASE}/contacts`);
await page.getByRole("button", { name: "+ Kontak baru" }).click();
const contact = page.getByRole("dialog");
await contact.getByLabel("Nama", { exact: true }).fill("PT Pelanggan Uji");
await contact.getByLabel("Email").fill("keuangan@pelanggan-uji.example");
await contact.getByRole("button", { name: "Simpan" }).click();
await page.getByRole("cell", { name: /PT Pelanggan Uji/ }).waitFor();
step("customer created");

await page.goto(`${BASE}/products`);
await page.getByRole("button", { name: "+ Produk baru" }).click();
const product = page.getByRole("dialog");
await product.getByLabel("SKU").fill("TEH-100");
await product.getByLabel("Nama", { exact: true }).fill("Teh Melati 100g");
await product.getByLabel("Harga jual").fill("45.000");
await product.getByLabel("Akun pendapatan").selectOption({ label: "4-1000 Pendapatan Penjualan" });
await product.getByRole("button", { name: "Simpan" }).click();
await page.getByRole("cell", { name: "Rp 45.000,00" }).waitFor();
step("product created with Indonesian price input");

await page.goto(`${BASE}/sales/new`);
await page.getByRole("combobox", { name: /^Pelanggan/ }).selectOption({ label: "PT Pelanggan Uji" });
await page.getByLabel("Produk").selectOption({ label: "TEH-100" });
await page.getByLabel("Jumlah").fill("4");
await page.getByTestId("total").filter({ hasText: "Rp 199.800,00" }).waitFor();
await shot("02-invoice-form");
await page.getByRole("button", { name: "Simpan draf" }).click();
await page.waitForURL(/\/sales\/[0-9a-f-]{36}$/);
await page.getByRole("button", { name: "Terbitkan" }).click();
await page.getByRole("heading", { name: /^INV\/\d{4}\/\d{4}$/ }).waitFor();
const number = await page.getByRole("heading", { level: 1 }).textContent();
await shot("03-invoice-issued");
step(`invoice issued: ${number}`);

await page.getByRole("link", { name: "Catat penerimaan" }).click();
await page.waitForURL("**/payments/new**");
await page.getByText("Rp 199.800,00").first().waitFor();
await page.getByRole("button", { name: "Catat" }).click();
await page.waitForURL("**/payments?kind=receipt");
await page.getByText("RCV/").first().waitFor();
step("payment recorded from the invoice");

await page.goto(`${BASE}/sales`);
await page.waitForTimeout(3000);
await page.reload();
await page.getByText("Lunas").first().waitFor({ timeout: 20000 });
step("invoice shows as paid after the outbox delivered the allocation");

await page.goto(`${BASE}/reports`);
await page.getByText("Laba (rugi) bersih").waitFor();
await shot("04-reports");
await page.goto(`${BASE}/`);
await page.getByText("Kas & bank").waitFor();
await shot("05-dashboard");
await page.goto(`${BASE}/ledger`);
await page.getByText("Penjualan").first().waitFor();
await shot("06-ledger");
step("reports, dashboard and ledger render");

await page.goto(`${BASE}/halaman-tidak-ada`);
await page.getByRole("heading", { name: "Tidak ditemukan" }).waitFor();
step("unknown route shows the not-found page");

await page.waitForTimeout(2000);
await browser.close();
process.stdout.write(`${JSON.stringify({ email, number, problems })}\n`);
if (problems.length > 0) process.exit(1);
