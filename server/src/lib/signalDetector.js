const { fetchCandles: fetchKisCandles, isDomesticSymbol } = require("./kisMarket");
const {
  getInvestorTrendHistory,
  computeStreak,
  getComboSupplyDemandSignal,
} = require("./supplyDemandInterpreter");

// 관심종목 알림 전용 캔들 조회 — 프론트(app.js)의 fetchCandleData와 같은 응답 구조를 다루지만,
// 서버 스케줄러에서 직접 KIS를 호출해야 해서(브라우저 전용 app.js는 require 불가) 별도로 둠.
async function fetchCandles(symbol) {
  const candles = await fetchKisCandles(symbol, 180);

  const chronological = [...candles].reverse();
  const opens = [];
  const closes = [];
  const volumes = [];

  for (const c of chronological) {
    const o = Number(c.openPrice);
    const cl = Number(c.closePrice);
    const v = Number(c.volume);
    if ([o, cl, v].some((n) => Number.isNaN(n))) continue;
    opens.push(o);
    closes.push(cl);
    volumes.push(v);
  }

  if (closes.length < 61) throw new Error("Not enough candle history for MA60");
  return { opens, closes, volumes };
}

// EMA "시리즈" — 크로스오버 감지는 어제/오늘 두 시점의 MA가 다 있어야 하므로
// 마지막 값 하나만 주는 EMA로는 부족함 (app.js의 calcEMASeries와 같은 방식)
function calcEMASeries(values, period) {
  const len = values.length;
  if (len < period) return null;
  const k = 2 / (period + 1);
  const series = new Array(len).fill(null);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let ema = sum / period;
  series[period - 1] = ema;
  for (let i = period; i < len; i++) {
    ema = values[i] * k + ema * (1 - k);
    series[i] = ema;
  }
  return series;
}

// 골든/데드크로스는 "상태"가 아니라 "오늘 막 일어난 사건"이어야 알림 스팸이 안 남 —
// 그래서 어제 대비 오늘의 MA20 vs MA60 대소관계가 뒤집혔는지만 확인함
function detectMACross(closes) {
  const ma20Series = calcEMASeries(closes, 20);
  const ma60Series = calcEMASeries(closes, 60);
  if (!ma20Series || !ma60Series) return "NONE";

  const n = closes.length;
  const today20 = ma20Series[n - 1];
  const today60 = ma60Series[n - 1];
  const prev20 = ma20Series[n - 2];
  const prev60 = ma60Series[n - 2];
  if ([today20, today60, prev20, prev60].some((v) => v == null)) return "NONE";

  if (prev20 <= prev60 && today20 > today60) return "GOLDEN";
  if (prev20 >= prev60 && today20 < today60) return "DEAD";
  return "NONE";
}

// 평균 대비 2배 이상 거래량 급증 + 뚜렷한 방향(±1.5% 이상)이 함께 나온 날만 신호로 침
function detectVolumeSurge(opens, closes, volumes) {
  const n = closes.length;
  if (n < 21) return "NONE";

  const todayVol = volumes[n - 1];
  const window = volumes.slice(n - 21, n - 1);
  const avg = window.reduce((a, b) => a + b, 0) / window.length;
  if (avg <= 0) return "NONE";

  const volRatio = todayVol / avg;
  if (volRatio < 2.0) return "NONE";

  const o = opens[n - 1];
  const c = closes[n - 1];
  if (!o) return "NONE";
  const movePct = ((c - o) / o) * 100;

  if (movePct >= 1.5) return "BUY";
  if (movePct <= -1.5) return "SELL";
  return "NONE";
}

// 외국인/기관 연속매매 — 국내(KIS 투자자별 매매동향)만 가능, 해외는 데이터 자체가 없어 스킵.
// 화면 서술(수급 탭)은 3일부터 언급하지만, 텔레그램 "독립 알림" 기준은 더 엄격하게 5일로 잡음 —
// 한국 트레이더 사이의 경험칙("3일 연속이면 뭔가 있다")과 미국 CANSLIM Distribution Days 기법
// (3일=경계, 5일=확실한 신호)이 공통적으로 "5일부터 확실한 신호"로 보는 것과 일치시킴
// (2026-07-31 리서치 후 결정 — project memory 참고).
const INVESTOR_STREAK_ALERT_MIN_DAYS = 5;

async function detectInvestorStreakSignal(symbol) {
  if (!isDomesticSymbol(symbol)) return { signal: "NONE", reasons: [] };

  const history = await getInvestorTrendHistory(symbol, 15);
  const frgnStreak = computeStreak(history, "frgn_ntby_qty");
  const orgnStreak = computeStreak(history, "orgn_ntby_qty");

  const reasons = [];
  let signal = "NONE";

  if (frgnStreak && frgnStreak.days >= INVESTOR_STREAK_ALERT_MIN_DAYS) {
    const verb = frgnStreak.direction === "BUY" ? "순매수" : "순매도";
    reasons.push(
      `외국인 ${frgnStreak.days}일 연속 ${verb}(누적 ${Math.abs(frgnStreak.cumulative).toLocaleString()}주)`
    );
    signal = frgnStreak.direction;
  }
  if (orgnStreak && orgnStreak.days >= INVESTOR_STREAK_ALERT_MIN_DAYS) {
    const verb = orgnStreak.direction === "BUY" ? "순매수" : "순매도";
    reasons.push(
      `기관 ${orgnStreak.days}일 연속 ${verb}(누적 ${Math.abs(orgnStreak.cumulative).toLocaleString()}주)`
    );
    // 매도 우선 정책 — 외국인이 BUY 스트릭이어도 기관이 SELL 스트릭이면 SELL로 덮어씀
    if (orgnStreak.direction === "SELL" || signal === "NONE") signal = orgnStreak.direction;
  }

  return { signal, reasons };
}

// 종목 하나에 대해 골든/데드크로스 + 거래량 급증 + 외국인/기관 연속매매(5일+)를 합쳐
// 최종 신호(BUY/SELL/NONE)를 판정. 매도 쪽 신호가 항상 우선 — 알림 시스템은 놓치는 매수 기회보다
// 놓치는 리스크 관리가 더 손해라는 판단(리스크 관리 우선 정책).
async function checkSignal(symbol) {
  const { opens, closes, volumes } = await fetchCandles(symbol);

  const maCross = detectMACross(closes);
  const volSurge = detectVolumeSurge(opens, closes, volumes);
  const streakResult = await detectInvestorStreakSignal(symbol).catch((e) => {
    console.error(`[RAVEN] 연속매매 신호 체크 실패 (${symbol}):`, e.message);
    return { signal: "NONE", reasons: [] };
  });
  // 프로그램매매/공매도·대차 조합도 국내(KIS 수급데이터)만 가능 — 해외는 애초에 캐시가 없어서
  // 호출해도 항상 NONE이지만, 불필요한 Supabase 조회 자체를 스킵하도록 미리 걸러둠.
  const comboResult = isDomesticSymbol(symbol)
    ? await getComboSupplyDemandSignal(symbol).catch((e) => {
        console.error(`[RAVEN] 수급 조합 신호 체크 실패 (${symbol}):`, e.message);
        return { signal: "NONE", reasons: [] };
      })
    : { signal: "NONE", reasons: [] };

  let signal = "NONE";
  const reasons = [];

  if (maCross === "GOLDEN") {
    signal = "BUY";
    reasons.push("MA20이 MA60을 상향 돌파 (골든크로스)");
  }
  if (maCross === "DEAD") {
    signal = "SELL";
    reasons.push("MA20이 MA60을 하향 돌파 (데드크로스)");
  }
  if (volSurge === "BUY" && signal !== "SELL") {
    signal = "BUY";
    reasons.push("평균 대비 2배 이상 거래량 급증 + 상승 마감");
  }
  if (volSurge === "SELL") {
    signal = "SELL";
    reasons.push("평균 대비 2배 이상 거래량 급증 + 하락 마감");
  }
  if (streakResult.signal === "BUY" && signal !== "SELL") {
    signal = "BUY";
    reasons.push(...streakResult.reasons);
  }
  if (streakResult.signal === "SELL") {
    signal = "SELL";
    reasons.push(...streakResult.reasons);
  }

  // 프로그램매매/공매도·대차 조합은 하루 스냅샷이라 그 자체로 독립 알림을 만들지 않고, 위에서 이미
  // 신호가 확정된 경우에만(방향이 같을 때) 근거 문구로 덧붙임 — 지속성 근거가 있는 연속매매와 달리
  // 단독 트리거로 쓰기엔 매일 나올 수 있어 알림 스팸 위험이 있다고 판단(2026-07-31 설계 결정).
  if (signal !== "NONE" && comboResult.signal === signal) {
    reasons.push(...comboResult.reasons);
  }

  return { symbol, signal, reasons, price: closes[closes.length - 1] };
}

module.exports = { checkSignal };
