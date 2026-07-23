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
// ⚠️ interval은 "1m"/"1d"만 지원 확인됨(다른 값은 API가 allowedValues로 알려줌).
// 응답에 nextBefore 커서가 있어서 페이지네이션 파라미터(before 등)를 추정 테스트해봤으나
// 어떤 이름으로 넘겨도 조용히 무시되고 최신 구간만 반환됨 — 여러 날치 1분봉을 이어붙여
// 진짜 "60분봉"을 합성하는 건 현재 불가능함(app.js의 fetchIntradayCandles 참고).
router.get("/candles", async (req, res) => {
  const { symbol, interval = "1d", count = 180 } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol query param required" });

  try {
    const { ok, status, json } = await tossGet("/api/v1/candles", { symbol, interval, count });
    if (!ok) return res.status(status).json(json);
    res.json(json);
  } catch (e) {
    console.error("[RAVEN] /api/toss/candles error:", e);
    res.status(502).json({ error: "Toss candles proxy error" });
  }
});

// 종목 마스터 정보 조회 (해외종목 한글명 표시용 — symbol 필수, 이름 검색은 미지원)
router.get("/stock-info", async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol query param required" });

  try {
    const { ok, status, json } = await tossGet("/api/v1/stocks", { symbols: symbol });
    if (!ok) return res.status(status).json(json);
    res.json(json);
  } catch (e) {
    console.error("[RAVEN] /api/toss/stock-info error:", e);
    res.status(502).json({ error: "Toss stock-info proxy error" });
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
