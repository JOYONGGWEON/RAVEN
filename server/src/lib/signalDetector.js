const { fetchCandles: fetchKisCandles, isDomesticSymbol } = require("./kisMarket");
const {
  getInvestorTrendHistory,
  computeStreak,
  getComboSupplyDemandSignal,
} = require("./supplyDemandInterpreter");

// 관심종목 알림 전용 캔들 조회 — 프론트(app.js)의 fetchCandleData와 같은 응답 구조를 다루지만,
// 서버 스케줄러에서 직접 KIS를 호출해야 해서(브라우저 전용 app.js는 require 불가) 별도로 둠.
// 2026-08-10 피드백: 텔레그램 알림에 목표가/손절가도 넣어달라는 요청 — 계산에 필요한 highs/lows도
// 같이 뽑아둠(기존엔 opens/closes/volumes만 썼음).
async function fetchCandles(symbol) {
  const candles = await fetchKisCandles(symbol, 180);

  const chronological = [...candles].reverse();
  const opens = [];
  const highs = [];
  const lows = [];
  const closes = [];
  const volumes = [];

  for (const c of chronological) {
    const o = Number(c.openPrice);
    const h = Number(c.highPrice);
    const l = Number(c.lowPrice);
    const cl = Number(c.closePrice);
    const v = Number(c.volume);
    if ([o, h, l, cl, v].some((n) => Number.isNaN(n))) continue;
    opens.push(o);
    highs.push(h);
    lows.push(l);
    closes.push(cl);
    volumes.push(v);
  }

  if (closes.length < 61) throw new Error("Not enough candle history for MA60");
  return { opens, highs, lows, closes, volumes };
}

// app.js의 calcATR과 동일한 Wilder 평활 방식(서버 전용 사본 — 브라우저 전용 app.js는 require 불가)
function calcATR(highs, lows, closes, period = 14) {
  const n = closes.length;
  if (n < period + 1) return null;

  const trList = [];
  for (let i = 1; i < n; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trList.push(tr);
  }

  let atr = trList.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trList.length; i++) {
    atr = (atr * (period - 1) + trList[i]) / period;
  }
  return atr;
}

// ────────────────────────────────
// 스윙 포인트 → 지지/저항 레벨 클러스터링 헬퍼 (app.js의 clusterSwingLevels/pickSupportResistance
// 사본 — 서버 전용, 브라우저 전용 app.js는 require 불가)
// 2026-08-12: 아래 calcTargetStop 통일 작업으로 신규 이식.
// ────────────────────────────────
function clusterSwingLevels(levels, totalBars, tol = 0.03) {
  const clusters = [];
  levels.forEach((lv) => {
    const { price, idx } = lv;
    let found = null;
    for (const c of clusters) {
      const diff = Math.abs(price - c.price) / c.price;
      if (diff <= tol) {
        found = c;
        break;
      }
    }
    if (!found) {
      clusters.push({ price, idxs: [idx], lastIdx: idx });
    } else {
      found.idxs.push(idx);
      found.lastIdx = Math.max(found.lastIdx, idx);
      const k = found.idxs.length;
      found.price = (found.price * (k - 1) + price) / k;
    }
  });
  clusters.forEach((c) => {
    const touchCount = c.idxs.length;
    const timeBoost = 1 + c.lastIdx / Math.max(1, totalBars);
    c.score = touchCount * timeBoost;
  });
  return clusters;
}

function pickSupportResistance(clusters, lastPrice, isSupport, maxDistPct = 0.3) {
  const filtered = clusters.filter((c) => {
    if (isSupport ? c.price >= lastPrice : c.price <= lastPrice) return false;
    const distPct = Math.abs(lastPrice - c.price) / lastPrice;
    return distPct <= maxDistPct;
  });
  if (!filtered.length) return [];
  filtered.sort((a, b) => b.score - a.score);
  const top = filtered.slice(0, 5);
  top.sort((a, b) => Math.abs(lastPrice - a.price) - Math.abs(lastPrice - b.price));
  return top;
}

// 목표가/손절가 — 2026-08-12: 결과화면(app.js analyzeData)과 완전히 같은 알고리즘으로 통일.
// 기존엔 알림 전용으로 ATR만 쓰는 간소화 버전이었는데(60일 고가/저가 → ATR 전환 히스토리는 아래
// 예전 주석 참고), 사용자가 "화면에서 본 목표가/손절가랑 알림으로 온 값이 서로 다른 근거로 계산돼서
// 어긋난다"고 지적 — app.js의 5봉 스윙 피벗 기반 지지/저항 클러스터링을 그대로 이식해서, 알림도
// 결과화면과 똑같이 "지지선=손절 기준/저항선=목표가 기준(각각 못 찾으면 ATR 폴백)" 순서로 계산하도록
// 맞춤. ⚠️ 포팅 중 실제로 겪은 함정: 기존 알림 엔진에 있던 MIN_RISK_PCT(4%) 하한을 그대로
// 들고 왔다가, 실측(에스피지 058610)에서 지지선이 현재가 0.2% 아래라는 진짜 유효한 근거를
// 찾고도 "너무 좁다"며 하한이 억지로 손절폭을 4%로 넓혀버리는 걸 재현함 — 결과화면(app.js)엔
// 이런 하한이 아예 없고, 지지선 기반 손절은 그게 아무리 가까워도(그만큼 진입 시점이 좋다는
// 뜻이므로) 그대로 쓰는 게 맞음. app.js와 완전히 같은 기준으로 통일하는 게 이번 작업의 목적이라
// MIN_RISK_PCT는 제거함(ATR 폴백 경로에도 동일 적용 — app.js도 그렇게 함).
//
// [이전 히스토리] 2026-08-10 1차 수정: 60일 고가/저가 기반(비현실적으로 넓음, 예: -25%/+70%)을
// ATR 기반으로 교체하면서 MAX_RISK_PCT를 12%로 잡았는데, 다음날 아침 실제 알림을 보니 관심종목
// 전종목의 목표가/손절가 %가 전부 똑같이 찍히는 문제가 재현됨(실측 확인: 006800/112610/058610/
// 034020/475150 등 신호 뜬 종목 전부 target +18.0%/stop -12.9%로 동일) — 원인은 2×ATR(14)가
// 이 종목군 전체에서 12% 상한을 항상 넘어서 있었던 것(12.6%~32.3%). ATR 배수 2→1.5, 상한 12%→18%로
// 재조정해서 해결(이 값들은 이번 통일 작업에서도 그대로 유지).
function calcTargetStop(highs, lows, closes) {
  const n = closes.length;
  const lastPrice = closes[n - 1];
  const atr = calcATR(highs, lows, closes, 14);
  const atrPct = typeof atr === "number" && lastPrice > 0 ? (atr / lastPrice) * 100 : null;

  let support1 = null;
  let resistance1 = null;

  if (n >= 10) {
    const start = Math.max(2, n - 80);
    const swingLows = [];
    const swingHighs = [];
    // 좌우 2봉씩 비교하는 5봉 피벗(app.js와 동일) — 좌우 1봉(3봉)만 보면 하루짜리 노이즈까지
    // 스윙 고점/저점으로 잡혀버림.
    for (let i = start; i < n - 2; i++) {
      const h = highs[i];
      const l = lows[i];
      if (h > highs[i - 1] && h > highs[i - 2] && h > highs[i + 1] && h > highs[i + 2]) {
        swingHighs.push({ price: h, idx: i });
      }
      if (l < lows[i - 1] && l < lows[i - 2] && l < lows[i + 1] && l < lows[i + 2]) {
        swingLows.push({ price: l, idx: i });
      }
    }

    // 클러스터링 허용오차·탐색거리 둘 다 종목 변동성(ATR%) 기반(app.js와 동일 상수).
    const swingTol = Number.isFinite(atrPct)
      ? Math.max(0.015, Math.min(0.08, (atrPct * 1.5) / 100))
      : 0.03;
    const srMaxDist = Number.isFinite(atrPct)
      ? Math.max(0.1, Math.min(0.2, (atrPct * 5) / 100))
      : 0.15;

    const lowClusters = clusterSwingLevels(swingLows, n, swingTol);
    const highClusters = clusterSwingLevels(swingHighs, n, swingTol);

    const supportLevels = pickSupportResistance(lowClusters, lastPrice, true, srMaxDist);
    const resistanceLevels = pickSupportResistance(highClusters, lastPrice, false, srMaxDist);

    if (supportLevels.length > 0) support1 = supportLevels[0].price;
    if (resistanceLevels.length > 0) resistance1 = resistanceLevels[0].price;

    // 클러스터링으로 못 찾으면 60봉 최고/최저로 폴백(오늘 봉 자체는 제외) — srMaxDist를
    // fallback에도 똑같이 적용(app.js에서 실제로 재현됐던 "저항선이 현재가 대비 +64%" 버그와
    // 같은 함정을 여기서도 피하기 위함).
    if (support1 === null) {
      const recentLows = lows.slice(Math.max(0, n - 60), n - 1);
      if (recentLows.length) {
        const minLow = Math.min(...recentLows);
        const distPct = (lastPrice - minLow) / lastPrice;
        if (minLow < lastPrice && distPct <= srMaxDist) support1 = minLow;
      }
    }
    if (resistance1 === null) {
      const recentHighs = highs.slice(Math.max(0, n - 60), n - 1);
      if (recentHighs.length) {
        const maxHigh = Math.max(...recentHighs);
        const distPct = (maxHigh - lastPrice) / lastPrice;
        if (maxHigh > lastPrice && distPct <= srMaxDist) resistance1 = maxHigh;
      }
    }
  }

  const ATR_STOP_MULT = 1.5;
  const RR_RATIO = 1.5;
  const MAX_RISK_PCT = 18;

  let stopBase;
  if (support1 !== null && support1 < lastPrice) {
    stopBase = support1;
  } else if (typeof atr === "number" && atr > 0) {
    stopBase = lastPrice - ATR_STOP_MULT * atr;
  } else {
    stopBase = lastPrice * (1 - MAX_RISK_PCT / 100);
  }

  let riskPct = ((lastPrice - stopBase) / lastPrice) * 100;
  if (riskPct > MAX_RISK_PCT) {
    stopBase = lastPrice * (1 - MAX_RISK_PCT / 100);
  }

  const stop = stopBase * 0.99;
  const riskAmount = lastPrice - stopBase;
  const target1 = resistance1 !== null ? resistance1 * 0.995 : lastPrice + riskAmount * RR_RATIO;

  return { target1, stop };
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

// 2026-08-11 알고리즘 업데이트: ADX(14, Wilder) — app.js의 calcADX 사본(서버 전용, 최종 값만 필요
// 해서 DI±/시리즈는 생략). MA크로스가 "추세 없는 횡보장의 가짜 신호"이기 쉬운 걸 걸러내는 용도.
function calcADX(highs, lows, closes, period = 14) {
  const n = closes.length;
  if (n < period * 2 + 1) return null;

  const trList = [];
  const plusDMList = [];
  const minusDMList = [];
  for (let i = 1; i < n; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDMList.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMList.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trList.push(
      Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]))
    );
  }

  const wilderSmooth = (arr) => {
    const len = arr.length;
    if (len < period) return null;
    const smoothed = [];
    let sum = 0;
    for (let i = 0; i < period; i++) sum += arr[i];
    smoothed.push(sum);
    for (let i = period; i < len; i++) {
      smoothed.push(smoothed[smoothed.length - 1] - smoothed[smoothed.length - 1] / period + arr[i]);
    }
    return smoothed;
  };

  const trSmoothed = wilderSmooth(trList);
  const plusDMSmoothed = wilderSmooth(plusDMList);
  const minusDMSmoothed = wilderSmooth(minusDMList);
  if (!trSmoothed || !plusDMSmoothed || !minusDMSmoothed) return null;

  const dxList = [];
  for (let i = 0; i < trSmoothed.length; i++) {
    const tr = trSmoothed[i];
    if (!tr) {
      dxList.push(null);
      continue;
    }
    const plusDI = (plusDMSmoothed[i] / tr) * 100;
    const minusDI = (minusDMSmoothed[i] / tr) * 100;
    const sum = plusDI + minusDI;
    dxList.push(sum > 0 ? (Math.abs(plusDI - minusDI) / sum) * 100 : 0);
  }

  const validDx = dxList.filter((v) => v != null);
  if (validDx.length < period) return null;

  let adx = validDx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < validDx.length; i++) {
    adx = (adx * (period - 1) + validDx[i]) / period;
  }
  return adx;
}

// 2026-08-11 알고리즘 업데이트: MACD(12,26,9) 크로스오버 — app.js의 calcMACDFull 로직 중
// 크로스오버 판정 부분만 요약한 사본. MA크로스(가격 축)·거래량급증·연속매매(수급 축)와 달리
// 모멘텀이라는 별개 축이라, 세 카테고리가 우연히 겹칠 때보다 진짜 다양한 근거가 됨.
function detectMacdCross(closes) {
  if (closes.length < 26 + 9) return "NONE";
  const ema12Series = calcEMASeries(closes, 12);
  const ema26Series = calcEMASeries(closes, 26);
  if (!ema12Series || !ema26Series) return "NONE";

  const n = closes.length;
  const validStart = 25; // EMA26가 유효해지는 인덱스(26-1)부터 MACD 라인도 유효
  const macdValid = [];
  for (let i = validStart; i < n; i++) {
    macdValid.push(ema12Series[i] - ema26Series[i]);
  }
  const signalValidSeries = calcEMASeries(macdValid, 9);
  if (!signalValidSeries) return "NONE";

  const macdSeries = new Array(n).fill(null);
  const signalSeries = new Array(n).fill(null);
  for (let i = 0; i < macdValid.length; i++) {
    macdSeries[validStart + i] = macdValid[i];
    if (signalValidSeries[i] != null) signalSeries[validStart + i] = signalValidSeries[i];
  }

  const last = n - 1;
  const prev = n - 2;
  if (
    macdSeries[last] == null ||
    signalSeries[last] == null ||
    prev < 0 ||
    macdSeries[prev] == null ||
    signalSeries[prev] == null
  ) {
    return "NONE";
  }

  const prevDiff = macdSeries[prev] - signalSeries[prev];
  const currDiff = macdSeries[last] - signalSeries[last];
  if (prevDiff <= 0 && currDiff > 0) return "GOLDEN";
  if (prevDiff >= 0 && currDiff < 0) return "DEAD";
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
// 5일 미만이라 단독 트리거는 못 되지만, 다른 신호가 이미 뜬 경우 "참고 근거"로 신뢰도에 반영하는
// 하한선 — 사용자 요청("3일 연속 수급까지 붙으면 신뢰도 상승")에 맞춰 화면 서술과 같은 3일로 통일.
const INVESTOR_STREAK_CONFIRM_MIN_DAYS = 3;

// 외국인/기관 각각의 스트릭을 "5일+ 독립 트리거"와 "3~4일 참고용(신뢰도 보너스)"으로 분류.
// 같은 투자자 유형(예: 외국인)이 두 버킷에 동시에 들어가는 일은 없음(streak.days로 한쪽만 해당).
async function detectInvestorStreakSignal(symbol) {
  if (!isDomesticSymbol(symbol)) {
    return { signal: "NONE", reasons: [], confirmSignal: "NONE", confirmReasons: [] };
  }

  const history = await getInvestorTrendHistory(symbol, 15);

  const reasons = [];
  const confirmReasons = [];
  let signal = "NONE";
  let confirmSignal = "NONE";

  // ⚠️ 실제 버그(2026-08-11 아침 사용자 보고 계기로 재검토): MA크로스는 "오늘 막 뒤집힌 사건"만
  // 잡아서 하루만 알림이 뜨는데, 연속매매(5일+)는 조건이 유지되는 한 6일째·7일째·8일째도 매일 다시
  // 발신되고 있었음(상태 기반이라 그런 것 — 다른 트리거들과의 일관성이 깨짐, 알림 피로 유발).
  // "어제 기준으로는 5일 미만이었는데 오늘 막 5일을 채운 날"에만 독립 신호로 발신하고, 이미
  // 5일 이상이 이어지는 중이면(재발신 상황) confirm(참고 근거)로 강등 — 완전히 사라지진 않지만
  // 다른 트리거가 이미 알림을 울린 날에만 신뢰도 보너스로 붙는 조용한 역할로 바뀜.
  const consider = (field, label) => {
    const streak = computeStreak(history, field);
    if (!streak || streak.days < INVESTOR_STREAK_CONFIRM_MIN_DAYS) return;
    const verb = streak.direction === "BUY" ? "순매수" : "순매도";
    const text = `${label} ${streak.days}일 연속 ${verb}(누적 ${Math.abs(streak.cumulative).toLocaleString()}주)`;

    if (streak.days >= INVESTOR_STREAK_ALERT_MIN_DAYS) {
      const yesterdayStreak = computeStreak(history.slice(1), field);
      const isNewlyCrossed = !yesterdayStreak || yesterdayStreak.days < INVESTOR_STREAK_ALERT_MIN_DAYS;
      if (isNewlyCrossed) {
        reasons.push(text);
        // 매도 우선 정책 — 이미 BUY였어도 SELL 스트릭이면 덮어씀
        if (streak.direction === "SELL" || signal === "NONE") signal = streak.direction;
      } else {
        confirmReasons.push(text);
        if (streak.direction === "SELL" || confirmSignal === "NONE") confirmSignal = streak.direction;
      }
    } else {
      confirmReasons.push(text);
      if (streak.direction === "SELL" || confirmSignal === "NONE") confirmSignal = streak.direction;
    }
  };

  consider("frgn_ntby_qty", "외국인");
  consider("orgn_ntby_qty", "기관");

  return { signal, reasons, confirmSignal, confirmReasons };
}

// 몇 개의 "독립 근거 카테고리"(골든/데드크로스, 거래량급증, 연속매매 5일+)가 최종 신호와 같은
// 방향을 가리키는지로 신뢰도를 매김 — 사용자 요청: "기존 알고리즘에 +알파로 신뢰도를 쌓는" 개념.
// 3~4일 연속매매(confirmSignal)는 그 자체로 카테고리는 아니지만, 방향이 일치하면 보너스로 +1.
function rateConfidence(matchingCategories) {
  if (matchingCategories >= 3) return "매우 높음";
  if (matchingCategories === 2) return "높음";
  if (matchingCategories === 1) return "보통";
  return "NONE";
}

// 종목 하나에 대해 골든/데드크로스 + 거래량 급증 + 외국인/기관 연속매매(5일+)를 합쳐
// 최종 신호(BUY/SELL/NONE)를 판정. 매도 쪽 신호가 항상 우선 — 알림 시스템은 놓치는 매수 기회보다
// 놓치는 리스크 관리가 더 손해라는 판단(리스크 관리 우선 정책).
// 2026-08-11 알고리즘 업데이트: MA크로스는 추세 없는 횡보장에서도 가짜로 뜨기 쉬운 게 기술적
// 분석의 잘 알려진 약점 — ADX가 뚜렷한 추세 구간(≥20)일 때만 신호로 인정. app.js의 지표 해석
// 박스가 쓰는 것과 같은 임계값(추세 뚜렷함 25 / 보통 20 / 약함 20 미만)에서 "보통" 이상만 통과.
const ADX_TREND_THRESHOLD = 20;

async function checkSignal(symbol) {
  const { opens, highs, lows, closes, volumes } = await fetchCandles(symbol);

  const maCross = detectMACross(closes);
  const volSurge = detectVolumeSurge(opens, closes, volumes);
  const adx = calcADX(highs, lows, closes, 14);
  const macdCross = detectMacdCross(closes);
  const streakResult = await detectInvestorStreakSignal(symbol).catch((e) => {
    console.error(`[RAVEN] 연속매매 신호 체크 실패 (${symbol}):`, e.message);
    return { signal: "NONE", reasons: [], confirmSignal: "NONE", confirmReasons: [] };
  });
  // 프로그램매매/공매도·대차 조합도 국내(KIS 수급데이터)만 가능 — 해외는 애초에 캐시가 없어서
  // 호출해도 항상 NONE이지만, 불필요한 Supabase 조회 자체를 스킵하도록 미리 걸러둠.
  const comboResult = isDomesticSymbol(symbol)
    ? await getComboSupplyDemandSignal(symbol).catch((e) => {
        console.error(`[RAVEN] 수급 조합 신호 체크 실패 (${symbol}):`, e.message);
        return { signal: "NONE", reasons: [] };
      })
    : { signal: "NONE", reasons: [] };

  const adxOk = typeof adx === "number" && adx >= ADX_TREND_THRESHOLD;
  const maCrossConfirmed = adxOk ? maCross : "NONE";

  // 카테고리별 방향/근거를 먼저 각자 계산 — 최종 신호를 정하기 전에 "몇 개가 같은 방향을
  // 가리키는지"를 신뢰도 산정에 써야 하므로, 매도 우선 override와 분리해서 처리함.
  const categories = [
    {
      dir: maCrossConfirmed === "GOLDEN" ? "BUY" : maCrossConfirmed === "DEAD" ? "SELL" : "NONE",
      reasons:
        maCrossConfirmed === "GOLDEN"
          ? [`MA20이 MA60을 상향 돌파 (골든크로스, ADX ${adx.toFixed(1)}로 추세 확인됨)`]
          : maCrossConfirmed === "DEAD"
          ? [`MA20이 MA60을 하향 돌파 (데드크로스, ADX ${adx.toFixed(1)}로 추세 확인됨)`]
          : [],
    },
    {
      dir: volSurge,
      reasons:
        volSurge === "BUY"
          ? ["평균 대비 2배 이상 거래량 급증 + 상승 마감"]
          : volSurge === "SELL"
          ? ["평균 대비 2배 이상 거래량 급증 + 하락 마감"]
          : [],
    },
    { dir: streakResult.signal, reasons: streakResult.reasons },
    // 2026-08-12 백테스트 실증(project_raven_algorithm_update 메모리 참고): MACD 골든크로스는
    // BUY 쪽에서 두 독립 ~3년 구간 모두 기준선 대비 우위를 보였지만, MACD 데드크로스는 SELL 쪽에서
    // 두 구간 모두 기준선 대비 우위가 없었고(방향 정확도가 "아무 날에나 하락에 걸기"와 비슷하거나
    // 낮음), 드물게 이미 수익 구간에서 떴을 때조차 전체 분석 중 가장 나쁜 성적(승률 40%대, 평균
    // -3~-6%대)이었음 — 잘 나가는 포지션을 조기에 끊는 경우가 많았다는 뜻이라 "저위험"도 아니었음.
    // GOLDEN(BUY)은 그대로 독립 카테고리로 남기고, DEAD(SELL)만 독립 트리거에서 제외 — 아래에서
    // 다른 신호가 이미 SELL로 판정됐을 때만 확인 근거(confirm)로 반영(program-trade 조합/3~4일
    // 연속매매와 같은 패턴, 완전히 버리진 않되 단독으로 알림을 못 울리게 강등).
    {
      dir: macdCross === "GOLDEN" ? "BUY" : "NONE",
      reasons: macdCross === "GOLDEN" ? ["MACD 골든크로스 (모멘텀 전환)"] : [],
    },
  ];

  let signal = "NONE";
  if (categories.some((c) => c.dir === "SELL")) signal = "SELL";
  else if (categories.some((c) => c.dir === "BUY")) signal = "BUY";

  const reasons = [];
  let matchingCategories = 0;
  if (signal !== "NONE") {
    categories.forEach((c) => {
      if (c.dir === signal) {
        reasons.push(...c.reasons);
        matchingCategories++;
      }
    });

    // 프로그램매매/공매도·대차 조합은 하루 스냅샷이라 그 자체로 독립 카테고리는 아니지만,
    // 방향이 일치하면 근거+신뢰도 둘 다에 반영(2026-07-31 설계 결정 — 알림 스팸 방지 위해
    // 단독 트리거로는 안 씀).
    if (comboResult.signal === signal && comboResult.reasons.length) {
      reasons.push(...comboResult.reasons);
      matchingCategories++;
    }

    // 연속매매가 5일 미만(3~4일)이라 독립 트리거는 아니었어도, 이미 다른 신호로 방향이 정해졌다면
    // "참고 근거"로 신뢰도에 반영 — 사용자 요청("3일 연속 수급까지 붙으면 신뢰도 상승").
    if (streakResult.confirmSignal === signal && streakResult.confirmReasons.length) {
      reasons.push(...streakResult.confirmReasons);
      matchingCategories++;
    }

    // MACD 데드크로스 확인 근거 — 위 categories 배열 주석 참고(백테스트로 독립 SELL 트리거에서
    // 강등됨). 다른 신호가 이미 SELL을 확정한 날에만 참고용으로 덧붙임.
    if (signal === "SELL" && macdCross === "DEAD") {
      reasons.push("MACD 데드크로스 동반(모멘텀도 하락 전환 — 참고용, 백테스트 결과 단독 신뢰도 낮아 트리거로는 안 씀)");
      matchingCategories++;
    }
  }

  // 목표가/손절가는 신호가 있을 때만 계산(불필요한 계산 방지) — 위 calcTargetStop 참고.
  const targetStop = signal !== "NONE" ? calcTargetStop(highs, lows, closes) : null;

  return {
    symbol,
    signal,
    reasons,
    confidence: rateConfidence(matchingCategories),
    price: closes[closes.length - 1],
    target1: targetStop ? targetStop.target1 : null,
    stop: targetStop ? targetStop.stop : null,
  };
}

// 2026-08-12: 백테스팅 엔진(server/scripts/backtest.js)이 checkSignal 안의 개별 판정 함수를
// "당일 데이터까지만 잘라서" 과거 시점별로 재현해야 해서, 로직을 새로 베끼지 않고 그대로 재사용하도록
// export 추가(단일 진실 공급원 유지 — 복붙하면 나중에 실서비스 로직만 고치고 백테스트는 안 고쳐서
// 둘이 어긋나는 위험이 생김).
module.exports = {
  checkSignal,
  fetchCandles,
  calcATR,
  calcADX,
  detectMACross,
  detectMacdCross,
  detectVolumeSurge,
  calcTargetStop,
  ADX_TREND_THRESHOLD,
};
