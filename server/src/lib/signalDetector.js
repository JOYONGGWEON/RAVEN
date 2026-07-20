const { getTossAccessToken } = require("./tossAuth");

const TOSS_API_BASE = "https://openapi.tossinvest.com";

// 관심종목 알림 전용 캔들 조회 — 프론트(app.js)의 fetchCandleData와 같은 응답 구조를 다루지만,
// 서버 스케줄러에서 직접 Toss를 호출해야 해서(브라우저 전용 app.js는 require 불가) 별도로 둠.
async function fetchCandles(symbol) {
  const token = await getTossAccessToken();
  const qs = new URLSearchParams({ symbol, interval: "1d", count: "180" }).toString();
  const res = await fetch(`${TOSS_API_BASE}/api/v1/candles?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Toss candles request failed: ${res.status}`);
  const json = await res.json();

  const candles = json?.result?.candles;
  if (!candles || !candles.length) throw new Error("No candle result");

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

// 종목 하나에 대해 골든/데드크로스 + 거래량 급증을 합쳐 최종 신호(BUY/SELL/NONE)를 판정.
// 매도 쪽 신호(데드크로스, 거래량 급증 매도)가 항상 우선 — 알림 시스템은 놓치는 매수 기회보다
// 놓치는 리스크 관리가 더 손해라는 판단(리스크 관리 우선 정책).
async function checkSignal(symbol) {
  const { opens, closes, volumes } = await fetchCandles(symbol);

  const maCross = detectMACross(closes);
  const volSurge = detectVolumeSurge(opens, closes, volumes);

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

  return { symbol, signal, reasons, price: closes[closes.length - 1] };
}

module.exports = { checkSignal };
