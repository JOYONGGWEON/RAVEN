const express = require("express");
const router = express.Router();
const { getKisAccessToken } = require("../lib/kisAuth");
const { collectSupplyDemandForSymbol } = require("../lib/supplyDemandCollector");
const { interpretSupplyDemand } = require("../lib/supplyDemandInterpreter");
const {
  fetchCandles,
  fetchOverseasStockName,
  fetchIntradayCandles,
  fetchDomesticWeeklyCandles,
  isDomesticSymbol,
} = require("../lib/kisMarket");
const { fetchIncomeStatement } = require("../lib/kisFundamentals");
const { fetchNews } = require("../lib/kisNews");

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

// 종목 캔들(OHLCV) 조회 — 국내(6자리 코드)/해외(티커) 자동 판별, 토스 응답과 같은 형태로 반환
// interval=1d(일봉, 기본) 또는 1m(장중 초단기 흐름 보조지표용, 2026-07-31 KIS 실측 후 활성화).
// ⚠️ 파라미터 이름은 "1m"이지만 2026-08-03부터 해외는 실제로 60분봉을 받아옴(kisMarket.js의
// fetchIntradayCandles 참고 — 1분봉이 스윙 타임프레임엔 너무 노이즈가 많다는 피드백으로 전환,
// 하위 호환을 위해 쿼리 파라미터명은 그대로 둠). 국내는 여전히 1분봉·당일·최대 30건뿐이라
// 60분봉으로 바꿀 수 없어서 app.js에서 이 보조지표 자체를 호출하지 않도록 함.
router.get("/candles", async (req, res) => {
  const { symbol, count = 180, interval = "1d" } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol query param required" });
  if (interval !== "1d" && interval !== "1m") {
    return res.status(400).json({ error: "only interval=1d or 1m is supported" });
  }

  try {
    const candles =
      interval === "1m"
        ? await fetchIntradayCandles(symbol)
        : await fetchCandles(symbol, Number(count) || 180);
    res.json({ result: { candles } });
  } catch (e) {
    console.error("[RAVEN] /api/kis/candles error:", e);
    res.status(502).json({ error: "KIS candles proxy error" });
  }
});

// 국내 종목 주봉(FID_PERIOD_DIV_CODE=W) — 2026-08-03 알고리즘 리뷰: 국내는 인트라데이 간격
// 확장이 안 돼서(위 /candles 주석 참고) 스윙 도구엔 중기 프레임 공백이 있었는데, 일봉과 같은
// 엔드포인트가 그대로 주봉을 줌(실측 확인) — 국내 전용, 해외는 이미 60분봉으로 커버됨.
router.get("/weekly-candles", async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol query param required" });
  if (!isDomesticSymbol(symbol)) {
    return res.status(400).json({ error: "weekly-candles only supports domestic symbols" });
  }

  try {
    const candles = await fetchDomesticWeeklyCandles(symbol);
    res.json({ result: { candles } });
  } catch (e) {
    console.error("[RAVEN] /api/kis/weekly-candles error:", e);
    res.status(502).json({ error: "KIS weekly-candles proxy error" });
  }
});

// 국내 종목 분기별 손익계산서(매출액/영업이익/당기순이익) — Phase 5(실적 그래프)용, 국내 전용
router.get("/income-statement", async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol query param required" });

  try {
    const quarters = await fetchIncomeStatement(symbol);
    res.json({ result: { quarters } });
  } catch (e) {
    console.error("[RAVEN] /api/kis/income-statement error:", e);
    res.status(502).json({ error: "KIS income-statement proxy error" });
  }
});

// 종목 뉴스(국내: 종합 시황/공시 제목, 해외: 해외뉴스종합 제목) — DART/네이버뉴스 없이 KIS로 통합
router.get("/news", async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol query param required" });

  try {
    const news = await fetchNews(symbol);
    res.json({ result: { news } });
  } catch (e) {
    console.error("[RAVEN] /api/kis/news error:", e);
    res.status(502).json({ error: "KIS news proxy error" });
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
