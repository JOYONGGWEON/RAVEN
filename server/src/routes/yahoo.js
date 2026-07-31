const express = require("express");
const router = express.Router();
const { fetchOverseasIncomeStatement } = require("../lib/yahooFundamentals");

const YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart/";

// corsproxy.io를 거치던 걸 서버가 직접 Yahoo Finance를 호출하도록 대체.
// 브라우저가 아닌 서버가 요청하므로 CORS 문제가 없고, 공개 프록시 의존도 사라짐.
const YAHOO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

router.get("/chart", async (req, res) => {
  const { symbol, range = "1d", interval = "1d" } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol query param required" });

  try {
    const url = `${YAHOO_CHART_BASE}${encodeURIComponent(symbol)}?range=${encodeURIComponent(
      range
    )}&interval=${encodeURIComponent(interval)}`;
    const response = await fetch(url, { headers: YAHOO_HEADERS });
    if (!response.ok) {
      return res.status(response.status).json({ error: "Yahoo chart request failed" });
    }
    const json = await response.json();
    res.json(json);
  } catch (e) {
    console.error("[RAVEN] /api/yahoo/chart error:", e);
    res.status(502).json({ error: "Yahoo chart proxy error" });
  }
});

// 환율(USD/KRW) — Yahoo KRW=X. 지연/무료 데이터라 매크로 지표와 동일한 성격(장중 실시간 트레이딩용 아님)
router.get("/exchange-rate", async (req, res) => {
  try {
    const url = `${YAHOO_CHART_BASE}KRW=X?range=1d&interval=1d`;
    const response = await fetch(url, { headers: YAHOO_HEADERS });
    if (!response.ok) {
      return res.status(response.status).json({ error: "Yahoo exchange-rate request failed" });
    }
    const json = await response.json();
    const meta = json?.chart?.result?.[0]?.meta;
    const rate = typeof meta?.regularMarketPrice === "number" ? meta.regularMarketPrice : null;
    if (rate == null) return res.status(502).json({ error: "No exchange rate in Yahoo response" });
    res.json({ result: { rate } });
  } catch (e) {
    console.error("[RAVEN] /api/yahoo/exchange-rate error:", e);
    res.status(502).json({ error: "Yahoo exchange-rate proxy error" });
  }
});

// 해외 종목 분기별 손익계산서 (Phase 5, 5단계) — KIS의 income-statement 엔드포인트와 같은
// 응답 모양({ result: { quarters } })으로 맞춰서 프론트가 렌더링 로직을 그대로 재사용할 수 있게 함.
router.get("/income-statement", async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol query param required" });

  try {
    const quarters = await fetchOverseasIncomeStatement(symbol.toUpperCase());
    res.json({ result: { quarters } });
  } catch (e) {
    console.error("[RAVEN] /api/yahoo/income-statement error:", e);
    res.status(502).json({ error: "Yahoo income-statement proxy error" });
  }
});

module.exports = router;
