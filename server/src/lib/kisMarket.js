const { getKisAccessToken } = require("./kisAuth");

const KIS_API_BASE = "https://openapi.koreainvestment.com:9443";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 해외 종목의 거래소 코드(NAS/NYS/AMS)는 심볼만으로 알 수 없어서 순서대로 시도해 알아냄.
// 서버가 살아있는 동안은 같은 심볼을 다시 조회할 때 재시도하지 않도록 캐싱.
const OVERSEAS_EXCHANGES = ["NAS", "NYS", "AMS"];
const overseasExchangeCache = new Map();
// 캔들 조회(fetchCandles)와 한글명 조회(fetchOverseasStockName)가 같은 심볼에 대해 거의 동시에
// resolveOverseasExchange를 부를 수 있어서(둘 다 Promise.all로 병렬 실행됨), 캐시가 비어있는
// 최초 조회 시 중복 API 호출이 나가는 걸 막기 위해 진행 중인 Promise 자체를 캐싱함
// (KIS 토큰 발급 때 겪었던 동시요청 중복 발급 버그와 같은 유형이라 미리 방지).
const overseasExchangeInFlight = new Map();

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

// ⚠️ 실제 버그(2026-08-04, 보원케미칼 검색 안 되는 문제 조사 중 발견): 순수 숫자 6자리만
// "국내"로 인식했는데, 스팩/최근 상장 종목 등 57개 종목은 KRX가 알파벳이 섞인 코드(예: "0010F0")를
// 씀 — 이 정규식에 안 걸려서 "해외"로 잘못 분류되고, 존재하지 않는 해외 거래소를 찾다가 에러가 났음
// (해외 티커는 전부 순수 알파벳이라 숫자가 하나도 없다는 점에 착안해 "숫자 하나 이상 포함"을
// 추가 조건으로 걸어서 진짜 해외 티커와 구분되도록 함).
function isDomesticSymbol(symbol) {
  return /^(?=.*\d)[0-9A-Za-z]{6}$/.test((symbol || "").trim());
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

// 2026-08-03 알고리즘 리뷰: 국내는 KIS가 60분봉 같은 인트라데이 간격을 안 줘서(1분봉·당일·
// 최대 30건뿐, 근본적 제약) 스윙 도구엔 애매한 프레임 공백이 있었음 — 그런데 같은 엔드포인트
// (inquire-daily-itemchartprice)가 FID_PERIOD_DIV_CODE만 "D"→"W"/"M"으로 바꾸면 주봉/월봉을
// 그대로 줌(실측 확인, 별도 인증·새 엔드포인트 불필요). 스윙(며칠~몇 주) 도구인 RAVEN에는
// 1분봉보다 주봉이 훨씬 적합한 중기 프레임이라 이걸로 공백을 메움.
async function fetchDomesticWeeklyCandles(symbol) {
  const json = await kisGet(
    "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
    "FHKST03010100",
    {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: symbol,
      FID_INPUT_DATE_1: "19900101",
      FID_INPUT_DATE_2: ymd(new Date()),
      FID_PERIOD_DIV_CODE: "W",
      FID_ORG_ADJ_PRC: "0",
    }
  );
  const rows = json.output2 || [];
  return rows.map((r) => ({
    date: r.stck_bsop_date,
    openPrice: Number(r.stck_oprc),
    closePrice: Number(r.stck_clpr),
    highPrice: Number(r.stck_hgpr),
    lowPrice: Number(r.stck_lwpr),
    volume: Number(r.acml_vol),
  }));
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

async function resolveOverseasExchangeUncached(symbol) {
  for (let i = 0; i < OVERSEAS_EXCHANGES.length; i++) {
    const excd = OVERSEAS_EXCHANGES[i];
    const json = await kisGet(
      "/uapi/overseas-price/v1/quotations/price",
      "HHDFS00000300",
      { AUTH: "", EXCD: excd, SYMB: symbol }
    );
    if (json.output && json.output.last) {
      return excd;
    }
    if (i < OVERSEAS_EXCHANGES.length - 1) await sleep(600);
  }

  throw new Error(`해외 종목 거래소를 찾을 수 없음: ${symbol}`);
}

async function resolveOverseasExchange(symbol) {
  if (overseasExchangeCache.has(symbol)) return overseasExchangeCache.get(symbol);
  if (overseasExchangeInFlight.has(symbol)) return overseasExchangeInFlight.get(symbol);

  const promise = resolveOverseasExchangeUncached(symbol)
    .then((excd) => {
      overseasExchangeCache.set(symbol, excd);
      overseasExchangeInFlight.delete(symbol);
      return excd;
    })
    .catch((e) => {
      overseasExchangeInFlight.delete(symbol);
      throw e;
    });

  overseasExchangeInFlight.set(symbol, promise);
  return promise;
}

// EXCD(거래소코드) → search-info API가 요구하는 PRDT_TYPE_CD. 현재 OVERSEAS_EXCHANGES가
// 미국 3개 거래소만 다뤄서 이 3개만 매핑(KIS 문서상 일본/홍콩/베트남/중국 코드도 있으나 미지원 범위).
const EXCD_TO_PRDT_TYPE_CD = { NAS: "512", NYS: "513", AMS: "529" };

// 해외 종목 한글명 조회 — KIS "해외주식 상품기본정보"(search-info)의 prdt_name 필드가
// 한글 종목명을 그대로 줌(실측 확인: FLNC→"플루언스 에너지", AAPL→"애플", TSLA→"테슬라").
// 값이 없는(신규상장 등) 종목도 있을 수 있어 없으면 null 반환 — 호출측이 티커로 폴백.
async function fetchOverseasStockName(symbol) {
  const trimmed = (symbol || "").trim().toUpperCase();
  const excd = await resolveOverseasExchange(trimmed);
  const prdtTypeCd = EXCD_TO_PRDT_TYPE_CD[excd];
  if (!prdtTypeCd) return null;

  await sleep(600);
  const json = await kisGet(
    "/uapi/overseas-price/v1/quotations/search-info",
    "CTPF1702R",
    { PRDT_TYPE_CD: prdtTypeCd, PDNO: trimmed }
  );
  const name = json.output && json.output.prdt_name;
  return name && name.trim() ? name.trim() : null;
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

// ---------- 분봉(당일 초단기 — "장중 실시간 흐름"용, 다일치 이력 아님) ----------
// 국내: 1분봉만, 당일만, 1회 호출 최대 30건(실측 확인, inquire-time-itemchartprice 국내 버전의
// 근본적 한계). 해외: 같은 이름의 엔드포인트지만 NMIN으로 분단위를 직접 지정 가능하고 다일치 이력도
// 되지만(위 fetchOverseasStockName 옆 60분봉 실측 참고), 여기선 "지금 장중 흐름"만 필요해서
// 1분봉·당일(PINC=0)·최대 120건만 받음 — calcIntradayMomentum()이 요구하는 최소 30개는 항상 충분히 확보됨.
function nowHHMMSS() {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const pad = (v) => String(v).padStart(2, "0");
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function fetchDomesticIntradayCandles(symbol) {
  const json = await kisGet(
    "/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice",
    "FHKST03010200",
    {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: symbol,
      FID_INPUT_HOUR_1: nowHHMMSS(),
      FID_PW_DATA_INCU_YN: "Y",
      FID_ETC_CLS_CODE: "",
    }
  );
  const rows = json.output2 || [];
  return rows.map((r) => ({
    date: r.stck_bsop_date,
    openPrice: Number(r.stck_oprc),
    closePrice: Number(r.stck_prpr),
    highPrice: Number(r.stck_hgpr),
    lowPrice: Number(r.stck_lwpr),
    volume: Number(r.cntg_vol),
  }));
}

// 2026-08-03 피드백 검토: 1분봉으로 RSI(14)를 계산하면 14분치 노이즈(마이크로스트럭처/HFT
// 지터)를 "모멘텀"으로 잘못 해석하기 쉬움 — RAVEN은 스윙(며칠~몇 주) 포지셔닝 도구라 그 타임프레임과
// 안 맞는 스캘핑용 지표였음. 해외는 KIS가 NMIN으로 60분봉을 직접 지원해서(실측 검증됨, 프로젝트
// 기록 참고) 노이즈를 줄인 60분봉으로 전환 — PINC=0으로 최근 NREC개(20개 = 대략 최근 2~3거래일치
// 세션)만 받아서 여전히 "최근 흐름" 정도의 스코프를 유지함(다일치 페이지네이션까지는 불필요).
async function fetchOverseasIntradayCandles(symbol) {
  const excd = await resolveOverseasExchange(symbol);
  await sleep(600);
  const json = await kisGet(
    "/uapi/overseas-price/v1/quotations/inquire-time-itemchartprice",
    "HHDFS76950200",
    { AUTH: "", EXCD: excd, SYMB: symbol, NMIN: "60", PINC: "0", NEXT: "", NREC: "20", FILL: "", KEYB: "" }
  );
  const rows = json.output2 || [];
  return rows.map((r) => ({
    date: r.xymd,
    openPrice: Number(r.open),
    closePrice: Number(r.last),
    highPrice: Number(r.high),
    lowPrice: Number(r.low),
    volume: Number(r.evol),
  }));
}

// 2026-08-09: 지지/저항 알고리즘에 60분봉을 반영해달라는 요청 — 위 fetchOverseasIntradayCandles는
// "당일 장중 흐름"(모멘텀 보조지표)용으로 PINC=0(당일치 최대 20건)만 받아서 스윙 고점/저점을 잡기엔
// 너무 짧음(하루~이틀치로는 노이즈와 진짜 스윙을 구분 못 함). 별도로 PINC=1 페이지네이션을 써서
// 여러 거래일치(페이지 2개 = 최대 240건 ≈ 최근 10~12거래일)를 모으는 전용 함수를 분리함 — 실측으로
// 페이지네이션 자체는 확인됨(KEYB에 마지막 봉의 날짜+시간을 그대로 넣어 다음 페이지 요청, output1.next
// 가 "1"이면 계속). 국내는 여전히 1분봉·당일 30건 한계(위 주석 참고)라 해외 전용으로 남겨둠.
// 페이지를 4개까지 더 늘릴 수도 있었지만(실측 확인), 검색 한 번마다 이미 여러 KIS 호출이 몰리는
// 상황에서 지연시간/레이트리밋 부담을 늘리는 것보다 2페이지(10~12거래일)로도 좌우 2봉 피벗
// 탐지엔 충분하다고 판단해 그 선에서 끊음.
async function fetchOverseasSwingIntraday(symbol) {
  const excd = await resolveOverseasExchange(symbol);
  let keyb = "";
  let allRows = [];

  for (let page = 0; page < 2; page++) {
    await sleep(600);
    const json = await kisGet(
      "/uapi/overseas-price/v1/quotations/inquire-time-itemchartprice",
      "HHDFS76950200",
      {
        AUTH: "",
        EXCD: excd,
        SYMB: symbol,
        NMIN: "60",
        PINC: "1",
        NEXT: page > 0 ? "1" : "",
        NREC: "120",
        FILL: "",
        KEYB: keyb,
      }
    );
    const rows = json.output2 || [];
    if (!rows.length) break;
    allRows = allRows.concat(rows);
    const last = rows[rows.length - 1];
    keyb = `${last.xymd}${last.xhms}`;
    if (json.output1?.next !== "1") break;
  }

  return allRows.map((r) => ({
    date: r.xymd,
    openPrice: Number(r.open),
    closePrice: Number(r.last),
    highPrice: Number(r.high),
    lowPrice: Number(r.low),
    volume: Number(r.evol),
  }));
}

// symbol만 보고 국내/해외 자동 판별해 최근 단기 캔들을 가져옴 (최신순 — 호출측이 chronological로
// 뒤집어 씀, 기존 fetchCandles와 같은 규약). 해외는 60분봉(위 주석 참고), 국내는 여전히 1분봉만
// 가능함 — 다만 국내는 1회 호출 최대 30건(=30분치)뿐이라 60분봉으로 리샘플링해도 1개 봉도 안 되는
// 양이라 의미 있는 신호가 안 나옴. 그 상태로 "장중 흐름이 엇갈립니다" 같은 문장을 넣는 건 30분
// 노이즈로 판단을 내리는 것과 같아서, 국내는 이 보조 지표 자체를 호출측(app.js)에서 건너뛰도록 함.
async function fetchIntradayCandles(symbol) {
  const trimmed = (symbol || "").trim();
  const rows = isDomesticSymbol(trimmed)
    ? await fetchDomesticIntradayCandles(trimmed)
    : await fetchOverseasIntradayCandles(trimmed.toUpperCase());

  if (!rows.length) throw new Error(`No intraday candle result for ${symbol}`);
  return rows;
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

// ───────── 코스피200 야간선물 (2026-08-04) ─────────
// KOSPI200 지수선물 종목코드는 "A01" + 만기연도 한 자리(끝자리) + 만기월(2자리, 03/06/09/12
// 분기물만 존재)로 구성됨 — KIS가 배포하는 종목마스터(fo_idx_code_mts.mst, 파이프 구분 텍스트)를
// 직접 받아 실측 확인함(예: "A01609"=2026년 9월물, "A01703"=2027년 3월물). 최근월물(가장 유동성
// 높은 물건)은 그 시점 기준 다음으로 돌아오는 분기월 — 아직 지나지 않은 가장 가까운 3/6/9/12월.
// ⚠️ 근사치: 실제 트레이더들은 만기 며칠~1주 전에 다음 물건으로 미리 갈아타지만(유동성 이유),
// 여기서는 달력상 분기 경계로만 근사함 — 만기 임박 마지막 주에는 실제 최근월물과 하루이틀
// 어긋날 수 있음(추후 필요시 종목마스터 파일을 주기적으로 받아 실제 순위를 확인하는 방식으로
// 개선 가능, 지금은 간단한 근사식으로 충분하다고 판단).
function currentKospiFuturesCode() {
  const kstNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" })
  );
  const year = kstNow.getFullYear();
  const month = kstNow.getMonth() + 1; // 1~12
  const quarterMonths = [3, 6, 9, 12];
  const frontMonth = quarterMonths.find((m) => m >= month);
  const yearDigit = year % 10;
  return `A01${yearDigit}${String(frontMonth).padStart(2, "0")}`;
}

// 국내지수선물시세(F) — TR FHMIF10000000. output1=선물 시세, output3=기초지수(KOSPI200) 현재가.
// 정규장/야간장 구분 없이 "지금 이 순간의 체결가"를 그대로 주는 엔드포인트라, 18:00~06:00 KST
// 야간거래 시간대에 호출하면 자연히 야간선물 시세가 됨(실측 확인 — 야간장 중 호출 시 실시간
// 체결가가 정상적으로 반영됨).
async function fetchKospiNightFutures() {
  const code = currentKospiFuturesCode();
  const json = await kisGet(
    "/uapi/domestic-futureoption/v1/quotations/inquire-price",
    "FHMIF10000000",
    { fid_cond_mrkt_div_code: "F", fid_input_iscd: code }
  );
  const o = json.output1 || {};
  const last = Number(o.futs_prpr);
  const prevClose = Number(o.futs_prdy_clpr);
  if (!Number.isFinite(last) || !Number.isFinite(prevClose)) {
    throw new Error("KOSPI200 야간선물 응답에 유효한 가격 필드가 없음");
  }
  return { code, lastClose: last, previousClose: prevClose };
}

module.exports = {
  fetchCandles,
  isDomesticSymbol,
  fetchOverseasStockName,
  fetchIntradayCandles,
  fetchOverseasSwingIntraday,
  fetchKospiNightFutures,
  fetchDomesticWeeklyCandles,
  resolveOverseasExchange,
};
