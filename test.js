const axios = require("axios");
const crypto = require("crypto");
const UserAgents = require("user-agents");

const BASE_URL = process.env.GOBIZ_API_BASE || "https://api.gobiz.co.id";

const sessions = new Map();
const refreshTimers = new Map();
const mutasiTimers = new Map();

function createSession(userId) {
  const session = {
    userId,
    accessToken: null,
    refreshToken: null,
    tokenExpiry: null,
    uniqueId: crypto.randomUUID(),
    ua: new UserAgents({ deviceCategory: "desktop" }).toString(),
    lastRequestTime: 0,
    minRequestInterval: 2000,
    seenTx: new Set(),
  };
  sessions.set(userId, session);
  return session;
}

function getSession(userId) {
  if (!sessions.has(userId)) return createSession(userId);
  return sessions.get(userId);
}

async function waitRate(session) {
  const diff = Date.now() - session.lastRequestTime;
  if (diff < session.minRequestInterval) {
    await new Promise(r => setTimeout(r, session.minRequestInterval - diff));
  }
  session.lastRequestTime = Date.now();
}

function baseHeaders(session) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "id",
    Origin: "https://portal.gofoodmerchant.co.id",
    Referer: "https://portal.gofoodmerchant.co.id/",
    "Authentication-Type": "go-id",
    "Gojek-Country-Code": "ID",
    "Gojek-Timezone": "Asia/Jakarta",
    "X-Appid": "go-biz-web-dashboard",
    "X-Appversion": "platform-v3.97.0-b986b897",
    "X-Deviceos": "Web",
    "X-Phonemake": "Windows 10 64-bit",
    "X-Phonemodel": "Chrome 143.0.0.0 on Windows 10 64-bit",
    "X-Platform": "Web",
    "X-Uniqueid": session.uniqueId,
    "X-User-Type": "merchant",
    "User-Agent": session.ua,
  };
}

function tokenInvalid(session) {
  if (!session.accessToken || !session.tokenExpiry) return true;
  return Date.now() > session.tokenExpiry - 5 * 60 * 1000;
}

async function refreshToken(session) {
  if (!session.refreshToken) throw new Error("NO_REFRESH_TOKEN");
  await waitRate(session);

  const res = await axios.post(
    `${BASE_URL}/goid/token`,
    {
      client_id: "go-biz-web-new",
      grant_type: "refresh_token",
      data: { refresh_token: session.refreshToken, user_type: "merchant" },
    },
    { headers: baseHeaders(session) }
  );

  session.accessToken = res.data.access_token;
  session.refreshToken = res.data.refresh_token || session.refreshToken;
  session.tokenExpiry = Date.now() + (res.data.expires_in || 3600) * 1000;
}

function startAutoRefresh(userId) {
  if (refreshTimers.has(userId)) return;
  const session = getSession(userId);

  const t = setInterval(async () => {
    try {
      if (tokenInvalid(session)) {
        await refreshToken(session);
      }
    } catch {
      session.accessToken = null;
      session.refreshToken = null;
      session.tokenExpiry = null;
    }
  }, 60 * 1000);

  refreshTimers.set(userId, t);
}

async function authRequest(userId, method, url, data, extraHeaders = {}) {
  const session = getSession(userId);
  if (tokenInvalid(session)) await refreshToken(session);
  await waitRate(session);

  let res = await axios.request({
    method,
    url,
    data,
    headers: { ...baseHeaders(session), Authorization: `Bearer ${session.accessToken}`, ...extraHeaders },
  });

  if (res.status === 401) {
    await refreshToken(session);
    await waitRate(session);
    res = await axios.request({
      method,
      url,
      data,
      headers: { ...baseHeaders(session), Authorization: `Bearer ${session.accessToken}`, ...extraHeaders },
    });
  }

  if (res.status < 200 || res.status >= 300) throw res.data;
  return res.data;
}

function toRupiahFromSen(valueSen) {
  const n = typeof valueSen === "string" ? Number(valueSen) : valueSen;
  if (!Number.isFinite(n)) return 0;
  return Math.round(n / 100);
}

function formatRupiah(valueRupiah) {
  const n = typeof valueRupiah === "string" ? Number(valueRupiah) : valueRupiah;
  if (!Number.isFinite(n)) return "Rp 0";
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR" }).format(n);
}

function pickAmountSen(tx) {
  const t = tx?.metadata?.transaction || {};
  const v =
    t.gross_amount ??
    t.amount ??
    t.total_amount ??
    t.gopay_amount ??
    t.gopay?.amount ??
    t.gopay?.gross_amount ??
    t.details?.amount ??
    t.details?.gross_amount;
  return typeof v === "string" ? Number(v) : v;
}

function normalizeTx(tx) {
  const t = tx?.metadata?.transaction || {};
  const amountSen = pickAmountSen(tx);
  const amountRupiah = toRupiahFromSen(amountSen);
  return {
    raw: tx,
    id: tx?.id || tx?._id || t?.order_id || t?.transaction_id || null,
    orderId: t?.order_id || null,
    transactionId: t?.transaction_id || null,
    time: t?.transaction_time || tx?.time || null,
    status: t?.status || null,
    paymentType: t?.payment_type || null,
    amountSen: Number.isFinite(amountSen) ? amountSen : null,
    amount: amountRupiah,
    amountFormatted: formatRupiah(amountRupiah),
  };
}

async function emailLogin(userId, email, password) {
  const session = getSession(userId);
  await waitRate(session);

  await axios.post(
    `${BASE_URL}/goid/login/request`,
    { email, login_type: "password", client_id: "go-biz-web-new" },
    { headers: baseHeaders(session) }
  );

  await new Promise(r => setTimeout(r, 3000));
  await waitRate(session);

  const res = await axios.post(
    `${BASE_URL}/goid/token`,
    {
      client_id: "go-biz-web-new",
      grant_type: "password",
      data: { email, password, user_type: "merchant" },
    },
    { headers: baseHeaders(session) }
  );

  session.accessToken = res.data.access_token;
  session.refreshToken = res.data.refresh_token;
  session.tokenExpiry = Date.now() + (res.data.expires_in || 3600) * 1000;

  startAutoRefresh(userId);
}

async function requestOTP(userId, phone, countryCode = "62") {
  const session = getSession(userId);
  await waitRate(session);

  const res = await axios.post(
    `${BASE_URL}/goid/login/request`,
    { client_id: "go-biz-web-new", phone_number: phone, country_code: countryCode },
    { headers: { ...baseHeaders(session), Authorization: "Bearer" } }
  );

  return res.data.data;
}

async function verifyOTP(userId, otp, otpToken) {
  const session = getSession(userId);
  await waitRate(session);

  const res = await axios.post(
    `${BASE_URL}/goid/token`,
    {
      client_id: "go-biz-web-new",
      grant_type: "otp",
      data: { otp, otp_token: otpToken },
    },
    { headers: { ...baseHeaders(session), Authorization: "Bearer" } }
  );

  session.accessToken = res.data.access_token;
  session.refreshToken = res.data.refresh_token;
  session.tokenExpiry = Date.now() + (res.data.expires_in || 3600) * 1000;

  startAutoRefresh(userId);
}

async function getMerchantId(userId) {
  const r = await authRequest(
    userId,
    "POST",
    `${BASE_URL}/v1/merchants/search`,
    { from: 0, to: 1, _source: ["id"] }
  );
  return r.hits[0].id;
}

async function searchJournals(userId, merchantId, fromISO, toISO) {
  return authRequest(
    userId,
    "POST",
    `${BASE_URL}/journals/search`,
    {
      from: 0,
      size: 50,
      sort: { time: { order: "desc" } },
      included_categories: { incoming: ["transaction_share", "action"] },
      query: [{
        op: "and",
        clauses: [
          { field: "metadata.transaction.merchant_id", op: "equal", value: merchantId },
          { field: "metadata.transaction.transaction_time", op: "gte", value: fromISO },
          { field: "metadata.transaction.transaction_time", op: "lte", value: toISO },
        ],
      }],
    },
    { Accept: "application/json, application/vnd.journal.v1+json" }
  );
}

function startMutasiListener(userId, merchantId, onTx, intervalMs = 15000) {
  if (mutasiTimers.has(userId)) return;

  const session = getSession(userId);

  const t = setInterval(async () => {
    try {
      const d = new Date().toISOString().slice(0, 10);
      const data = await searchJournals(
        userId,
        merchantId,
        `${d}T00:00:00+07:00`,
        `${d}T23:59:59+07:00`
      );

      for (const tx of data.hits || []) {
        const norm = normalizeTx(tx);
        const key = norm.id || JSON.stringify([norm.time, norm.amountSen, norm.status, norm.paymentType, norm.orderId]);
        if (session.seenTx.has(key)) continue;
        session.seenTx.add(key);
        onTx(norm);
      }
    } catch {}
  }, intervalMs);

  mutasiTimers.set(userId, t);
}

module.exports = {
  emailLogin,
  requestOTP,
  verifyOTP,
  getMerchantId,
  startMutasiListener,
  normalizeTx,
  formatRupiah,
  toRupiahFromSen,
};
