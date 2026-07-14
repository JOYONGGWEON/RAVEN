const express = require("express");
const router = express.Router();
const { searchStocksByName, getStockNameByCode } = require("../lib/stockDirectory");

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

// 종목코드 → 종목명 조회
router.get("/name", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: "code query param required" });

  try {
    const name = await getStockNameByCode(code);
    res.json({ code, name });
  } catch (e) {
    console.error("[RAVEN] /api/stocks/name error:", e);
    res.status(502).json({ error: "stock directory error" });
  }
});

module.exports = router;
