const { getKisAccessToken } = require("./kisAuth");
const { isDomesticSymbol, resolveOverseasExchange } = require("./kisMarket");

const KIS_API_BASE = "https://openapi.koreainvestment.com:9443";

// 다른 lib 파일들과 같은 방식 — 파일마다 자체 kisGet을 두는 기존 컨벤션 그대로 따름.
async function kisGet(path, trId, query) {
  const token = await getKisAccessToken();
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`${KIS_API_BASE}${path}?${qs}`, {
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
  if (!res.ok || (json && json.rt_cd !== undefined && json.rt_cd !== "0")) {
    throw new Error(`KIS API error (${trId}): HTTP ${res.status}, rt_cd=${json?.rt_cd}, msg=${json?.msg1}`);
  }
  return json;
}

function toDateStr(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) return null;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}
function toTimeStr(hhmmss) {
  if (!hhmmss || hhmmss.length < 4) return null;
  return `${hhmmss.slice(0, 2)}:${hhmmss.slice(2, 4)}`;
}

// 국내 종목 뉴스(종합 시황/공시 제목) — TR FHKST01011800. 종목코드로 필터링됨(실측 확인).
async function fetchDomesticNews(symbol) {
  const json = await kisGet(
    "/uapi/domestic-stock/v1/quotations/news-title",
    "FHKST01011800",
    {
      FID_NEWS_OFER_ENTP_CODE: "",
      FID_COND_MRKT_CLS_CODE: "",
      FID_INPUT_ISCD: symbol,
      FID_TITL_CNTT: "",
      FID_INPUT_DATE_1: "",
      FID_INPUT_HOUR_1: "",
      FID_RANK_SORT_CLS_CODE: "",
      FID_INPUT_SRNO: "",
    }
  );
  const rows = json.output || [];
  return rows.map((r) => ({
    date: toDateStr(r.data_dt),
    time: toTimeStr(r.data_tm),
    title: r.hts_pbnt_titl_cntt,
    source: r.dorg,
  }));
}

// 해외 종목 뉴스(해외뉴스종합 제목) — TR HHPSTH60100C1. ⚠️ 실측으로 확인: EXCHANGE_CD를 비워두면
// 결과 자체가 텅 빔(전체 뉴스 목록에서 종목 필터링이 안 걸림) — NATION_CD="US"만으론 부족하고
// EXCHANGE_CD(NAS 등)까지 같이 넣어야 특정 종목 뉴스로 필터링됨. 기존 fetchCandles가 쓰는
// resolveOverseasExchange()를 그대로 재사용(중복 로직 없음, 거래소 캐싱도 그대로 적용됨).
async function fetchOverseasNews(symbol) {
  const excd = await resolveOverseasExchange(symbol);
  const json = await kisGet(
    "/uapi/overseas-price/v1/quotations/news-title",
    "HHPSTH60100C1",
    {
      INFO_GB: "",
      CLASS_CD: "",
      NATION_CD: "US",
      EXCHANGE_CD: excd,
      SYMB: symbol,
      DATA_DT: "",
      DATA_TM: "",
      CTS: "",
    }
  );
  const rows = json.outblock1 || [];
  return rows.map((r) => ({
    date: toDateStr(r.data_dt),
    time: toTimeStr(r.data_tm),
    title: r.title,
    source: r.source,
  }));
}

// symbol만 보고 국내/해외 자동 판별해 종목 뉴스를 가져옴(최신순 — KIS 응답이 이미 최신순으로 옴,
// 실측 확인). 국내/해외 모두 KIS 하나로 커버되어 별도 뉴스 API(DART/네이버 등) 불필요.
async function fetchNews(symbol) {
  const trimmed = (symbol || "").trim();
  return isDomesticSymbol(trimmed)
    ? await fetchDomesticNews(trimmed)
    : await fetchOverseasNews(trimmed.toUpperCase());
}

module.exports = { fetchNews };
