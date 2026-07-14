const express = require("express");
const router = express.Router();
const { getTossAccessToken } = require("../lib/tossAuth");

const TOSS_API_BASE = "https://openapi.tossinvest.com";

async function tossGet(path, query = {}) {
  const token = await getTossAccessToken();
  const qs = new URLSearchParams(query).toString();
  const url = `${TOSS_API_BASE}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  return { ok: res.ok, status: res.status, json };
}

// 종목 현재가 조회 (국내/해외 공용 — symbol이 KR 6자리 코드인지 US 티커인지는 호출측에서 결정)
router.get("/prices", async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol query param required" });

  try {
    const { ok, status, json } = await tossGet("/api/v1/prices", { symbols: symbol });
    if (!ok) return res.status(status).json(json);
    res.json(json);
  } catch (e) {
    console.error("[RAVEN] /api/toss/prices error:", e);
    res.status(502).json({ error: "Toss prices proxy error" });
  }
});

// 종목 캔들(OHLCV) 차트 조회 (국내/해외 공용)
router.get("/candles", async (req, res) => {
  const { symbol, interval = "1d", count = 180 } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol query param required" });

  try {
    const { ok, status, json } = await tossGet("/api/v1/candles", {
      symbol,
      interval,
      count,
    });
    if (!ok) return res.status(status).json(json);
    res.json(json);
  } catch (e) {
    console.error("[RAVEN] /api/toss/candles error:", e);
    res.status(502).json({ error: "Toss candles proxy error" });
  }
});

// 환율 조회 (예: base=USD, quote=KRW)
router.get("/exchange-rate", async (req, res) => {
  const { base = "USD", quote = "KRW" } = req.query;

  try {
    const { ok, status, json } = await tossGet("/api/v1/exchange-rate", {
      baseCurrency: base,
      quoteCurrency: quote,
    });
    if (!ok) return res.status(status).json(json);
    res.json(json);
  } catch (e) {
    console.error("[RAVEN] /api/toss/exchange-rate error:", e);
    res.status(502).json({ error: "Toss exchange-rate proxy error" });
  }
});

module.exports = router;
