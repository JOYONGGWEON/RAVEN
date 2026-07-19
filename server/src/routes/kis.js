const express = require("express");
const router = express.Router();
const { getKisAccessToken } = require("../lib/kisAuth");
const { collectSupplyDemandForSymbol } = require("../lib/supplyDemandCollector");

const KIS_API_BASE = "https://openapi.koreainvestment.com:9443";

async function kisGet(path, trId, query = {}) {
  const token = await getKisAccessToken();
  const qs = new URLSearchParams(query).toString();
  const url = `${KIS_API_BASE}${path}${qs ? `?${qs}` : ""}`;

  const res = await fetch(url, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
      tr_id: trId,
      custtype: "P",
    },
  });

  const json = await res.json();
  return { ok: res.ok, status: res.status, json };
}

// 종목별 프로그램매매추이(일별)
router.get("/program-trade", async (req, res) => {
  const { symbol, date } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol query param required" });

  try {
    const { ok, status, json } = await kisGet(
      "/uapi/domestic-stock/v1/quotations/program-trade-by-stock-daily",
      "FHPPG04650201",
      {
        FID_COND_MRKT_DIV_CODE: "J",
        FID_INPUT_ISCD: symbol,
        FID_INPUT_DATE_1: date || "",
      }
    );
    if (!ok) return res.status(status).json(json);
    res.json(json);
  } catch (e) {
    console.error("[RAVEN] /api/kis/program-trade error:", e);
    res.status(502).json({ error: "KIS program-trade proxy error" });
  }
});

// 국내주식 공매도 일별추이
router.get("/short-sale", async (req, res) => {
  const { symbol, from, to } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol query param required" });

  try {
    const { ok, status, json } = await kisGet(
      "/uapi/domestic-stock/v1/quotations/daily-short-sale",
      "FHPST04830000",
      {
        FID_COND_MRKT_DIV_CODE: "J",
        FID_INPUT_ISCD: symbol,
        FID_INPUT_DATE_1: from || "",
        FID_INPUT_DATE_2: to || "",
      }
    );
    if (!ok) return res.status(status).json(json);
    res.json(json);
  } catch (e) {
    console.error("[RAVEN] /api/kis/short-sale error:", e);
    res.status(502).json({ error: "KIS short-sale proxy error" });
  }
});

// 국내주식 신용잔고 일별추이
router.get("/credit-balance", async (req, res) => {
  const { symbol, date } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol query param required" });

  try {
    const { ok, status, json } = await kisGet(
      "/uapi/domestic-stock/v1/quotations/daily-credit-balance",
      "FHPST04760000",
      {
        fid_cond_mrkt_div_code: "J",
        fid_cond_scr_div_code: "20476",
        fid_input_iscd: symbol,
        fid_input_date_1: date || "",
      }
    );
    if (!ok) return res.status(status).json(json);
    res.json(json);
  } catch (e) {
    console.error("[RAVEN] /api/kis/credit-balance error:", e);
    res.status(502).json({ error: "KIS credit-balance proxy error" });
  }
});

// 종목별 일별 대차거래추이
router.get("/loan-trans", async (req, res) => {
  const { symbol, from, to } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol query param required" });

  try {
    const { ok, status, json } = await kisGet(
      "/uapi/domestic-stock/v1/quotations/daily-loan-trans",
      "HHPST074500C0",
      {
        MRKT_DIV_CLS_CODE: "3",
        MKSC_SHRN_ISCD: symbol,
        START_DATE: from || "",
        END_DATE: to || "",
        CTS: "",
      }
    );
    if (!ok) return res.status(status).json(json);
    res.json(json);
  } catch (e) {
    console.error("[RAVEN] /api/kis/loan-trans error:", e);
    res.status(502).json({ error: "KIS loan-trans proxy error" });
  }
});

// 스케줄러가 실제로 도는지 수동으로 즉시 트리거 (테스트/디버그용)
router.post("/collect-now", async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol query param required" });

  try {
    const result = await collectSupplyDemandForSymbol(symbol);
    res.json(result);
  } catch (e) {
    console.error("[RAVEN] /api/kis/collect-now error:", e);
    res.status(502).json({ error: "collect-now error" });
  }
});

module.exports = router;
