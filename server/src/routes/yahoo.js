const express = require("express");
const router = express.Router();

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

module.exports = router;
