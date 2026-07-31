const express = require("express");
const router = express.Router();
const { getKisAccessToken } = require("../lib/kisAuth");
const { collectSupplyDemandForSymbol } = require("../lib/supplyDemandCollector");
const { interpretSupplyDemand } = require("../lib/supplyDemandInterpreter");
const { fetchCandles, fetchOverseasStockName } = require("../lib/kisMarket");

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

// 종목 캔들(OHLCV) 일봉 조회 — 국내(6자리 코드)/해외(티커) 자동 판별, 토스 응답과 같은 형태로 반환
// ⚠️ 일봉(1d)만 지원. 분봉은 KIS 쪽 미검증이라 일부러 400을 줘서 호출측(app.js)의 기존
// 실패시 null 폴백 로직을 그대로 타게 함 — 다른 데이터를 분봉인 것처럼 잘못 주는 것보단 안전.
router.get("/candles", async (req, res) => {
  const { symbol, count = 180, interval = "1d" } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol query param required" });
  if (interval !== "1d") {
    return res.status(400).json({ error: "only interval=1d is supported" });
  }

  try {
    const candles = await fetchCandles(symbol, Number(count) || 180);
    res.json({ result: { candles } });
  } catch (e) {
    console.error("[RAVEN] /api/kis/candles error:", e);
    res.status(502).json({ error: "KIS candles proxy error" });
  }
});

// 해외 종목 한글명 조회 (예: FLNC → 플루언스 에너지) — 없으면 name: null (호출측이 티커로 폴백)
router.get("/overseas-name", async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol query param required" });

  try {
    const name = await fetchOverseasStockName(symbol);
    res.json({ name });
  } catch (e) {
    console.error("[RAVEN] /api/kis/overseas-name error:", e);
    res.status(502).json({ error: "overseas name lookup error" });
  }
});

// 전일 수급 4종 → 오늘 해석 + 내일 예상 코멘트
router.get("/supply-demand", async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol query param required" });

  try {
    const result = await interpretSupplyDemand(symbol);
    res.json(result);
  } catch (e) {
    console.error("[RAVEN] /api/kis/supply-demand error:", e);
    res.status(502).json({ error: "supply-demand interpret error" });
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
