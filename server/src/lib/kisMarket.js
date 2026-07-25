const { getKisAccessToken } = require("./kisAuth");

const KIS_API_BASE = "https://openapi.koreainvestment.com:9443";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 해외 종목의 거래소 코드(NAS/NYS/AMS)는 심볼만으로 알 수 없어서 순서대로 시도해 알아냄.
// 서버가 살아있는 동안은 같은 심볼을 다시 조회할 때 재시도하지 않도록 캐싱.
const OVERSEAS_EXCHANGES = ["NAS", "NYS", "AMS"];
const overseasExchangeCache = new Map();

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
  // KIS는 HTTP 200이어도 본문 rt_cd로 성공/실패를 알려줌 (0=성공)
  if (!res.ok || (json && json.rt_cd !== undefined && json.rt_cd !== "0")) {
    throw new Error(`KIS API error (${trId}): HTTP ${res.status}, rt_cd=${json?.rt_cd}, msg=${json?.msg1}`);
  }
  return json;
}

function isDomesticSymbol(symbol) {
  return /^\d{6}$/.test((symbol || "").trim());
}

function ymd(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function shiftYmd(yyyymmdd, days) {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6)) - 1;
  const d = Number(yyyymmdd.slice(6, 8));
  const date = new Date(Date.UTC(y, m, d));
  date.setUTCDate(date.getUTCDate() + days);
  return ymd(date);
}

// ---------- 국내 ----------
// inquire-daily-itemchartprice는 요청 범위와 무관하게 최신 100건만 돌려줌.
// 200건 정도(EMA120 등 워밍업용) 확보하려면 종료일을 과거로 옮겨가며 2번 호출해야 함(실측 확인됨).

async function fetchDomesticCandleBatch(symbol, dateTo) {
  const json = await kisGet(
    "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
    "FHKST03010100",
    {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: symbol,
      FID_INPUT_DATE_1: "19900101",
      FID_INPUT_DATE_2: dateTo,
      FID_PERIOD_DIV_CODE: "D",
      FID_ORG_ADJ_PRC: "0",
    }
  );
  return json.output2 || [];
}

async function fetchDomesticCandles(symbol, count) {
  const batch1 = await fetchDomesticCandleBatch(symbol, ymd(new Date()));
  let rows = batch1;

  if (batch1.length && count > batch1.length) {
    const oldest = batch1[batch1.length - 1].stck_bsop_date;
    await sleep(600);
    const batch2 = await fetchDomesticCandleBatch(symbol, shiftYmd(oldest, -1));
    rows = rows.concat(batch2);
  }

  return rows.map((r) => ({
    date: r.stck_bsop_date,
    openPrice: Number(r.stck_oprc),
    closePrice: Number(r.stck_clpr),
    highPrice: Number(r.stck_hgpr),
    lowPrice: Number(r.stck_lwpr),
    volume: Number(r.acml_vol),
  }));
}

// ---------- 해외 ----------
// 현재가 조회로 거래소를 순서대로 시도(NAS→NYS→AMS) — 틀린 거래소를 넣어도 rt_cd=0(성공)에
// output 필드가 전부 빈 문자열로만 오기 때문에 output.last 값 존재 여부로 판단해야 함(실측 확인됨).

async function resolveOverseasExchange(symbol) {
  if (overseasExchangeCache.has(symbol)) return overseasExchangeCache.get(symbol);

  for (let i = 0; i < OVERSEAS_EXCHANGES.length; i++) {
    const excd = OVERSEAS_EXCHANGES[i];
    const json = await kisGet(
      "/uapi/overseas-price/v1/quotations/price",
      "HHDFS00000300",
      { AUTH: "", EXCD: excd, SYMB: symbol }
    );
    if (json.output && json.output.last) {
      overseasExchangeCache.set(symbol, excd);
      return excd;
    }
    if (i < OVERSEAS_EXCHANGES.length - 1) await sleep(600);
  }

  throw new Error(`해외 종목 거래소를 찾을 수 없음: ${symbol}`);
}

async function fetchOverseasCandleBatch(symbol, excd, bymd) {
  const json = await kisGet(
    "/uapi/overseas-price/v1/quotations/dailyprice",
    "HHDFS76240000",
    { AUTH: "", EXCD: excd, SYMB: symbol, GUBN: "0", BYMD: bymd || "", MODP: "0" }
  );
  return json.output2 || [];
}

async function fetchOverseasCandles(symbol, count) {
  const excd = await resolveOverseasExchange(symbol);
  await sleep(600);

  const batch1 = await fetchOverseasCandleBatch(symbol, excd, "");
  let rows = batch1;

  if (batch1.length && count > batch1.length) {
    const oldest = batch1[batch1.length - 1].xymd;
    await sleep(600);
    const batch2 = await fetchOverseasCandleBatch(symbol, excd, oldest);
    // BYMD 기준일 자체가 양쪽 배치에 중복으로 걸릴 수 있어 날짜 기준으로 중복 제거
    const seen = new Set(rows.map((r) => r.xymd));
    rows = rows.concat(batch2.filter((r) => !seen.has(r.xymd)));
  }

  return rows.map((r) => ({
    date: r.xymd,
    openPrice: Number(r.open),
    closePrice: Number(r.clos),
    highPrice: Number(r.high),
    lowPrice: Number(r.low),
    volume: Number(r.tvol),
  }));
}

// ---------- 공용 ----------

// symbol만 보고 국내/해외 자동 판별해 일봉 캔들을 가져옴 (최신순, count 이상 확보 시도).
// 반환 형태는 기존 토스 캔들 응답과 동일한 필드명(openPrice/closePrice/highPrice/lowPrice/volume)을 써서
// app.js와 signalDetector.js가 최소한의 변경으로 그대로 재사용할 수 있게 함.
async function fetchCandles(symbol, count = 180) {
  const trimmed = (symbol || "").trim();
  const rows = isDomesticSymbol(trimmed)
    ? await fetchDomesticCandles(trimmed, count)
    : await fetchOverseasCandles(trimmed.toUpperCase(), count);

  if (!rows.length) throw new Error(`No candle result for ${symbol}`);
  return rows;
}

module.exports = { fetchCandles, isDomesticSymbol };
