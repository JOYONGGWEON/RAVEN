const express = require("express");
const router = express.Router();
const { searchStocksByName, getStockInfoByCode } = require("../lib/stockDirectory");

// 국내 종목명으로 검색 (자동완성용)
router.get("/search", async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ result: [] });

  try {
    const result = await searchStocksByName(q);
    res.json({ result });
  } catch (e) {
    console.error("[RAVEN] /api/stocks/search error:", e);
    res.status(502).json({ error: "stock directory error" });
  }
});

// 종목코드 → 종목명 + 시장구분(KOSPI/KOSDAQ) 조회 — market은 관심종목 뱃지 표시용(2026-08-09 추가)
router.get("/name", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: "code query param required" });

  try {
    const info = await getStockInfoByCode(code);
    res.json({ code, name: info?.name || null, market: info?.market || null });
  } catch (e) {
    console.error("[RAVEN] /api/stocks/name error:", e);
    res.status(502).json({ error: "stock directory error" });
  }
});

module.exports = router;
