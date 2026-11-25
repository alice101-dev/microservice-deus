import { check, fail, sleep } from "k6";
import encoding from "k6/encoding";
import http from "k6/http";

const BASE = __ENV.BASE_URL || "http://localhost:8080";
const ORIGIN = __ENV.AUTH_ORIGIN || BASE;
const AUTH = `${BASE}/api/identity/auth`;
const ok = http.expectedStatuses({ min: 200, max: 299 });
const SETUP_PATIENCE_MS = 8 * 60_000;

const scenario = (exec, rate, timeUnit) => ({
  executor: "constant-arrival-rate",
  exec,
  rate,
  timeUnit,
  duration: __ENV.DURATION || "87600h",
  preAllocatedVUs: 2,
  maxVUs: 10,
  gracefulStop: "10s",
});

export const options = {
  scenarios: {
    browse: scenario("browse", Number(__ENV.BROWSE_PER_MINUTE || 120), "1m"),
    sell: scenario("sell", Number(__ENV.SELL_PER_MINUTE || 2), "1m"),
    buy: scenario("buy", Number(__ENV.BUY_PER_MINUTE || 1), "1m"),
    mistakes: scenario("mistakes", Number(__ENV.MISTAKES_PER_MINUTE || 3), "1m"),
  },
  setupTimeout: "10m",
  systemTags: ["scenario", "name", "method", "status", "expected_response", "error_code", "check"],
};

const pick = (items) => items[Math.floor(Math.random() * items.length)];
const between = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const jakarta = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const monthStart = () => `${jakarta().slice(0, 8)}01`;

function patiently(request) {
  const deadline = Date.now() + SETUP_PATIENCE_MS;
  let response = request();
  while (response.status >= 300 && Date.now() < deadline) {
    sleep(5);
    response = request();
  }
  return response;
}

function authPost(path, body, retry = false) {
  const send = () =>
    http.post(`${AUTH}${path}`, JSON.stringify(body), {
      headers: { "content-type": "application/json", origin: ORIGIN },
      tags: { name: `POST /api/identity/auth${path}` },
      responseCallback: ok,
    });
  const response = retry ? patiently(send) : send();
  if (response.status >= 300) fail(`${path} returned ${response.status}: ${response.body}`);
  return response.json();
}

function issueToken() {
  const response = http.get(`${AUTH}/token`, { tags: { name: "GET /api/identity/auth/token" }, responseCallback: ok });
  if (response.status >= 300) return null;
  const token = response.json("token");
  const claims = JSON.parse(encoding.b64decode(token.split(".")[1], "rawurl", "s"));
  return { token, expiresAt: claims.exp * 1000 };
}

function signIn(credentials, retry = false) {
  authPost("/sign-in/email", { email: credentials.email, password: credentials.password }, retry);
  authPost("/organization/set-active", { organizationId: credentials.organizationId }, retry);
  return issueToken() ?? fail("no token after sign-in");
}

let session;

function token(credentials) {
  if (!session || session.expiresAt - Date.now() < 120_000) {
    session = (session && issueToken()) || signIn(credentials);
  }
  return session.token;
}

function api(credentials, method, path, name, body, expected = ok) {
  const response = http.request(method, `${BASE}${path}`, body === undefined ? null : JSON.stringify(body), {
    headers: { authorization: `Bearer ${token(credentials)}`, "content-type": "application/json" },
    tags: { name: `${method} ${name}` },
    responseCallback: expected,
    timeout: "10s",
  });
  check(response, { [`${method} ${name} as expected`]: (r) => (expected === ok ? r.status < 300 : r.status < 500) });
  return response;
}

function seed(credentials) {
  const call = (method, path, body) => {
    const response = patiently(() => api(credentials, method, path, path, body));
    if (response.status >= 300) fail(`${method} ${path} returned ${response.status}: ${response.body}`);
    return response.json();
  };
  call("PUT", "/api/organization/profile", {
    legalName: "PT Lalu Lintas Uji",
    taxId: "0123456789012345",
    address: "Jl. Sudirman 1, Jakarta",
    fiscalYearStartMonth: 1,
  });
  call("POST", "/api/accounts/defaults");
  const accounts = Object.fromEntries(call("GET", "/api/accounts/").map((account) => [account.code, account.id]));
  const customers = [
    "CV Sinar Abadi",
    "PT Nusantara Retail",
    "Toko Berkah Jaya",
    "PT Sentosa Makmur",
    "UD Tani Subur",
  ].map(
    (name, index) =>
      call("POST", "/api/contacts/", {
        name,
        isCustomer: true,
        isVendor: false,
        paymentTermsDays: 30,
        email: index === 0 ? "keuangan@sinar-abadi.example" : null,
      }).id,
  );
  const vendors = ["PT Pemasok Utama", "CV Grosir Murah"].map(
    (name) => call("POST", "/api/contacts/", { name, isCustomer: false, isVendor: true, paymentTermsDays: 14 }).id,
  );
  const products = [
    ["KOPI-250", "Kopi Arabika 250g", "goods", "85000.00", "60000.00"],
    ["TEH-100", "Teh Melati 100g", "goods", "45000.00", "30000.00"],
    ["GULA-1K", "Gula Aren 1kg", "goods", "38000.00", "27000.00"],
    ["ANTAR", "Jasa Pengiriman", "service", "25000.00", null],
    ["KONSUL", "Konsultasi Pembukuan", "service", "750000.00", null],
  ].map(
    ([sku, name, kind, salePrice, purchasePrice]) =>
      call("POST", "/api/products/", {
        sku,
        name,
        kind,
        salePrice,
        purchasePrice,
        vatRate: "11",
        revenueAccountId: accounts["4-1000"],
        expenseAccountId: kind === "goods" ? accounts["5-1000"] : accounts["6-9000"],
      }).id,
  );
  const goods = products.slice(0, 3);
  const bankAccount = call("POST", "/api/banking/accounts", {
    name: "Rekening Operasional",
    bankName: "Bank Contoh",
    accountNumber: "123-456-7890",
    ledgerAccountId: accounts["1-1100"],
    openingDate: jakarta(),
  }).id;
  return { customers, vendors, products, goods, bank: accounts["1-1100"], bankAccount, fees: accounts["6-9000"] };
}

export function setup() {
  const credentials = { email: `traffic+${Date.now()}@deus.example`, password: `${crypto.randomUUID()}-Aa1` };
  authPost("/sign-up/email", { name: "Lalu Lintas", ...credentials }, true);
  const organization = authPost(
    "/organization/create",
    { name: "PT Lalu Lintas Uji", slug: `lalu-lintas-${crypto.randomUUID().slice(0, 8)}` },
    true,
  );
  credentials.organizationId = organization.id;
  session = signIn(credentials, true);
  return { credentials, ...seed(credentials) };
}

export function browse(data) {
  const { credentials: c } = data;
  const today = jakarta();
  const [method, path, name] = pick([
    ["GET", `/api/sales/invoices?from=${today}&to=${today}`, "/api/sales/invoices"],
    ["GET", `/api/purchases/bills?from=${monthStart()}&to=${today}`, "/api/purchases/bills"],
    ["GET", `/api/payments/?from=${today}&to=${today}`, "/api/payments/"],
    ["GET", `/api/ledger/journals?from=${today}&to=${today}`, "/api/ledger/journals"],
    ["GET", `/api/ledger/trial-balance?asOf=${today}`, "/api/ledger/trial-balance"],
    ["GET", `/api/reporting/income-statement?from=${monthStart()}&to=${today}`, "/api/reporting/income-statement"],
    ["GET", `/api/reporting/balance-sheet?asOf=${today}`, "/api/reporting/balance-sheet"],
    ["GET", "/api/contacts/", "/api/contacts/"],
    ["GET", `/api/contacts/${pick(data.customers)}`, "/api/contacts/{id}"],
    ["GET", "/api/products/", "/api/products/"],
    ["GET", `/api/products/${pick(data.products)}`, "/api/products/{id}"],
    ["GET", "/api/accounts/", "/api/accounts/"],
    ["GET", "/api/organization/profile", "/api/organization/profile"],
    ["GET", "/api/tax/vat-returns", "/api/tax/vat-returns"],
    ["GET", "/api/notification/messages", "/api/notification/messages"],
    ["GET", "/api/banking/accounts", "/api/banking/accounts"],
    ["GET", `/api/banking/accounts/${data.bankAccount}/lines?status=unmatched`, "/api/banking/accounts/{id}/lines"],
    [
      "GET",
      `/api/banking/accounts/${data.bankAccount}/reconciliation?asOf=${today}`,
      "/api/banking/accounts/{id}/reconciliation",
    ],
  ]);
  api(c, method, path, name);
}

export function sell(data) {
  const { credentials: c } = data;
  const today = jakarta();
  const lines = Array.from({ length: between(1, 3) }, () => ({
    productId: pick(data.products),
    quantity: String(between(1, 12)),
  }));
  const draft = api(c, "POST", "/api/sales/invoices", "/api/sales/invoices", {
    contactId: pick(data.customers),
    issueDate: today,
    lines,
  });
  if (draft.status >= 300) return;
  const id = draft.json("id");
  if (Math.random() < 0.1) {
    api(c, "DELETE", `/api/sales/invoices/${id}`, "/api/sales/invoices/{id}");
    return;
  }
  const issued = api(c, "POST", `/api/sales/invoices/${id}/issue`, "/api/sales/invoices/{id}/issue");
  if (issued.status >= 300) return;
  api(c, "GET", `/api/sales/invoices/${id}`, "/api/sales/invoices/{id}");
  const roll = Math.random();
  if (roll < 0.05) {
    api(c, "POST", `/api/sales/invoices/${id}/void`, "/api/sales/invoices/{id}/void", {});
    return;
  }
  if (roll > 0.7) return;
  const total = issued.json("total");
  const amount = roll < 0.55 ? total : (Number(total) / 2).toFixed(2);
  const payment = api(c, "POST", "/api/payments/", "/api/payments/", {
    kind: "receipt",
    contactId: issued.json("contactId"),
    date: today,
    cashAccountId: data.bank,
    amount,
    allocations: [{ documentId: id, amount }],
  });
  reconcile(data, payment);
}

export function buy(data) {
  const { credentials: c } = data;
  const today = jakarta();
  const bill = api(c, "POST", "/api/purchases/bills", "/api/purchases/bills", {
    contactId: pick(data.vendors),
    billDate: today,
    vendorReference: `PO-${Date.now()}`,
    lines: [{ productId: pick(data.goods), quantity: String(between(10, 50)) }],
  });
  if (bill.status >= 300) return;
  const id = bill.json("id");
  const approved = api(c, "POST", `/api/purchases/bills/${id}/approve`, "/api/purchases/bills/{id}/approve");
  if (approved.status >= 300 || Math.random() < 0.4) return;
  const total = approved.json("total");
  const payment = api(c, "POST", "/api/payments/", "/api/payments/", {
    kind: "disbursement",
    contactId: approved.json("contactId"),
    date: today,
    cashAccountId: data.bank,
    amount: total,
    allocations: [{ documentId: id, amount: total }],
  });
  reconcile(data, payment);
}

function importLine(data, line) {
  const { credentials: c, bankAccount } = data;
  const imported = api(
    c,
    "POST",
    `/api/banking/accounts/${bankAccount}/statements`,
    "/api/banking/accounts/{id}/statements",
    { lines: [line] },
  );
  if (imported.status >= 300 || imported.json("imported") === 0) return null;
  const lines = api(
    c,
    "GET",
    `/api/banking/accounts/${bankAccount}/lines?status=unmatched`,
    "/api/banking/accounts/{id}/lines",
  );
  if (lines.status >= 300) return null;
  return lines.json().find((candidate) => candidate.reference === line.reference) ?? null;
}

function reconcile(data, payment) {
  if (payment.status >= 300 || Math.random() >= 0.7) return;
  const { credentials: c } = data;
  const { id, kind, amount, contactName, date } = payment.json();
  const line = importLine(data, {
    date,
    description: `${kind === "receipt" ? "TRF DARI" : "TRF KE"} ${contactName.toUpperCase()}`,
    amount: kind === "receipt" ? amount : `-${amount}`,
    reference: id,
  });
  if (line) api(c, "POST", `/api/banking/lines/${line.id}/match`, "/api/banking/lines/{id}/match", { paymentId: id });
  if (Math.random() >= 0.1) return;
  const fee = importLine(data, {
    date,
    description: "BIAYA ADMINISTRASI",
    amount: "-6500.00",
    reference: `ADM-${Date.now()}-${__VU}`,
  });
  if (fee)
    api(c, "POST", `/api/banking/lines/${fee.id}/post`, "/api/banking/lines/{id}/post", { accountId: data.fees });
}

export function mistakes(data) {
  const { credentials: c } = data;
  const client = http.expectedStatuses({ min: 400, max: 499 });
  const today = jakarta();
  const roll = Math.random();
  if (roll < 0.25) {
    api(c, "GET", `/api/sales/invoices/${crypto.randomUUID()}`, "/api/sales/invoices/{id}", undefined, client);
  } else if (roll < 0.45) {
    api(
      c,
      "POST",
      "/api/sales/invoices",
      "/api/sales/invoices",
      {
        contactId: pick(data.vendors),
        issueDate: today,
        lines: [{ productId: pick(data.products), quantity: "1" }],
      },
      client,
    );
  } else if (roll < 0.65) {
    api(
      c,
      "POST",
      "/api/payments/",
      "/api/payments/",
      {
        kind: "receipt",
        contactId: pick(data.customers),
        date: today,
        cashAccountId: data.bank,
        amount: "-1",
        allocations: [],
      },
      client,
    );
  } else if (roll < 0.8) {
    api(
      c,
      "POST",
      `/api/banking/accounts/${data.bankAccount}/statements`,
      "/api/banking/accounts/{id}/statements",
      { lines: [{ date: today, description: "SALDO NOL", amount: "0.00" }] },
      client,
    );
  } else {
    const response = http.get(`${BASE}/api/ledger/journals`, {
      tags: { name: "GET /api/ledger/journals" },
      responseCallback: client,
    });
    check(response, { "GET /api/ledger/journals without a token is refused": (r) => r.status === 401 });
  }
}
