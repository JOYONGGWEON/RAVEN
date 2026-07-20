// =======================
// RAVEN v6.6 - Pattern / Signal / Target / Chart 통합 버전
// =======================

// Trend / Momentum / Vol / R:R 카테고리 상태 (추후 버튼화용)
let activeCategory = "trend";

// 1. 설정
// corsproxy.io 공개 프록시 의존 제거 — 이제 백엔드 서버가 Yahoo Finance를 직접 호출함.
// TODO: Render 배포 후 실제 서버 주소로 교체
const API_BASE = "http://localhost:3001";

// FX 캐시 & 마지막 분석 결과(포지션 계산용)
let fxRateKRW = null;
let lastAnalysis = null;

// 2. 유틸리티 함수
const $ = (id) => document.getElementById(id);

const formatUSD = (num) =>
  "$" +
  Number(num).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

const formatKRW = (num) => "₩" + Math.round(Number(num)).toLocaleString("ko-KR");

function showToast(msg) {
  const el = $("toast-msg");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 3000);
}

function showLoading(isLoading) {
  const loading = $("loading-indicator");

  if (isLoading) {
    if (loading) loading.classList.remove("hidden");
  } else {
    if (loading) loading.classList.add("hidden");
  }
}

function showResultCard() {
  const card = document.getElementById("result-card");
  if (!card) return;

  // 로딩 중에 숨겼던 상태 초기화
  card.classList.remove("hidden");

  // 재실행 때도 부드럽게 보이게 하려면 한번 리플로우
  void card.offsetWidth;

  card.classList.add("show");
}

function hideResultCard() {
  const card = document.getElementById("result-card");
  if (!card) return;

  card.classList.add("hidden");
  card.classList.remove("show");
}

// ===== RAVEN VIP CODE + Intro + Entry Flow v2 =====
// PIN은 더 이상 프론트에 평문으로 두지 않고, 서버(/api/auth/verify-pin)가 검증함.

let overlayRoot;
let lockScreen, introScreen, entryScreen;
let pinInputs, lockErrorEl;
let introTitleEl, introSubEl;
let entryTickerEl, entryRunBtn, entryMessageEl, entryProgressEl;
let entryBackdrop; // 🔹 PIN/INTRO/ENTRY 전환용 백드롭 엘리먼트 (CSS: .entry-backdrop)

// 각 오버레이 화면 전환 (2초 트랜지션)
function showOverlayScreen(target) {
  [lockScreen, introScreen, entryScreen].forEach((el) => {
    if (!el) return;

    if (el === target) {
      el.classList.remove("hidden", "hide");
      // 리플로우로 트랜지션 재생성
      void el.offsetWidth;
      el.classList.add("show");
    } else {
      el.classList.remove("show");
      el.classList.add("hide");
      // 트랜지션(2초) 끝난 뒤 display:none
      setTimeout(() => {
        el.classList.add("hidden");
      }, 2000);
    }
  });
}

// PIN 체크 (서버에 검증 요청)
async function checkPinCode() {
  if (!pinInputs || pinInputs.length !== 4) return;

  const code = Array.from(pinInputs)
    .map((i) => i.value.trim())
    .join("");

  if (code.length < 4) return;

  let ok = false;
  try {
    const res = await fetch(`${API_BASE}/api/auth/verify-pin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: code }),
    });
    const json = await res.json();
    ok = res.ok && json.ok === true;
  } catch (e) {
    console.error("[RAVEN] PIN 검증 요청 실패:", e);
  }

  if (ok) {
    // 에러 메시지 숨김
    if (lockErrorEl) {
      lockErrorEl.classList.add("hidden");
    }
    playIntroSequence();
  } else {
    if (lockErrorEl) {
      lockErrorEl.textContent = "Wrong code. Try again.";
      lockErrorEl.classList.remove("hidden");
    }
    pinInputs.forEach((b) => (b.value = ""));
    pinInputs[0].focus();
  }
}

// PIN 성공 후: GOOD DAY SIR → Connect to RAVEN → 티커 입력
function playIntroSequence() {
  if (!introScreen) return;

  showOverlayScreen(introScreen);

  if (!introTitleEl || !introSubEl) return;

  introTitleEl.textContent = "GOOD DAY SIR :)";
  introSubEl.textContent = "⚡Access to RAVEN";

  introTitleEl.classList.remove("intro-hidden", "intro-visible-short");
  introSubEl.classList.remove("intro-visible-short");
  introSubEl.classList.add("intro-hidden");

  // GOOD DAY SIR 2초 페이드인 (끝까지 남아있음)
  introTitleEl.classList.add("intro-visible-long");

  // 2초 뒤에 Connect to RAVEN만 추가로 페이드인
  setTimeout(() => {
    introSubEl.classList.remove("intro-hidden");
    introSubEl.classList.add("intro-visible-short");
  }, 2000);

  // 그 뒤에 엔트리 화면으로 전환
  setTimeout(() => {
    if (entryScreen) showOverlayScreen(entryScreen);
    if (entryTickerEl) entryTickerEl.focus();
  }, 2000 + 1000 + 200);
}

// 🔹 엔트리 백드롭 제어 함수 (전역에서 사용 가능하도록 분리)
function showEntryBackdrop() {
  if (entryBackdrop) {
    entryBackdrop.classList.add("show");
  }
}

function hideEntryBackdrop() {
  if (entryBackdrop) {
    entryBackdrop.classList.remove("show");
  }
}

// Entry 화면에서 RUN RAVEN (티커 입력 후 실행)
async function runRavenFromEntry() {
  if (!entryTickerEl) return;

  const ticker = resolveTickerInput(entryTickerEl.value).toUpperCase();
  if (!ticker) return;

  // 🔹 메인 분석화면 준비되는 동안 백드롭 먼저 켜두기
  showEntryBackdrop();

  // 메인 검색창에도 티커 반영
  const mainInput = document.getElementById("ticker-input");
  if (mainInput) mainInput.value = ticker;

  // "Yes sir, RAVEN is running" 1초 페이드인
  if (entryMessageEl) {
    entryMessageEl.classList.remove("hidden");
    // 다음 프레임에 visible 붙여야 트랜지션 적용
    requestAnimationFrame(() => {
      entryMessageEl.classList.add("visible");
    });
  }

  // 원형 로딩 고리 표시
  if (entryProgressEl) {
    entryProgressEl.classList.remove("hidden");
  }

  // 🔹 최소 대기시간 보장 (예: 2.5초 동안은 YES SIR 화면 유지)
  const startTime = performance.now ? performance.now() : Date.now();
  const MIN_DISPLAY = 3000; // ms

  try {
    // 실제 분석 실행
    await runAnalysisForTicker(ticker);

    // 분석이 너무 빨리 끝나더라도, YES SIR 화면 최소 2.5초는 보여주기
    const endTime = performance.now ? performance.now() : Date.now();
    const elapsed = endTime - startTime;
    if (elapsed < MIN_DISPLAY) {
      await new Promise((resolve) => setTimeout(resolve, MIN_DISPLAY - elapsed));
    }

    // 분석 결과는 runAnalysisForTicker 안에서 보여주고,
    // 여기서는 오버레이만 내려줌
    if (overlayRoot) {
      overlayRoot.classList.add("hidden");
    }

    // 🔹 백드롭도 살짝 딜레이 주면서 꺼주면 자연스럽게 메인 화면 등장
    setTimeout(hideEntryBackdrop, 200);
  } catch (err) {
    console.error("[RAVEN] runRavenFromEntry error:", err);
    hideEntryBackdrop();
  }
}

// PIN / Intro / Entry 전체 초기화
function initLockAndIntro() {
  overlayRoot = document.getElementById("raven-overlay-root");
  if (!overlayRoot) return;

  lockScreen = document.getElementById("lock-screen");
  introScreen = document.getElementById("intro-screen");
  entryScreen = document.getElementById("entry-screen");
  entryBackdrop = document.getElementById("entry-backdrop"); // 🔹 전역 변수에 연결

  pinInputs = document.querySelectorAll("#lock-screen .pin-input");
  lockErrorEl = document.getElementById("lock-error");

  introTitleEl = document.getElementById("intro-title");
  introSubEl = document.getElementById("intro-sub");

  entryTickerEl = document.getElementById("entry-ticker");
  entryRunBtn = document.getElementById("entry-run-btn");
  entryMessageEl = document.getElementById("entry-message");
  entryProgressEl = document.getElementById("entry-progress");

  console.log("[RAVEN] initLockAndIntro v2");

  // PIN 입력 설정
  if (pinInputs && pinInputs.length === 4) {
    pinInputs.forEach((input, idx) => {
      // 숫자 한 글자만, 자동 다음 칸 이동
      input.addEventListener("input", (e) => {
        const v = e.target.value.replace(/\D/g, "").slice(0, 1);
        e.target.value = v;
        if (v && idx < pinInputs.length - 1) {
          pinInputs[idx + 1].focus();
        }
        checkPinCode();
      });

      input.addEventListener("keydown", (e) => {
        // Backspace로 이전칸 이동
        if (e.key === "Backspace" && !e.target.value && idx > 0) {
          pinInputs[idx - 1].focus();
        }
        // Enter로도 확인
        if (e.key === "Enter") {
          e.preventDefault();
          checkPinCode();
        }
      });
    });

    // 첫 화면은 PIN
    showOverlayScreen(lockScreen);
    pinInputs[0].focus();
  } else {
    // PIN UI 없으면 그냥 오버레이 숨김
    overlayRoot.classList.add("hidden");
  }

  // Entry 화면 버튼/엔터 연결
  if (entryRunBtn && entryTickerEl) {
    entryRunBtn.addEventListener("click", (e) => {
      e.preventDefault();
      runRavenFromEntry();
    });

    entryTickerEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        runRavenFromEntry();
      }
    });
  }
}

// 3. 공통 야후 파서 (간단 버전)
async function fetchYahooChart(symbol, range = "1d", interval = "1d") {
  const finalUrl = `${API_BASE}/api/yahoo/chart?symbol=${encodeURIComponent(
    symbol
  )}&range=${range}&interval=${interval}`;

  const response = await fetch(finalUrl);
  if (!response.ok) throw new Error("Network Error");

  const json = await response.json();
  if (!json.chart || !json.chart.result || !json.chart.result[0]) {
    throw new Error("Invalid Yahoo response");
  }

  const result = json.chart.result[0];
  const meta = result.meta || {};
  const indicators = result.indicators || {};
  const quoteArr = indicators.quote && indicators.quote[0];

  if (!quoteArr) throw new Error("Quote array missing");

  const closes = (quoteArr.close || []).filter((v) => v != null);

  if (!closes.length) throw new Error("No closes");

  const lastClose =
    typeof meta.regularMarketPrice === "number"
      ? meta.regularMarketPrice
      : closes[closes.length - 1];

  return { meta, closes, lastClose };
}

// 국내(KOSPI/KOSDAQ) 종목코드는 숫자 6자리, 해외는 알파벳 티커
function isDomesticTicker(ticker) {
  return /^\d{6}$/.test((ticker || "").trim());
}

// 자동완성에서 "삼성전자 (005930)" 형태로 선택된 입력값에서 종목코드만 추출
function resolveTickerInput(raw) {
  const trimmed = (raw || "").trim();
  const match = trimmed.match(/\((\d{6})\)\s*$/);
  return match ? match[1] : trimmed;
}

// 국내 종목코드 → 종목명 조회 (결과 화면 타이틀 표시용)
async function fetchDomesticStockName(code) {
  try {
    const res = await fetch(`${API_BASE}/api/stocks/name?code=${encodeURIComponent(code)}`);
    if (!res.ok) return null;
    const json = await res.json();
    return json.name || null;
  } catch (e) {
    console.warn("[RAVEN] 종목명 조회 실패:", e);
    return null;
  }
}

// 해외 티커 → 한글 종목명 조회 (결과 화면 타이틀 표시용, 토스 종목 마스터 정보 사용)
async function fetchOverseasStockName(symbol) {
  try {
    const res = await fetch(`${API_BASE}/api/toss/stock-info?symbol=${encodeURIComponent(symbol)}`);
    if (!res.ok) return null;
    const json = await res.json();
    return json?.result?.[0]?.name || null;
  } catch (e) {
    console.warn("[RAVEN] 해외 종목명 조회 실패:", e);
    return null;
  }
}

// 전일 수급(프로그램매매/공매도/신용/대차) 해석 코멘트 조회 (국내 종목 전용)
async function fetchSupplyDemandComment(symbol) {
  try {
    const res = await fetch(`${API_BASE}/api/kis/supply-demand?symbol=${encodeURIComponent(symbol)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn("[RAVEN] 수급 해석 조회 실패:", e);
    return null;
  }
}

// 국내 종목명 검색 (자동완성용)
async function searchDomesticStocks(query) {
  try {
    const res = await fetch(`${API_BASE}/api/stocks/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) return [];
    const json = await res.json();
    return json.result || [];
  } catch (e) {
    console.warn("[RAVEN] 종목명 검색 실패:", e);
    return [];
  }
}

// 티커 입력창에 종목명 자동완성 드롭다운 연결
function attachTickerAutocomplete(inputEl) {
  if (!inputEl) return;

  const list = document.createElement("div");
  list.className = "ticker-suggest-list hidden";
  document.body.appendChild(list);

  let debounceTimer = null;
  let currentItems = [];

  function hideList() {
    list.classList.add("hidden");
    list.innerHTML = "";
    currentItems = [];
  }

  function positionList() {
    const rect = inputEl.getBoundingClientRect();
    list.style.left = `${rect.left}px`;
    list.style.top = `${rect.bottom + 4}px`;
    list.style.width = `${rect.width}px`;
  }

  function renderList(items) {
    currentItems = items;
    if (!items.length) {
      hideList();
      return;
    }
    list.innerHTML = "";
    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "ticker-suggest-item";
      row.textContent = `${item.name} (${item.code}) · ${item.market}`;
      row.addEventListener("mousedown", (e) => {
        // blur보다 먼저 실행되도록 mousedown 사용
        e.preventDefault();
        inputEl.value = `${item.name} (${item.code})`;
        hideList();
      });
      list.appendChild(row);
    });
    positionList();
    list.classList.remove("hidden");
  }

  inputEl.addEventListener("input", () => {
    const q = inputEl.value.trim();
    clearTimeout(debounceTimer);

    // 순수 종목코드/영문 티커는 자동완성 대상 아님 (한글 종목명 검색만 지원)
    if (!q || !/[가-힣]/.test(q)) {
      hideList();
      return;
    }

    debounceTimer = setTimeout(async () => {
      const items = await searchDomesticStocks(q);
      renderList(items);
    }, 250);
  });

  inputEl.addEventListener("blur", () => {
    setTimeout(hideList, 100);
  });

  window.addEventListener("resize", () => {
    if (!list.classList.contains("hidden")) positionList();
  });
}

// 3-1. 개별 종목 데이터 (OHLC + Volume) — 국내/해외 모두 토스증권 API로 통합
// (매크로 지표(VIX/10년물/BTC)만 Yahoo에 남아있음 — 토스는 지수/암호화폐를 다루지 않음)
// 토스 캔들 API 공통 호출 — 개별 종목 조회(fetchStockData)와 벤치마크(RS 비교용) 조회가 공유
async function fetchCandleData(symbol) {
  const finalUrl = `${API_BASE}/api/toss/candles?symbol=${encodeURIComponent(
    symbol
  )}&interval=1d&count=180`;

  const response = await fetch(finalUrl);
  if (!response.ok) throw new Error("Network Error");
  const json = await response.json();

  const candles = json?.result?.candles;
  if (!candles || !candles.length) throw new Error("No candle result");

  // 토스 캔들은 최신순으로 내려오므로 오래된 순으로 뒤집음
  const chronological = [...candles].reverse();

  const opens = [];
  const closes = [];
  const highs = [];
  const lows = [];
  const volumes = [];

  for (const c of chronological) {
    const o = Number(c.openPrice);
    const cl = Number(c.closePrice);
    const h = Number(c.highPrice);
    const l = Number(c.lowPrice);
    const v = Number(c.volume);

    if ([o, cl, h, l, v].some((n) => Number.isNaN(n))) continue;

    opens.push(o);
    closes.push(cl);
    highs.push(h);
    lows.push(l);
    volumes.push(v);
  }

  if (closes.length < 2) throw new Error("Not enough clean OHLC data");

  return {
    symbol,
    price: closes[closes.length - 1],
    opens,
    closes,
    highs,
    lows,
    volumes
  };
}

async function fetchStockData(ticker) {
  const trimmed = (ticker || "").trim();
  const domestic = isDomesticTicker(trimmed);
  const symbol = domestic ? trimmed : trimmed.toUpperCase();

  console.log(`[RAVEN] Fetching (${domestic ? "domestic" : "overseas"}): ${symbol}`);

  try {
    return await fetchCandleData(symbol);
  } catch (error) {
    console.error("[RAVEN] 실시간 시세 불러오기 실패:", error);
    showToast("⚠️ 실시간 데이터 접속 실패. 분석을 진행할 수 없습니다.");
    throw error;
  }
}

// 상대강도(RS) 비교용 벤치마크 — 국내는 KODEX 200(069500, KOSPI200 추종 ETF), 해외는 SPY(S&P500 ETF)
// 실패해도 메인 분석은 그대로 진행되도록 조용히 null 반환 (토스트 없음)
async function fetchBenchmarkData(domestic) {
  const symbol = domestic ? "069500" : "SPY";
  try {
    return await fetchCandleData(symbol);
  } catch (e) {
    console.warn("[RAVEN] 벤치마크(RS) 데이터 조회 실패:", e);
    return null;
  }
}

// 개별 종목 vs 벤치마크의 20일/60일 수익률 격차 — "시장 대비 잘 가는지"를 직접 비교
// (예전엔 개별 종목 지표만 봐서, 업종/지수 전체가 빠지는 중에도 종목만 보고 좋다고 오판할 수 있었음)
function calcRelativeStrength(stockData, benchmarkData) {
  if (!stockData || !benchmarkData) return null;
  const sc = stockData.closes;
  const bc = benchmarkData.closes;
  if (!sc || !bc || sc.length < 21 || bc.length < 21) return null;

  const ret = (arr, lookback) => {
    const n = arr.length;
    if (n < lookback + 1) return null;
    const start = arr[n - 1 - lookback];
    if (!start) return null;
    return ((arr[n - 1] - start) / start) * 100;
  };

  const sRet20 = ret(sc, 20);
  const bRet20 = ret(bc, 20);
  const sRet60 = ret(sc, 60);
  const bRet60 = ret(bc, 60);

  return {
    rs20: sRet20 != null && bRet20 != null ? sRet20 - bRet20 : null,
    rs60: sRet60 != null && bRet60 != null ? sRet60 - bRet60 : null
  };
}

// 3-2. 환율(USD/KRW) — 토스증권 API
async function fetchTossFxRate() {
  try {
    const res = await fetch(`${API_BASE}/api/toss/exchange-rate?base=USD&quote=KRW`);
    if (!res.ok) return null;
    const json = await res.json();
    const rate = Number(json?.result?.rate);
    return Number.isFinite(rate) ? rate : null;
  } catch (e) {
    console.warn("[RAVEN] 토스 환율 조회 실패:", e);
    return null;
  }
}

async function fetchFxRate() {
  if (typeof fxRateKRW === "number") return fxRateKRW;

  const rate = await fetchTossFxRate();
  if (typeof rate === "number") {
    fxRateKRW = rate;
    return fxRateKRW;
  }
  return null;
}

// 3-3. 매크로 바 데이터 (+ Regime 태그)
async function fetchMacroData() {
  try {
    const [tnx, vix, krwRate, btc] = await Promise.all([
      fetchYahooChart("^TNX", "1d", "1d").catch(() => null),
      fetchYahooChart("^VIX", "1d", "1d").catch(() => null),
      fetchTossFxRate().catch(() => null),
      fetchYahooChart("BTC-USD", "1d", "1d").catch(() => null)
    ]);

    // 미국10년물
    let rate = null;
    if (tnx) {
      rate = tnx.lastClose / 10;
      if ($("macro-rate")) $("macro-rate").textContent = rate.toFixed(2) + "%";
      let note = "중립 구간";
      if (rate < 3) note = "저금리, 성장주 우호";
      else if (rate > 5) note = "고금리, 변동성 주의";
      if ($("macro-rate-note")) $("macro-rate-note").textContent = note;
    } else if ($("macro-rate-note")) {
      $("macro-rate-note").textContent = "데이터 수신 실패";
    }

    // VIX
    let vixVal = null;
    if (vix) {
      vixVal = vix.lastClose;
      if ($("macro-vix")) $("macro-vix").textContent = vixVal.toFixed(1);
      let note = "보통 변동성";
      if (vixVal < 15) note = "저변동성, 안정 구간";
      else if (vixVal > 25) note = "고변동성, 주의";
      if ($("macro-vix-note")) $("macro-vix-note").textContent = note;
    } else if ($("macro-vix-note")) {
      $("macro-vix-note").textContent = "데이터 수신 실패";
    }

    // KRW
    let krwVal = null;
    if (typeof krwRate === "number") {
      krwVal = krwRate;
      if ($("macro-krw"))
        $("macro-krw").textContent =
          "₩" + Math.round(krwVal).toLocaleString("ko-KR");
      let note = "중립 수준";
      if (krwVal > 1400) note = "원화 약세 · 수출주 우호";
      else if (krwVal < 1300) note = "원화 강세 · 수출주 부담";
      if ($("macro-krw-note")) $("macro-krw-note").textContent = note;
      fxRateKRW = krwVal;
    } else if ($("macro-krw-note")) {
      $("macro-krw-note").textContent = "데이터 수신 실패";
    }

    // BTC
    let btcVal = null;
    if (btc) {
      btcVal = btc.lastClose;
      if ($("macro-btc"))
        $("macro-btc").textContent =
          "$" + Math.round(btcVal).toLocaleString("en-US");
      let note = "중립/보통";
      if (btcVal > 80000) note = "Crypto 고점권, 변동 주의";
      else if (btcVal < 40000) note = "Crypto 저점/조정 구간";
      if ($("macro-btc-note")) $("macro-btc-note").textContent = note;
    } else if ($("macro-btc-note")) {
      $("macro-btc-note").textContent = "데이터 수신 실패";
    }

  } catch (e) {
    console.warn("[RAVEN] Macro fetch error:", e);
  }
}

// ===== 지표 헬퍼: EMA / RSI(Wilder) / MACD =====

function calcEMA(values, period) {
  const len = values.length;
  if (!Array.isArray(values) || len < period) return null;

  const k = 2 / (period + 1);

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += values[i];
  }
  let ema = sum / period;

  for (let i = period; i < len; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI_Wilder(closes, period = 14) {
  const n = closes.length;
  if (!Array.isArray(closes) || n <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < n; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);
  return rsi;
}

// EMA "시리즈"(각 시점별 값) — calcEMA는 마지막 값 하나만 주기 때문에
// MACD 시그널선(=MACD의 9-EMA)을 만들려면 MACD 자체의 시계열이 필요해서 별도로 둠
function calcEMASeries(values, period) {
  const len = values.length;
  if (!Array.isArray(values) || len < period) return null;

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

// MACD 라인 + 시그널선(9-EMA) + 히스토그램 + 골든/데드 크로스 감지
// (예전엔 MACD 라인 값 하나만 계산해서 크로스오버를 아예 감지할 수 없었음)
function calcMACDFull(closes) {
  if (!Array.isArray(closes) || closes.length < 26 + 9) return null;

  const ema12Series = calcEMASeries(closes, 12);
  const ema26Series = calcEMASeries(closes, 26);
  if (!ema12Series || !ema26Series) return null;

  const n = closes.length;
  const validStart = 26 - 1; // ema26가 유효해지는 시점부터 MACD 라인도 유효함

  const macdValid = [];
  for (let i = validStart; i < n; i++) {
    macdValid.push(ema12Series[i] - ema26Series[i]);
  }

  const signalValidSeries = calcEMASeries(macdValid, 9);
  if (!signalValidSeries) return null;

  const macdSeries = new Array(n).fill(null);
  const signalSeries = new Array(n).fill(null);
  for (let i = 0; i < macdValid.length; i++) {
    macdSeries[validStart + i] = macdValid[i];
    if (signalValidSeries[i] != null) signalSeries[validStart + i] = signalValidSeries[i];
  }

  const last = n - 1;
  const prev = n - 2;

  const macd = macdSeries[last];
  const signal = signalSeries[last];
  if (macd == null || signal == null) return null;
  const histogram = macd - signal;

  let crossover = "NONE";
  if (
    prev >= 0 &&
    macdSeries[prev] != null &&
    signalSeries[prev] != null
  ) {
    const prevDiff = macdSeries[prev] - signalSeries[prev];
    const currDiff = macd - signal;
    if (prevDiff <= 0 && currDiff > 0) crossover = "GOLDEN";
    else if (prevDiff >= 0 && currDiff < 0) crossover = "DEAD";
  }

  return { macd, signal, histogram, crossover };
}

// ATR(14, Wilder) — 변동성 기반 손절폭 계산용
// (예전엔 지지선이 없으면 종목 변동성과 무관하게 그냥 -5% 고정값을 손절가로 썼음)
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

// ADX(14) + DI+ / DI- — 추세의 "강도"를 측정 (예전엔 MA20/60 격차만으로 추세 강도를 대신 판단해서
// 강한 추세와 그냥 횡보 노이즈를 구분하지 못했음)
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
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      )
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

  const lastTR = trSmoothed[trSmoothed.length - 1];
  const plusDI = (plusDMSmoothed[plusDMSmoothed.length - 1] / lastTR) * 100;
  const minusDI = (minusDMSmoothed[minusDMSmoothed.length - 1] / lastTR) * 100;

  return { adx, plusDI, minusDI };
}

// ────────────────────────────────
// 스윙 포인트 → 지지/저항 레벨 클러스터링 헬퍼
// ────────────────────────────────
function clusterSwingLevels(levels, totalBars, tol = 0.03) {
  const TOL = tol;
  const clusters = [];

  levels.forEach((lv) => {
    const { price, idx } = lv;
    let found = null;

    for (const c of clusters) {
      const diff = Math.abs(price - c.price) / c.price;
      if (diff <= TOL) {
        found = c;
        break;
      }
    }

    if (!found) {
      clusters.push({
        price,
        idxs: [idx],
        lastIdx: idx
      });
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

function pickSupportResistance(clusters, lastPrice, isSupport) {
  const filtered = clusters.filter((c) =>
    isSupport ? c.price < lastPrice : c.price > lastPrice
  );
  if (!filtered.length) return [];

  filtered.sort((a, b) => b.score - a.score);
  const top = filtered.slice(0, 5);

  top.sort(
    (a, b) => Math.abs(lastPrice - a.price) - Math.abs(lastPrice - b.price)
  );

  return top;
}

// 5. 지표 계산 엔진
function analyzeData(data, benchmarkData) {
  const closes = data.closes;
  const highs = data.highs;
  const lows = data.lows;
  const volumes = data.volumes || [];
  const n = closes.length;

  const lastPrice = data.price || closes[n - 1];

  const rsInfo = benchmarkData ? calcRelativeStrength(data, benchmarkData) : null;

  const ma5 = calcEMA(closes, 5);
  const ma20 = calcEMA(closes, 20);
  const ma60 = calcEMA(closes, 60);
  const ma120 = calcEMA(closes, 120);

  let rsi = calcRSI_Wilder(closes, 14);
  if (rsi == null) {
    rsi = 50;
  }

  const macdFull = calcMACDFull(closes);
  const macd = macdFull ? macdFull.macd : null;
  const macdSignal = macdFull ? macdFull.signal : null;
  const macdHistogram = macdFull ? macdFull.histogram : null;
  const macdCrossover = macdFull ? macdFull.crossover : "NONE";

  const atr = calcATR(highs, lows, closes, 14);
  const atrPct = typeof atr === "number" && lastPrice > 0 ? (atr / lastPrice) * 100 : null;

  const adxInfo = calcADX(highs, lows, closes, 14);
  const adx = adxInfo ? adxInfo.adx : null;
  const plusDI = adxInfo ? adxInfo.plusDI : null;
  const minusDI = adxInfo ? adxInfo.minusDI : null;

  let support1 = null;
  let support2 = null;
  let resistance1 = null;
  let resistance2 = null;

  if (n >= 10) {
    const start = Math.max(2, n - 80);
    const swingLows = [];
    const swingHighs = [];

    // 좌우 2봉씩 비교하는 5봉 피벗 — 예전엔 좌우 1봉(3봉)만 봐서 하루짜리 노이즈도 죄다
    // "스윙 고점/저점"으로 잡혔음. 5봉 기준이 실제 스윙 트레이딩에서 쓰는 표준적인 폭.
    for (let i = start; i < n - 2; i++) {
      const h = highs[i];
      const l = lows[i];

      if (
        h > highs[i - 1] && h > highs[i - 2] &&
        h > highs[i + 1] && h > highs[i + 2]
      ) {
        swingHighs.push({ price: h, idx: i });
      }
      if (
        l < lows[i - 1] && l < lows[i - 2] &&
        l < lows[i + 1] && l < lows[i + 2]
      ) {
        swingLows.push({ price: l, idx: i });
      }
    }

    // 클러스터링 허용오차를 종목 변동성(ATR%)에 맞춰 조정 —
    // 예전엔 변동성 큰 종목/작은 종목 구분 없이 무조건 ±3% 고정이었음
    const swingTol = Number.isFinite(atrPct)
      ? Math.max(0.015, Math.min(0.08, (atrPct * 1.5) / 100))
      : 0.03;

    const lowClusters = clusterSwingLevels(swingLows, n, swingTol);
    const highClusters = clusterSwingLevels(swingHighs, n, swingTol);

    const supportLevels = pickSupportResistance(lowClusters, lastPrice, true);
    const resistanceLevels = pickSupportResistance(
      highClusters,
      lastPrice,
      false
    );

    if (supportLevels.length > 0) support1 = supportLevels[0].price;
    if (supportLevels.length > 1) support2 = supportLevels[1].price;

    if (resistanceLevels.length > 0) resistance1 = resistanceLevels[0].price;
    if (resistanceLevels.length > 1) resistance2 = resistanceLevels[1].price;

    // 오늘 봉 자체는 제외하고 계산 — 포함시키면 급등일에 "저항선"이 오늘 자신의 고점이 되어
    // 목표가가 현재가보다 낮게 나오는 모순이 생김 (실제로 재현되는 걸 확인하고 고침)
    if (support1 === null) {
      const recentLows = lows.slice(Math.max(0, n - 60), n - 1);
      if (recentLows.length) {
        const minLow = Math.min(...recentLows);
        if (minLow < lastPrice) support1 = minLow;
      }
    }
    if (resistance1 === null) {
      const recentHighs = highs.slice(Math.max(0, n - 60), n - 1);
      if (recentHighs.length) {
        const maxHigh = Math.max(...recentHighs);
        if (maxHigh > lastPrice) resistance1 = maxHigh;
      }
    }
  }

  // R:R / 목표가·손절
  // 지지선이 없을 때 예전엔 종목 변동성과 무관하게 고정 -5%를 손절가로 썼음 →
  // ATR(변동성) 기반 손절폭으로 대체. 저항선이 없을 때의 목표가도 고정 +5%/+15% 대신
  // "손절폭 대비 R:R 1.5 / 3.0"으로 잡아서, 화면에 뜨는 R:R 숫자가 실제 손절·목표가와 항상 일치하도록 함
  // (예전엔 R:R 표시가 원본 지지/저항 값 기준, 실제 손절/목표가는 버퍼 적용된 값 기준이라 서로 미묘하게 안 맞았음)
  const MAX_RISK_PCT = 25;
  const ATR_STOP_MULT = 2; // 진입가 - 2×ATR : 변동성 기반 손절폭의 표준적인 배수

  let stopBase;
  if (support1 && support1 < lastPrice) {
    stopBase = support1;
  } else if (typeof atr === "number" && atr > 0) {
    stopBase = lastPrice - ATR_STOP_MULT * atr;
  } else {
    stopBase = lastPrice * 0.95;
  }

  let riskPct = ((lastPrice - stopBase) / lastPrice) * 100;
  if (riskPct > MAX_RISK_PCT) {
    stopBase = lastPrice * (1 - MAX_RISK_PCT / 100);
    riskPct = MAX_RISK_PCT;
  }

  const stop = stopBase * 0.99;
  const riskAmount = lastPrice - stopBase;

  let target1, target2;
  if (resistance1) {
    target1 = resistance1 * 0.995;
    target2 = resistance2 ? resistance2 * 0.99 : resistance1 * 1.05;
  } else {
    target1 = lastPrice + riskAmount * 1.5;
    target2 = lastPrice + riskAmount * 3;
  }

  const rewardPct1 = ((target1 - lastPrice) / lastPrice) * 100;
  const rrRatio = riskPct > 0 ? rewardPct1 / riskPct : null;

  let dailyChangePct = null;
  if (n >= 2) {
    const prev = closes[n - 2];
    if (prev > 0) {
      dailyChangePct = ((lastPrice - prev) / prev) * 100;
    }
  }

  let volumeRatio = null;
  const vLen = volumes.length;
  if (vLen >= 21) {
    const todayVol = volumes[vLen - 1];
    const window = volumes.slice(vLen - 21, vLen - 1);
    const avg = window.reduce((a, b) => a + b, 0) / window.length;
    if (avg > 0) volumeRatio = todayVol / avg;
  }

  // 변동성 (20일 수익률 표준편차)
  let volatility = 0;
  if (n >= 21) {
    const rets = [];
    for (let i = n - 20; i < n; i++) {
      const r = (closes[i] - closes[i - 1]) / closes[i - 1];
      rets.push(r);
    }
    const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
    const varSum = rets.reduce((s, r) => s + Math.pow(r - avg, 2), 0);
    volatility = Math.sqrt(varSum / rets.length) * 100;
  }

  // RAVEN SCORE — 규칙 기반 가중합. 백테스트로 뽑은 가중치는 아니고, 각 항목은 아래 주석의 근거로 넣음.
  let score = 50;
  const len = closes.length;

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  let shortTrend = 0;
  if (len >= 6) {
    const base = closes[len - 6];
    shortTrend = ((lastPrice - base) / base) * 100;
  }
  score += clamp(shortTrend * 1.5, -15, 15);

  // 추세 강도 — 예전엔 MA20/60 스프레드만으로 "추세가 강한지"를 근사해서
  // 강한 추세와 그냥 횡보 노이즈를 구분하지 못했음. 방향은 MA20 vs MA60로,
  // 강도는 실제 ADX로 반영(ADX<15는 방향 신뢰도를 깎고, ADX>=25는 확대).
  let midTrendDir = 0;
  if (ma20 && ma60) {
    if (ma20 > ma60) midTrendDir = 1;
    else if (ma20 < ma60) midTrendDir = -1;
  }
  if (midTrendDir !== 0 && typeof adx === "number") {
    const adxStrength = clamp((adx - 15) / 15, 0, 1.4);
    score += midTrendDir * adxStrength * 12;
  } else if (ma20 && ma60) {
    // ADX 계산 불가(데이터 부족) 시에만 예전 방식(MA 스프레드 비율)으로 대체
    const midTrendFallback = ((ma20 - ma60) / ma60) * 100;
    score += clamp(midTrendFallback * 0.8, -12, 12);
  }

  if (rsi < 25) {
    score += 12;
  } else if (rsi < 35) {
    score += 6;
  } else if (rsi > 75) {
    score -= 12;
  } else if (rsi > 65) {
    score -= 6;
  } else if (rsi >= 45 && rsi <= 60) {
    score += 4;
  }

  let dist20 = 0;
  if (ma20) {
    dist20 = ((lastPrice - ma20) / ma20) * 100;
    const absDist = Math.abs(dist20);
    if (absDist < 2) score += 4;
    else if (absDist > 12) score -= 6;
  }

  if (volatility > 6) score -= 5;
  else if (volatility > 0 && volatility < 2) score -= 2;

  if (typeof rrRatio === "number") {
    if (rrRatio >= 2) score += 10;
    else if (rrRatio < 1) score -= 10;
  }

  // MACD 골든/데드 크로스 — 오늘 막 발생한 신선한 신호에만 소폭 가점/감점
  // (지속적인 방향성은 이미 위쪽 추세 강도(ADX) 항목에서 반영되므로 크로스오버는 "타이밍 보너스"로만 취급)
  if (macdCrossover === "GOLDEN") score += 5;
  else if (macdCrossover === "DEAD") score -= 5;

  // 지수 대비 상대강도(RS) — 예전엔 개별 종목 지표만 봐서, 업종/시장 전체가 빠지는 중에도
  // 종목만 보고 좋다고 오판할 수 있었음. 벤치마크(국내: KODEX200, 해외: SPY) 대비 20일 성과 격차를 반영.
  if (rsInfo && Number.isFinite(rsInfo.rs20)) {
    score += clamp(rsInfo.rs20 * 0.4, -8, 8);
  }

  score = Math.round(Math.max(0, Math.min(99, score)));

  let rank = "C";
  if (score >= 85) rank = "S";
  else if (score >= 70) rank = "A";
  else if (score >= 55) rank = "B";
  else if (score < 35) rank = "D";

  return {
    price: lastPrice,
    ma5,
    ma20,
    ma60,
    ma120,
    rsi,
    macd,
    macdSignal,
    macdHistogram,
    macdCrossover,
    atr,
    atrPct,
    adx,
    plusDI,
    minusDI,
    rsInfo,
    score,
    rank,
    support1,
    support2,
    resistance1,
    resistance2,
    riskPct,
    rewardPct1,
    rrRatio,
    target1,
    target2,
    stop,
    dailyChangePct,
    volumeRatio,
    volatility // ← TREND/Momentum/Vol/R:R 상단 뱃지용
  };
}

// ===============================
// 수급 / Why-Today / 전략 시나리오 / 캔들 패턴
// ===============================

// OBV(누적 거래량) 기반 다일간 수급 다이버전스 감지
// 예전 calcFlowSignal은 오늘 캔들 하나만 보고 수급을 판단해서, 진짜 여러 날에 걸친
// 기관 매집/분산과 하루짜리 거래량 튐을 구분하지 못했음. OBV로 최근 N일 누적 방향을 따로 확인.
function calcOBVSignal(closes, volumes, lookback = 10) {
  const n = closes.length;
  if (!Array.isArray(volumes) || volumes.length !== n || n < lookback + 1) return null;

  const obv = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    if (closes[i] > closes[i - 1]) obv[i] = obv[i - 1] + volumes[i];
    else if (closes[i] < closes[i - 1]) obv[i] = obv[i - 1] - volumes[i];
    else obv[i] = obv[i - 1];
  }

  const startIdx = n - 1 - lookback;
  const priceStart = closes[startIdx];
  const priceChangePct =
    priceStart !== 0 ? ((closes[n - 1] - priceStart) / priceStart) * 100 : 0;

  const obvStart = obv[startIdx];
  const obvEnd = obv[n - 1];
  const obvDelta = obvEnd - obvStart;
  // OBV 자체는 절대값이 무의미(누적치)해서, 최근 구간 거래량 평균으로 정규화해 "며칠치 거래량만큼 순매수/순매도가 쌓였나"로 표현
  const avgVol =
    volumes.slice(startIdx, n).reduce((a, b) => a + b, 0) / (n - startIdx || 1);
  const obvDeltaInVolDays = avgVol > 0 ? obvDelta / avgVol : 0;

  let divergence = "NONE";
  if (priceChangePct >= 1.5 && obvDeltaInVolDays <= -1.5) {
    divergence = "BEARISH"; // 가격은 오르는데 누적 수급은 빠지는 중 — 분산(고점 매집 소진) 가능성
  } else if (priceChangePct <= -1.5 && obvDeltaInVolDays >= 1.5) {
    divergence = "BULLISH"; // 가격은 빠지는데 누적 수급은 느는 중 — 저점 매집 가능성
  }

  return { priceChangePct, obvDeltaInVolDays, divergence, lookback };
}

function calcFlowSignal(data, analysis) {
  const { closes, highs, lows, opens } = data;
  const n = closes.length;
  if (!opens || opens.length !== n) {
    return {
      flowLabel: "데이터 부족",
      flowType: "NEUTRAL",
      flowNote: "캔들 몸통/꼬리 계산용 시가 데이터가 부족합니다."
    };
  }

  const i = n - 1;
  const o = opens[i];
  const c = closes[i];
  const h = highs[i];
  const l = lows[i];

  const body = Math.abs(c - o);
  const range = Math.max(h, l, o, c) - Math.min(h, l, o, c) || 1e-9;
  const bodyRatio = body / range;
  const upperWick = h - Math.max(o, c);
  const lowerWick = Math.min(o, c) - l;

  const volRatio = analysis.volumeRatio;

  let flowType = "NEUTRAL";
  let flowLabel = "수급 중립";
  let flowNote =
    "거래량과 봉 구조 모두 평균적인 수준 — 뚜렷한 수급 쏠림보다는 추세/지지·저항이 더 중요.";

  if (volRatio != null && volRatio >= 1.3 && bodyRatio >= 0.4 && c > o) {
    flowType = "BUY_DOMINANT";
    flowLabel = "매수세 우위";
    flowNote =
      `거래량이 최근 평균 대비 약 ${volRatio.toFixed(
        1
      )}배, 몸통이 긴 양봉입니다. ` +
      "기관·큰손 매수 유입 가능성이 높은 봉으로, 추세 이어질 경우 눌림 매수/추세 추종 구간이 될 수 있습니다.";
  } else if (volRatio != null && volRatio >= 1.3 && bodyRatio >= 0.4 && c < o) {
    flowType = "SELL_DOMINANT";
    flowLabel = "매도세 우위";
    flowNote =
      `거래량이 최근 평균 대비 약 ${volRatio.toFixed(
        1
      )}배, 몸통이 긴 음봉입니다. ` +
      "청산·손절이 한꺼번에 나온 봉일 가능성이 높고, 후속 하락 파동이 이어질 수 있는 자리입니다.";
  } else if (volRatio != null && volRatio >= 1.3 && bodyRatio < 0.3) {
    flowType = "BATTLE";
    flowLabel = "공방 치열";
    flowNote =
      `거래량은 평균 대비 높은데 몸통은 짧고 윗꼬리·아랫꼬리가 긴 봉입니다. ` +
      "매수·매도 공방이 치열한 자리로, 방향이 정해지기 전까지는 진입보다 관망이 유리할 수 있습니다.";
  } else if (volRatio != null && volRatio <= 0.6) {
    flowType = "EMPTY";
    flowLabel = "수급 공백";
    flowNote =
      "거래량이 평소 대비 현저히 적은 ‘수급 공백’ 구간입니다. 큰손이 자리를 잡기 전인 경우가 많아, 단기 트레이더는 매매 효율이 떨어질 수 있습니다.";
  } else if (
    bodyRatio < 0.15 &&
    upperWick > range * 0.35 &&
    lowerWick > range * 0.35
  ) {
    flowType = "INDECISION";
    flowLabel = "변곡 대기 (Doji)";
    flowNote = "윗/아랫꼬리가 모두 긴 도지형 — 다음 캔들 방향성이 핵심입니다.";
  } else if (lowerWick > body * 2 && c > o) {
    flowType = "REBOUND_BUY";
    flowLabel = "저가 매수 반발";
    flowNote = "아랫꼬리가 긴 양봉 — 지지선 인근의 반등 매수세 가능성.";
  } else if (upperWick > body * 2 && c < o) {
    flowType = "REJECTION_SELL";
    flowLabel = "상단 저항 매도";
    flowNote = "윗꼬리가 긴 음봉 — 저항선에서 매도 압력 강함.";
  }

  const obvInfo = calcOBVSignal(closes, data.volumes, 10);
  if (obvInfo && obvInfo.divergence !== "NONE") {
    const divNote =
      obvInfo.divergence === "BEARISH"
        ? `\n\n※ 최근 ${obvInfo.lookback}일 다이버전스 주의: 가격은 +${obvInfo.priceChangePct.toFixed(
            1
          )}% 올랐는데 누적 거래량(OBV) 기준 수급은 오히려 빠지는 중입니다. 상승이 소수의 거래에 의존하고 있어, 고점 분산(매집 소진) 가능성을 염두에 둬야 합니다.`
        : `\n\n※ 최근 ${obvInfo.lookback}일 다이버전스 포착: 가격은 ${obvInfo.priceChangePct.toFixed(
            1
          )}% 빠졌는데 누적 거래량(OBV) 기준 수급은 오히려 느는 중입니다. 저점에서 조용히 매집이 들어오고 있을 가능성이 있는 구간입니다.`;
    flowNote += divNote;
  }

  return { flowType, flowLabel, flowNote, bodyRatio, volRatio, obvInfo };
}

function calcWhyTodaySignal(data, analysis, flowInfo) {
  const { closes } = data;
  const n = closes.length;
  if (n < 2) {
    return {
      whyLabel: "평이한 세션",
      whyNote: "최근 데이터가 부족해 특이한 이벤트를 추정하기 어렵습니다."
    };
  }

  const chg = analysis.dailyChangePct;
  const gap =
    ((closes[n - 1] - closes[n - 2]) / closes[n - 2]) * 100 || chg || 0;
  const volRatio = analysis.volumeRatio;

  let whyLabel = "평이한 세션";
  let whyNote =
    "가격 변동과 거래량이 모두 평범한 범위 안에 있어, 특정 이벤트보다는 일상적인 수급 조정으로 보는 것이 자연스럽습니다.";

  if (chg != null && volRatio != null) {
    if (chg >= 3 && volRatio >= 1.5) {
      whyLabel = "강한 재료 가능성";
      whyNote =
        `당일 수익률이 약 ${chg.toFixed(
          1
        )}%이고 거래량이 평균의 ${volRatio.toFixed(
          1
        )}배 수준입니다. ` +
        "실적 서프라이즈, 가이던스 상향, 대형 수주/정책 호재, 또는 M&A 관련 뉴스 등 강한 재료가 개입됐을 확률이 높은 흐름입니다.";
    } else if (chg <= -3 && volRatio >= 1.5) {
      whyLabel = "악재/청산 가능성";
      whyNote =
        `당일 -${Math.abs(chg).toFixed(
          1
        )}% 급락과 함께 거래량이 평균의 ${volRatio.toFixed(
          1
        )}배 수준으로 급증했습니다. ` +
        "실적 쇼크, 가이던스 하향, 규제/소송 이슈, 또는 기관·펀드 청산성 매도가 나왔을 가능성이 높은 구간입니다.";
    } else if (Math.abs(chg) < 1 && volRatio <= 0.7) {
      whyLabel = "대기장/관망 구간";
      whyNote =
        "가격과 거래량 모두 잠잠한 구간입니다. 시장이 다음 이벤트(실적 발표, FOMC, 리포트 등)를 기다리는 ‘대기장’일 가능성이 높습니다.";
    }
  }

  return { whyLabel, whyNote, gapPct: gap };
}

// ────────────────────────────────
// 매수/매도/중립 최종 판정 — 배지·전략요약 공통 사용 (단일 기준, 중복 계산 금지)
// ────────────────────────────────
function computeVerdict(analysis) {
  const { rewardPct1: upPctRaw, riskPct: downPctRaw, rrRatio: rrRaw, rank } =
    analysis;

  const isValid =
    Number.isFinite(upPctRaw) &&
    Number.isFinite(downPctRaw) &&
    downPctRaw > 0 &&
    Number.isFinite(rrRaw);

  let tier = "NEUTRAL";
  if (isValid) {
    if (rrRaw >= 2) tier = "BUY";
    else if (rrRaw < 1) tier = "SELL";
  } else if (rank === "S" || rank === "A") {
    tier = "BUY";
  } else if (rank === "D") {
    tier = "SELL";
  }

  return { tier, isValid, upPctRaw, downPctRaw, rrRaw };
}

// 4) 캔들 패턴 인식 (12종 확장)
function detectCandlePatterns(data, analysis) {
  const { opens, closes, highs, lows } = data;
  const n = closes.length;
  if (!opens || opens.length !== n || n < 3) return [];

  const patterns = [];

  const idx = n - 1;
  const o = opens[idx];
  const c = closes[idx];
  const h = highs[idx];
  const l = lows[idx];

  const o1 = opens[idx - 1];
  const c1 = closes[idx - 1];
  const h1 = highs[idx - 1];
  const l1 = lows[idx - 1];

  const o2 = opens[idx - 2];
  const c2 = closes[idx - 2];
  const h2 = highs[idx - 2];
  const l2 = lows[idx - 2];

  const body = Math.abs(c - o);
  const range = Math.max(h, l, o, c) - Math.min(h, l, o, c) || 1e-9;
  const bodyRatio = body / range;
  const upperWick = h - Math.max(o, c);
  const lowerWick = Math.min(o, c) - l;

  const isBull = c > o;
  const isBear = c < o;

  const body1 = Math.abs(c1 - o1);
  const range1 =
    Math.max(h1, l1, o1, c1) - Math.min(h1, l1, o1, c1) || 1e-9;
  const isBull1 = c1 > o1;
  const isBear1 = c1 < o1;

  const body2 = Math.abs(c2 - o2);
  const range2 =
    Math.max(h2, l2, o2, c2) - Math.min(h2, l2, o2, c2) || 1e-9;
  const isBull2 = c2 > o2;
  const isBear2 = c2 < o2;

  const rsi = analysis.rsi;

  // 4-1) Bullish Engulfing
  if (
    isBull &&
    isBear1 &&
    o < c1 &&
    c > o1 &&
    bodyRatio > 0.4 &&
    body1 / (range1 || 1e-9) > 0.2
  ) {
    patterns.push({
      name: "Bullish Engulfing",
      strength: 3,
      comment:
        "전일 음봉을 통째로 감싸는 강한 양봉이 출현해, 단기 추세 전환/반등 가능성이 높은 패턴입니다."
    });
  }

  // 4-2) Bearish Engulfing
  if (
    isBear &&
    isBull1 &&
    o > c1 &&
    c < o1 &&
    bodyRatio > 0.4 &&
    body1 / (range1 || 1e-9) > 0.2
  ) {
    patterns.push({
      name: "Bearish Engulfing",
      strength: 3,
      comment:
        "전일 양봉을 통째로 뒤집는 강한 음봉이 출현해, 단기 상방 피로/조정 가능성이 높은 패턴입니다."
    });
  }

  // 4-3) Hammer (망치형)
  if (
    bodyRatio < 0.4 &&
    lowerWick > body * 2 &&
    upperWick < body * 0.5 &&
    isBull
  ) {
    patterns.push({
      name: "Hammer",
      strength: 2,
      comment:
        "아랫꼬리가 긴 망치형 캔들로, 아래꼬리 구간에서 매수 방어가 강하게 나온 신호입니다. 지지선 부근이라면 기술적 반등 가능성이 있습니다."
    });
  }

  // 4-4) Inverted Hammer / Shooting Star (역망치형)
  if (
    bodyRatio < 0.4 &&
    upperWick > body * 2 &&
    lowerWick < body * 0.5
  ) {
    if (isBear) {
      patterns.push({
        name: "Shooting Star",
        strength: 2,
        comment:
          "윗꼬리가 긴 역망치형 캔들로, 위쪽에서 매도 압력이 강하게 나온 신호입니다. 저항선 부근이라면 단기 피크/조정 가능성을 시사합니다."
      });
    } else {
      patterns.push({
        name: "Inverted Hammer",
        strength: 2,
        comment:
          "하락 추세 말단에서 나타나는 역망치형 패턴으로, 위꼬리와 작은 몸통이 결합된 형태입니다. 반등 시도 신호일 수 있으나 확인 봉이 중요합니다."
      });
    }
  }

  // 4-5) Doji / Dragonfly / Gravestone
  const isDoji = bodyRatio < 0.1;
  if (isDoji) {
    if (lowerWick > body * 4 && upperWick < body * 0.5) {
      patterns.push({
        name: "Dragonfly Doji",
        strength: 2,
        comment:
          "아랫꼬리가 긴 Dragonfly Doji로, 하락 중 매수 방어가 강하게 들어온 모양입니다. 지지선 부근이라면 반등 신호가 될 수 있습니다."
      });
    } else if (upperWick > body * 4 && lowerWick < body * 0.5) {
      patterns.push({
        name: "Gravestone Doji",
        strength: 2,
        comment:
          "윗꼬리가 긴 Gravestone Doji로, 상승 중 위에서 매도 압력이 강한 형태입니다. 저항 부근이라면 피크/조정 신호일 수 있습니다."
      });
    } else {
      patterns.push({
        name: "Doji",
        strength: 1,
        comment:
          "시가와 종가가 거의 같은 십자형 캔들로, 매수·매도 힘이 팽팽하게 맞선 변곡 신호입니다. 이후 봉의 방향성이 중요합니다."
      });
    }
  }

  // 4-6) Three White Soldiers
  const strongBull =
    isBull && bodyRatio > 0.5 && c > (h + l) / 2 && c > c1 && c1 > c2;
  if (
    strongBull &&
    isBull1 &&
    isBull2 &&
    body1 / (range1 || 1e-9) > 0.3 &&
    body2 / (range2 || 1e-9) > 0.3 &&
    o1 >= o2 &&
    o >= o1
  ) {
    patterns.push({
      name: "Three White Soldiers",
      strength: 4,
      comment:
        "3일 연속 강한 양봉이 계단식으로 이어지는 강력한 상승 패턴입니다. 추세 전환 또는 추세 강화 신호로, 눌림 매수/추세 추종 전략과 궁합이 좋습니다."
    });
  }

  // 4-7) Three Black Crows
  const strongBear =
    isBear && bodyRatio > 0.5 && c < (h + l) / 2 && c < c1 && c1 < c2;
  if (
    strongBear &&
    isBear1 &&
    isBear2 &&
    body1 / (range1 || 1e-9) > 0.3 &&
    body2 / (range2 || 1e-9) > 0.3 &&
    o1 <= o2 &&
    o <= o1
  ) {
    patterns.push({
      name: "Three Black Crows",
      strength: 4,
      comment:
        "3일 연속 강한 음봉이 계단식으로 이어지는 강력한 하락 패턴입니다. 기존 보유자는 리스크 관리, 신규 진입자는 관망/공매도 전략 검토 구간입니다."
    });
  }

  // 4-8) Bullish / Bearish Marubozu
  if (
    isBull &&
    bodyRatio > 0.8 &&
    upperWick < body * 0.1 &&
    lowerWick < body * 0.1
  ) {
    patterns.push({
      name: "Bullish Marubozu",
      strength: 3,
      comment:
        "시가 대비 거의 조정 없이 종가까지 쭉 뻗은 장대양봉으로, 하루 동안 매수세가 압도한 패턴입니다. 다음 날 갭락 리스크를 감안한 분할 접근이 유리합니다."
    });
  }

  if (
    isBear &&
    bodyRatio > 0.8 &&
    upperWick < body * 0.1 &&
    lowerWick < body * 0.1
  ) {
    patterns.push({
      name: "Bearish Marubozu",
      strength: 3,
      comment:
        "시가 대비 거의 반등 없이 종가까지 밀린 장대음봉으로, 하루 동안 매도세가 압도한 패턴입니다. 단기 반등이 나와도 재차 매물이 출회될 수 있는 구간입니다."
    });
  }

  // 4-9) Morning Star / Evening Star (3캔들 반전 패턴)
  const smallBody1 = body1 / (range1 || 1e-9) < 0.3;
  const smallBody2 = body2 / (range2 || 1e-9) < 0.3;

  if (
    isBull &&
    isBear1 &&
    isBear2 &&
    smallBody1 &&
    c > (o1 + c1) / 2 &&
    rsi &&
    rsi < 50
  ) {
    patterns.push({
      name: "Morning Star",
      strength: 3,
      comment:
        "하락 후 작은 몸통과 강한 양봉이 이어지는 상승 반전 패턴입니다. 지지선 근처에서 나타나면 추세 전환 신호로 볼 수 있습니다."
    });
  }

  if (
    isBear &&
    isBull1 &&
    isBull2 &&
    smallBody1 &&
    c < (o1 + c1) / 2 &&
    rsi &&
    rsi > 50
  ) {
    patterns.push({
      name: "Evening Star",
      strength: 3,
      comment:
        "상승 추세 후 작은 몸통과 강한 음봉이 이어지는 하락 반전 패턴입니다. 저항 부근에서는 피크 아웃 신호일 가능성이 높습니다."
    });
  }

  // 4-10) Harami (Inside 캔들)
  const isInsideBody =
    Math.min(o, c) > Math.min(o1, c1) &&
    Math.max(o, c) < Math.max(o1, c1) &&
    bodyRatio < body1 / (range1 || 1e-9);

  if (isInsideBody && bodyRatio < 0.4) {
    patterns.push({
      name: "Harami",
      strength: 2,
      comment:
        "전일 큰 몸통 안에 오늘 몸통이 들어온 내부형 패턴입니다. 추세가 둔화되며 방향 전환을 준비하는 구간일 수 있습니다."
    });
  }

  // 4-11) Piercing Line (관통형) — 하락 후 반전 시도, Bullish Engulfing보다는 약한 형태
  if (
    isBull &&
    isBear1 &&
    o <= c1 &&
    c > (o1 + c1) / 2 &&
    c < o1 &&
    body1 / (range1 || 1e-9) > 0.3
  ) {
    patterns.push({
      name: "Piercing Line",
      strength: 3,
      comment:
        "전일 음봉 몸통의 절반 이상을 되돌리는 양봉이 출현한 관통형 패턴입니다. 완전한 장악(Engulfing)만큼 강하진 않지만, 하락 흐름에 제동이 걸렸다는 신호로 볼 수 있습니다."
    });
  }

  // 4-12) Dark Cloud Cover (먹구름형) — 상승 후 반전 시도, Piercing Line의 대칭 패턴
  if (
    isBear &&
    isBull1 &&
    o >= c1 &&
    c < (o1 + c1) / 2 &&
    c > o1 &&
    body1 / (range1 || 1e-9) > 0.3
  ) {
    patterns.push({
      name: "Dark Cloud Cover",
      strength: 3,
      comment:
        "전일 양봉 몸통의 절반 이상을 되돌리는 음봉이 덮은 먹구름형 패턴입니다. 상승 추세 상단에서 나오면 매수세 소진·단기 조정 신호로 해석합니다."
    });
  }

  // 4-13) Spinning Top — Doji보다는 몸통이 있지만 위아래 꼬리가 균형 잡힌 방향성 부재형
  const wickBalance =
    Math.min(upperWick, lowerWick) > 0
      ? Math.max(upperWick, lowerWick) / Math.min(upperWick, lowerWick)
      : Infinity;
  if (
    bodyRatio >= 0.1 &&
    bodyRatio < 0.3 &&
    upperWick > body * 0.6 &&
    lowerWick > body * 0.6 &&
    wickBalance < 2.2
  ) {
    patterns.push({
      name: "Spinning Top",
      strength: 1,
      comment:
        "몸통은 작고 위아래 꼬리가 비슷하게 균형 잡힌 스피닝탑입니다. 매수·매도 힘이 팽팽해 방향성이 뚜렷하지 않은 구간으로, Doji만큼 극단적이진 않지만 관망 신호로 보는 편이 좋습니다."
    });
  }

  // 4-14) Tweezer Top / Bottom — 연속 두 캔들의 고가(혹은 저가)가 거의 일치
  const highDiff = Math.abs(h - h1) / (range1 || 1e-9);
  const lowDiff = Math.abs(l - l1) / (range1 || 1e-9);

  if (highDiff < 0.08 && isBull1 && isBear) {
    patterns.push({
      name: "Tweezer Top",
      strength: 2,
      comment:
        "전일과 오늘의 고점이 거의 같은 높이에서 막힌 집게형 상단 패턴입니다. 같은 가격대에서 매도 물량이 반복적으로 나왔다는 뜻으로, 저항선 부근이라면 신뢰도가 더 높아집니다."
    });
  }

  if (lowDiff < 0.08 && isBear1 && isBull) {
    patterns.push({
      name: "Tweezer Bottom",
      strength: 2,
      comment:
        "전일과 오늘의 저점이 거의 같은 높이에서 지지된 집게형 하단 패턴입니다. 같은 가격대에서 매수세가 반복적으로 들어왔다는 뜻으로, 지지선 부근이라면 신뢰도가 더 높아집니다."
    });
  }

  patterns.sort((a, b) => b.strength - a.strength);

  return patterns;
}

// 6-2. 종목 라벨 / 섹터 태깅 (간단 버전 보조)
function classifyTickerSymbol(symbol) {
  const s = (symbol || "").toUpperCase();
  const labels = [];

  if (["AAPL", "MSFT", "GOOGL", "META", "AMZN", "NVDA", "TSLA"].includes(s)) {
    labels.push("Mega Tech");
  }
  if (["NVDA", "AMD", "AVGO", "ASML", "TSM", "SMH", "SOXX"].includes(s)) {
    labels.push("Semi / AI");
  }

  if (s.endsWith("USD")) {
    labels.push("Crypto");
  }
  if (["QQQ", "SPY", "VOO", "DIA"].includes(s)) {
    labels.push("Index ETF");
  }

  return labels;
}

// 7. UI 업데이트 (섹터/패턴/시나리오 포함)
function updateUI(data, analysis, fxRate, stockName) {
  const priceEl = $("ticker-price");
  const scoreEl = $("ai-score");
  const rankEl = $("ai-rank");

  const trendEl = $("trend-txt");
  const momentumEl = $("momentum-txt");
  const waveEl = $("wave-txt");
  const supplyEl = $("supply-txt");
  const patternEl = $("pattern-txt"); // 패턴 카드
  const signalEl = $("signal-txt"); // 시그널 카드
  const fundEl = $("fund-txt");

  const rsiBox = $("rsi-txt");
  const macdBox = $("macd-txt");
  const labelBox = $("ticker-labels") || $("ticker-tags");

  // 목표가/손절 박스: id 우선순위 정리 (target1/2/stoploss 우선)
  const target1Box =
    $("target1") || $("target1-txt") || $("target-1") || $("tp1");
  const target2Box =
    $("target2") || $("target2-txt") || $("target-2") || $("tp2");
  const stopBox =
    $("stoploss") || $("stop-txt") || $("stop-loss") || $("stop") || $("sl");

  if ($("ticker-symbol")) {
    $("ticker-symbol").textContent = stockName || data.symbol;
  }

  // 국내 종목은 원화가 원래 통화이므로 달러 환산 없이 그대로 표시
  const isDomestic = isDomesticTicker(data.symbol);
  const formatPrice = isDomestic ? formatKRW : formatUSD;

  let priceText = formatPrice(analysis.price);
  if (!isDomestic && typeof fxRate === "number") {
    const krw = analysis.price * fxRate;
    priceText += " / ₩" + Math.round(krw).toLocaleString("ko-KR");
  }
  if (priceEl) priceEl.textContent = priceText;

  // 전일 대비 등락률 (주식앱처럼 ▲/▼ 표시)
  const changeEl = $("ticker-change");
  if (changeEl) {
    const chg = analysis.dailyChangePct;
    if (Number.isFinite(chg)) {
      const arrow = chg > 0 ? "▲" : chg < 0 ? "▼" : "-";
      const sign = chg > 0 ? "+" : "";
      changeEl.textContent = `${arrow} ${sign}${chg.toFixed(2)}%`;
      changeEl.classList.remove("positive", "negative", "neutral");
      changeEl.classList.add(chg > 0 ? "positive" : chg < 0 ? "negative" : "neutral");
    } else {
      changeEl.textContent = "-";
      changeEl.classList.remove("positive", "negative");
      changeEl.classList.add("neutral");
    }
  }

  // 라벨/섹터 태깅 (실제 섹터 + 보조 태그)
  if (labelBox) {
    labelBox.innerHTML = "";

    const labels = [];

    // 간단 심볼 분류 태그 (AI / Semi 등)
    const simpleLabels = classifyTickerSymbol(data.symbol);
    simpleLabels.forEach((t) => {
      if (!labels.includes(t)) labels.push(t);
    });

    labels.forEach((text) => {
      const span = document.createElement("span");
      span.className = "tag-pill label-pill";
      span.textContent = text;
      labelBox.appendChild(span);
    });
  }

  // 점수 / 랭크
  if (scoreEl) scoreEl.textContent = analysis.score;
  if (rankEl) rankEl.textContent = analysis.rank;

  const color =
    analysis.score >= 70
      ? "#10b981"
      : analysis.score >= 40
      ? "#3b82f6"
      : "#ef4444";
  if (scoreEl) {
    scoreEl.style.color = color;
    scoreEl.style.textShadow = `0 0 10px ${color}88`;
  }
  if (rankEl) {
    rankEl.style.color = color;
    rankEl.style.textShadow = `0 0 10px ${color}88`;
  }

  // ===== 3단계 판정 (매수 우위 / 중립·관망 / 매도 신중) =====
  // 배지·전략요약이 같은 판정을 공유하도록 computeVerdict() 하나로 통일 (중복 계산 금지)
  const verdict = computeVerdict(analysis);
  const { isValid, upPctRaw, downPctRaw, rrRaw, tier: verdictTier } = verdict;

  const VERDICT_STYLE = {
    BUY: { label: "매수 우위", color: "#10b981", bracket: "[매수]" },
    SELL: { label: "매도 신중", color: "#ef4444", bracket: "[주의]" },
    NEUTRAL: { label: "중립·관망", color: "#fbbf24", bracket: "[중립]" }
  };
  const { label: verdictLabel, color: verdictColor, bracket: verdictBracket } =
    VERDICT_STYLE[verdictTier];

  const badge = $("status-badge");
  if (badge) {
    badge.textContent = verdictLabel;
    badge.style.backgroundColor = verdictColor;
    badge.style.color = "white";
  }

  // ===== 메인 R:R 텍스트 =====
  let mainComment = "분석 결과가 여기에 표시됩니다.";

  if (isValid) {
    const upPct = upPctRaw.toFixed(1);
    const downPct = downPctRaw.toFixed(1);
    const rrText = rrRaw.toFixed(2);

    mainComment =
      `<span style="color:#10b981;">▲ UP: ${upPct}%</span> ` +
      `<span style="color:#ef4444; margin-left:6px;">▼ DOWN: ${downPct}%</span> ` +
      `<span style="color:#666; margin:0 6px;">·</span>` +
      `<span style="color:#3b82f6; font-weight:700;">R:R ≈ ${rrText} : 1</span> ` +
      `<span style="color:${verdictColor}; font-weight:600; margin-left:6px;">${verdictBracket}</span>`;
  } else {
    mainComment =
      "최근 구간에서 뚜렷한 지지·저항이 부족해, 기본 추세·모멘텀 기준으로만 평가합니다.";
  }

  const mainCommentEl = $("main-comment");
  if (mainCommentEl) {
    mainCommentEl.innerHTML = mainComment;
  }

  const {
    ma20,
    ma60,
    ma120,
    rsi,
    price,
    support1,
    support2,
    resistance1,
    rrRatio,
    riskPct,
    rewardPct1,
    target1,
    target2,
    stop,
    dailyChangePct,
    volumeRatio,
    volatility,
    adx,
    plusDI,
    minusDI,
    rsInfo
  } = analysis;

  // ==== 목표가/손절가 박스 (달러 + 현재가 대비 %) ====
  const fmtPct = (level, base) => {
    if (!Number.isFinite(level) || !Number.isFinite(base) || base === 0) {
      return null;
    }
    const pct = ((level - base) / base) * 100;
    const sign = pct >= 0 ? "+" : "";
    return `${sign}${pct.toFixed(1)}%`;
  };

  if (target1Box || target2Box || stopBox) {
    if (target1Box) {
      if (Number.isFinite(target1) && Number.isFinite(price)) {
        const pct = fmtPct(target1, price);
        target1Box.textContent = `${formatPrice(target1)} (${pct})`;
      } else {
        target1Box.textContent = "-";
      }
    }
    if (target2Box) {
      if (Number.isFinite(target2) && Number.isFinite(price)) {
        const pct = fmtPct(target2, price);
        target2Box.textContent = `${formatPrice(target2)} (${pct})`;
      } else {
        target2Box.textContent = "-";
      }
    }
    if (stopBox) {
      if (Number.isFinite(stop) && Number.isFinite(price)) {
        const pct = fmtPct(stop, price);
        stopBox.textContent = `${formatPrice(stop)} (${pct})`;
      } else {
        stopBox.textContent = "-";
      }
    }
  }

  // ==== 상단 Trend / Momentum / Vol / R:R 뱃지 텍스트 ====
  const rrBadge = $("factor-rr");

  // 팩터 뱃지 색상(강세/약세/중립) 적용
  const setFactorPill = (el, text, state) => {
    if (!el) return;
    el.textContent = text;
    el.classList.remove("factor-bull", "factor-bear", "factor-neutral");
    el.classList.add(
      state === "bull" ? "factor-bull" : state === "bear" ? "factor-bear" : "factor-neutral"
    );
  };

  if (rrBadge) {
    let rrTxt = "-";
    let rrState = "neutral";
    if (Number.isFinite(rrRatio) && Number.isFinite(riskPct)) {
      if (rrRatio >= 2) {
        rrTxt = "우위(매수)";
        rrState = "bull";
      } else if (rrRatio < 1) {
        rrTxt = "불리(주의)";
        rrState = "bear";
      } else {
        rrTxt = "중립";
      }
    }
    setFactorPill(rrBadge, `R:R: ${rrTxt}`, rrState);
  }

  // ==== Trend 카드 텍스트 ====
  if (trendEl) {
    let txt = "단기/중기 이평선 기준으로 추세를 평가합니다.";

    if (ma20 && ma60 && ma120) {
      const isBullTrend =
        ma20 > ma60 && ma60 > ma120 && price >= ma20 * 0.97 && price <= ma20 * 1.1;
      const isBullPullback =
        ma20 > ma60 && ma60 > ma120 && price < ma20 && price > ma60 * 0.97;
      const isBearTrend =
        ma20 < ma60 && price < ma20 && price < ma60 && price < ma120;

      if (isBullTrend) {
        txt =
          "20·60·120일선이 정배열이고, 현재가도 20일선 위에 위치한 전형적인 상승 추세 구간입니다. 추세 추종 매매가 유리한 자리입니다.";
      } else if (isBullPullback) {
        txt =
          "중장기적으로는 정배열 상승 추세지만, 현재가는 20일선 아래/60일선 위의 눌림 구간입니다. 추세 안에서의 단기 조정으로 보는 쪽이 자연스럽습니다.";
      } else if (isBearTrend) {
        txt =
          "20·60·120일선이 역배열에 가깝고, 현재가도 주요 이평선 아래에 위치한 약세/하락 추세 구간입니다. 반등보다는 하락 추세 연장이 우세한 자리입니다.";
      } else {
        txt =
          "이평선 배열과 현재가 위치가 애매한 중립/전환 구간입니다. 추세보다는 지지·저항과 수급 변화를 우선적으로 보는 편이 좋습니다.";
      }
    } else {
      txt = "이평선 데이터가 부족해 뚜렷한 추세 판단이 어렵습니다.";
    }

    // ADX(추세 강도) 보강 — 이평선 배열만으로는 "강한 추세"와 "방향 없는 횡보"를 구분하지 못해서 추가.
    // DI+/DI-까지 같이 표기해서 ADX 숫자만으론 알 수 없는 "강도가 어느 방향으로 쏠려있는지"도 보여줌.
    if (typeof adx === "number") {
      let diTxt = "";
      if (typeof plusDI === "number" && typeof minusDI === "number") {
        diTxt = plusDI > minusDI ? ", DI+ 우위(상승 압력)" : ", DI- 우위(하락 압력)";
      }
      if (adx >= 25) {
        txt += ` (ADX ${adx.toFixed(1)} — 추세 강도 뚜렷${diTxt}, 방향성 매매 신뢰도 높음)`;
      } else if (adx < 20) {
        txt += ` (ADX ${adx.toFixed(1)} — 추세 강도 약함, 횡보/노이즈 구간일 가능성)`;
      } else {
        txt += ` (ADX ${adx.toFixed(1)} — 추세 강도 보통${diTxt})`;
      }
    }

    // 지수 대비 상대강도(RS) — 개별 지표가 좋아도 시장 전체보다 못 가는 중이면 경고
    if (rsInfo && (Number.isFinite(rsInfo.rs20) || Number.isFinite(rsInfo.rs60))) {
      const fmtRs = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%p`;
      const parts = [];
      if (Number.isFinite(rsInfo.rs20)) parts.push(`20일 ${fmtRs(rsInfo.rs20)}`);
      if (Number.isFinite(rsInfo.rs60)) parts.push(`60일 ${fmtRs(rsInfo.rs60)}`);
      const primary = Number.isFinite(rsInfo.rs20) ? rsInfo.rs20 : rsInfo.rs60;
      let verdict = "시장과 비슷한 흐름";
      if (primary >= 5) verdict = "시장 대비 뚜렷한 아웃퍼폼";
      else if (primary <= -5) verdict = "시장 대비 뚜렷한 언더퍼폼 — 개별 지표가 좋아도 주의";
      txt += ` [지수 대비 상대강도: ${parts.join(" · ")} — ${verdict}]`;
    }

    trendEl.textContent = txt;
  }

  // ==== Momentum 카드 텍스트 ====
  if (momentumEl) {
    let txt = "";

    if (rsi >= 70) {
      txt =
        `RSI ${rsi.toFixed(
          1
        )}로 단기 과열 구간에 진입한 상태입니다. 추세는 강하지만 신규 진입보다는 분할 청산/눌림 대기가 더 유리할 수 있습니다.`;
    } else if (rsi >= 60) {
      txt =
        `RSI ${rsi.toFixed(
          1
        )}로 모멘텀은 강세 우위입니다. 추세 추종 관점에서 눌림 매수나 돌파 매매를 고려할 수 있는 구간입니다.`;
    } else if (rsi <= 30) {
      txt =
        `RSI ${rsi.toFixed(
          1
        )}로 과매도 구간에 가까운 자리입니다. 기술적 반등 여지는 있지만, 추세 자체가 약세라면 역추세 매매는 고위험 구간입니다.`;
    } else if (rsi <= 40) {
      txt =
        `RSI ${rsi.toFixed(
          1
        )}로 모멘텀은 다소 약세 쪽으로 기울어 있습니다. 추가 하락이 이어질 수 있어 보수적인 접근이 필요합니다.`;
    } else {
      txt =
        `RSI ${rsi.toFixed(
          1
        )}로 모멘텀은 중립 구간입니다. 뚜렷한 과열/과매도 신호보다는 추세와 지지·저항에서 방향성을 확인하는 편이 좋습니다.`;
    }

    momentumEl.textContent = txt;
  }

  // ===== Flow / WhyToday / 패턴 계산 =====
  const flowInfo = calcFlowSignal(data, analysis);
  const whyInfo = calcWhyTodaySignal(data, analysis, flowInfo);
  const patterns = detectCandlePatterns(data, analysis);

  const { support1: s1, support2: s2, resistance1: r1, price: px, rsi: rsiVal } =
    analysis;

  const nearSupport =
    typeof s1 === "number" &&
    typeof px === "number" &&
    ((px - s1) / px) * 100 <= 5;

  const nearResistance =
    typeof r1 === "number" &&
    typeof px === "number" &&
    ((r1 - px) / r1) * 100 <= 5;

  const rrOk =
    typeof rrRatio === "number" &&
    rrRatio >= 1.3 &&
    typeof riskPct === "number" &&
    riskPct > 0;

  // ==== Wave: 현재가 + S1/S2 + R1 퍼센트 한 방에 요약 ====
  if (waveEl) {
    const parts = [];

    const fmtLevelLine = (label, lv) => {
      if (!Number.isFinite(lv) || !Number.isFinite(px) || px === 0) return null;
      const pct = ((lv - px) / px) * 100;
      const sign = pct >= 0 ? "+" : "";
      return `${label} ${formatPrice(lv)} (${sign}${pct.toFixed(1)}%)`;
    };

    const s1Line = fmtLevelLine("1차 지지선", s1);
    const s2Line = fmtLevelLine("2차 지지선", s2);
    const r1Line = fmtLevelLine("1차 저항선", r1);

    if (s1Line) parts.push(s1Line);
    if (s2Line) parts.push(s2Line);
    if (r1Line) parts.push(r1Line);

    let summaryLine = "";
    if (parts.length) {
      summaryLine = `현재가 ${formatPrice(px)} 기준, ${parts.join(
        " · "
      )} 구간에 위치한 파동입니다.`;
    } else {
      summaryLine = `현재가 ${formatPrice(
        px
      )} 기준, 최근 스윙 고점·저점을 기준으로 한 명확한 지지·저항 레벨이 부족한 파동 구간입니다.`;
    }

    // Wave는 "지금 구조가 어떻게 생겼는지"만 순수하게 설명함 —
    // 매수/매도 전략 판단은 위쪽 RAVEN 전략요약(strategy-main/detail)에 이미 있어서 여기서 안 겹치게 함
    let detail =
      "최근 파동 구조와 지지·저항 위치를 기준으로 파동을 해석합니다.";

    if (s1 && r1) {
      if (nearSupport && !nearResistance) {
        detail =
          `현재가는 주요 지지선 근처(≈ ${s1.toFixed(
            2
          )})에 위치한 파동 하단 구간입니다. 이전 저점·매물대에서 형성된 자리로, ` +
          "지지선이 유지되는지 이탈하는지에 따라 다음 파동의 방향이 갈립니다.";
      } else if (!nearSupport && nearResistance) {
        detail =
          `현재가는 주요 저항선 근처(≈ ${r1.toFixed(
            2
          )})에 위치한 파동 상단 구간입니다. 이전 고점·매물대에서 형성된 자리로, ` +
          "저항을 돌파하는지 되밀리는지에 따라 다음 파동의 방향이 갈립니다.";
      } else if (nearSupport && nearResistance) {
        detail =
          "지지와 저항 레벨이 서로 가깝게 밀집한 박스 구간 상·하단에 동시에 걸쳐 있는 구조입니다. " +
          "박스 폭이 좁아, 어느 한쪽을 벗어나는 순간 다음 파동의 방향이 비교적 빠르게 드러나는 자리입니다.";
      } else {
        detail =
          `현재가는 지지선(≈ ${s1.toFixed(2)})과 저항선(≈ ${r1.toFixed(
            2
          )}) 사이 중간에 위치한 파동 중단 구간입니다. ` +
          "박스 상·하단 중 어느 쪽에 먼저 재접근하느냐가 다음 파동을 가늠하는 기준점이 됩니다.";
      }
    } else {
      detail =
        "최근 스윙 고점/저점을 기반으로 한 명확한 지지·저항 레벨이 충분히 잡히지 않은 구간입니다. " +
        "이 경우에는 이평선·RSI 등 모멘텀 지표와 상위 타임프레임 차트를 함께 보고 파동 위치를 판단하는 것이 좋습니다.";
    }

    waveEl.textContent = `${summaryLine}\n\n${detail}`;
  }

  // ==== Supply: 수급 + 왜 오늘 이런 흐름인가 ====
  if (supplyEl) {
    const { flowLabel, flowNote } = flowInfo;
    const { whyLabel, whyNote } = whyInfo;

    let txt =
      `[${flowLabel}] · [${whyLabel}] ` +
      "두 관점을 합쳐보면, 오늘 흐름은 다음과 같이 정리할 수 있습니다.\n\n";

    txt += `① 수급 측면: ${flowNote}\n\n`;
    txt += `② 이벤트/맥락 측면: ${whyNote}`;

    supplyEl.textContent = txt;
  }

  // ==== Pattern 카드 ====
  if (patternEl) {
    if (!patterns || patterns.length === 0) {
      patternEl.textContent =
        "오늘 일봉 기준으로는 교과서적인 강/약세 패턴이 뚜렷하게 감지되지 않습니다. " +
        "단일 봉보다는 추세와 지지·저항, 거래량을 함께 보고 해석하는 편이 좋습니다.";
    } else {
      const top = patterns[0];
      const others = patterns.slice(1, 3);
      const otherNames = others.map((p) => p.name).join(", ");

      let txt =
        `대표 패턴: [${top.name}] ` +
        `\n- 해석: ${top.comment}`;

      if (otherNames) {
        txt += `\n\n보조 패턴(참고용): ${otherNames}`;
      }

      patternEl.textContent = txt;
    }
  }

  // ==== Signal: 패턴 + 파동 + 수급 종합 ====
  if (signalEl) {
    const { flowType, flowLabel } = flowInfo;
    const top = patterns && patterns[0] ? patterns[0] : null;
    const topName = top ? top.name : null;
    const isDojiLike =
      topName === "Doji" ||
      topName === "Dragonfly Doji" ||
      topName === "Gravestone Doji";


    let txt = "";

    if (topName && isDojiLike) {
      // 도지 계열 패턴은 변곡 시나리오 위주
      if (nearSupport) {
        txt =
          `지지선(${s1.toFixed(
            2
          )}) 바로 위에서 ${topName} 패턴과 함께 [${flowLabel}] 수급이 나온 상태입니다.\n\n` +
          "● 시나리오 1) 지지선 위 양봉 마감 → 지지선 방어 확인 + 반등 시그널 강화\n" +
          "   → 다음 캔들이 지지선 위에서 중/장대 양봉으로 마감하면, 단기 반등 파동이 시작될 가능성이 큽니다.\n\n" +
          "● 시나리오 2) 지지선 이탈 음봉 마감 → 반등 실패 + 하락 파동 재개\n" +
          "   → 지지선 아래로 종가가 밀리면 손절/관망이 유리한 구간입니다.";
      } else if (nearResistance) {
        txt =
          `저항선(${r1.toFixed(
            2
          )}) 바로 아래에서 ${topName} 패턴이 출현했고, 수급은 [${flowLabel}] 상태입니다.\n\n` +
          "● 시나리오 1) 저항 돌파 양봉 마감 → 추세 연장/상단 돌파 신호\n" +
          "   → 다음 캔들이 저항선을 명확히 돌파한 양봉이면, 돌파 후 눌림 구간까지 단기 추세 추종 전략이 유리할 수 있습니다.\n\n" +
          "● 시나리오 2) 저항 맞고 음봉 마감 → 피크 아웃·조정 가능성\n" +
          "   → 저항선 터치 후 윗꼬리 긴 음봉으로 마감되면 단기 상방 피로 신호로, 분할 청산/헤지 관점이 필요합니다.";
      } else {
        txt =
          `${topName} 패턴(도지형)이 중립 구간에서 출현했습니다. ` +
          "현재 위치는 뚜렷한 지지·저항 레벨과 약간 떨어진 구간이어서, 다음 봉 방향성을 섣불리 단정 짓기 어렵습니다.\n\n" +
          "→ 다음 캔들의 몸통 방향(양/음)과 거래량이 함께 증가하는지 확인한 뒤, " +
          "지지·저항선 재접근 구간에서 진입/청산 타이밍을 잡는 것이 유리합니다.";
      }
    } else {
      const baseIntro = topName
        ? `대표 패턴 [${topName}]과(와) [${flowLabel}] 수급이 동시에 관찰됩니다. `
        : `[${flowLabel}] 수급을 기준으로 파동과 지지·저항을 종합 평가합니다. `;

      txt = baseIntro + "\n\n";

      if (nearSupport) {
        txt +=
          `현재가는 주요 지지선(${s1 ? s1.toFixed(2) : "N/A"}) 근처에 위치한 눌림 구간입니다. `;
        if (flowType === "BUY_DOMINANT" || flowType === "REBOUND_BUY") {
          txt +=
            "지지선에서 매수세가 우위인 구조라면, 다음 캔들이 지지선 위 양봉으로 마감할 경우 단기 매수 시그널로 해석할 수 있습니다.\n";
        } else if (flowType === "SELL_DOMINANT") {
          txt +=
            "다만 아직 매도 우위 흐름이 강하다면, 지지선 이탈 음봉이 한 번 더 나올 수 있어 보수적인 접근이 필요합니다.\n";
        } else {
          txt +=
            "수급이 중립에 가까워, 추가 하락 후 진짜 매수세가 들어오는지 한 차례 더 지켜본 뒤 진입하는 편이 안전합니다.\n";
        }
      } else if (nearResistance) {
        txt +=
          `현재가는 주요 저항선(${r1 ? r1.toFixed(2) : "N/A"}) 근처 상단 파동 영역입니다. `;
        if (flowType === "BUY_DOMINANT") {
          txt +=
            "강한 매수 우위 속에서 저항 돌파를 시도하는 구간이라, 다음 캔들이 저항 위에서 안착하면 돌파 추세 추종 시그널로 볼 수 있습니다.\n";
        } else if (
          flowType === "REJECTION_SELL" ||
          flowType === "SELL_DOMINANT"
        ) {
          txt +=
            "저항선에서 매도/청산이 강하게 나오는 형태라면, 다음 캔들이 저항 아래 음봉으로 마감될 경우 단기 조정/하락 파동 진입 신호로 볼 수 있습니다.\n";
        } else {
          txt +=
            "수급이 애매한 상태라, 돌파 실패 시 되돌림 폭이 커질 수 있습니다. 신규 매수보다는 기존 보유 물량 관리에 중점을 두는 편이 좋습니다.\n";
        }
      } else {
        txt +=
          "지지·저항 사이의 중립 파동 구간에 위치해 있어, 다음 캔들 하나만으로 방향성을 강하게 확정하긴 어렵습니다.\n" +
          "→ 이 구간에서는 박스 상·하단(지지/저항)에 다시 접근할 때의 수급 패턴을 보면서 진입/청산 타이밍을 잡는 전략이 적합합니다.\n";
      }

      if (rrOk) {
        txt +=
          `\n현재 구조 기준 R:R ≈ ${rrRatio.toFixed(
            2
          )}:1 (위험 ${riskPct.toFixed(
            1
          )}%, 기대 수익 ${rewardPct1.toFixed(
            1
          )}%)로 계산됩니다. ` +
          "손절 폭 대비 기대 수익이 충분히 유리한지(≥ 1.5:1)를 기준으로 진입 여부를 판단하는 것을 권장합니다.";
      }
    }

    signalEl.textContent = txt;
  }

  // ==== 자비스 전략 요약 (strategy-main / strategy-detail) ====
  const stratMain = $("strategy-main");
  const stratDetail = $("strategy-detail");

  if (stratMain || stratDetail) {
    // 위쪽 배지(status-badge)와 반드시 같은 판정을 쓰도록 verdict.tier 안에서만 세부 시나리오를 고름
    // (전에는 여기서 R:R 임계값을 따로 재계산해서 배지와 반대되는 문구가 뜨는 버그가 있었음)
    let mainTxt = "중립 / 관망 구간";
    let detailTxt =
      "지지선·저항선·RSI·R:R를 종합했을 때 뚜렷한 매수/매도 우위가 아닌 구간입니다. 레버리지/단기 트레이딩보다는 관망 또는 소량만 대응하는 것을 권장합니다.";

    const rrTxt = Number.isFinite(rrRatio)
      ? `R:R ≈ ${rrRatio.toFixed(2)}:1`
      : "R:R 계산 불가(지지·저항 부족, 등급 기준 판정)";

    if (verdict.tier === "BUY") {
      if (typeof rsiVal === "number" && rsiVal < 30) {
        mainTxt = "③ 과매도 역추세 (고위험)";
        detailTxt =
          `RSI가 ${rsiVal.toFixed(
            1
          )}로 과매도 구간에 진입한 상태입니다. 단기 기술적 반등 가능성은 있지만, 추세 자체가 약세라 고위험 역추세 전략입니다. ` +
          "포지션 크기를 줄이고, 지지선 이탈 시 재진입을 포기하는 강한 손절 기준이 필요합니다.";
      } else {
        mainTxt = "① 지지선 근처 눌림 매수 우위";
        detailTxt =
          (nearSupport
            ? `현재가가 1차 지지선(${s1 ? s1.toFixed(2) : "N/A"}) 근처에 위치하고, `
            : "") +
          `${rrTxt}로 손절 대비 기대 수익이 유리한 구조입니다. ` +
          "지지선 이탈 시 빠른 손절을 전제로 한 분할 매수 전략이 1안입니다.";
      }
    } else if (verdict.tier === "SELL") {
      if (nearResistance) {
        mainTxt = "② 저항선 근처 리스크 우위";
        detailTxt =
          `현재가가 1차 저항선(${
            r1 ? r1.toFixed(2) : "N/A"
          }) 근처 상단 파동에 위치해 있고, ${rrTxt}로 아래쪽 리스크가 더 큰 구조입니다. ` +
          "신규 매수보다는 기존 보유 물량의 분할 청산/헤지 전략이 1순위입니다.";
      } else {
        mainTxt = "④ R:R 불리 (위험 대비 보상 부족)";
        detailTxt =
          `현재 ${rrTxt}로, 손절 폭 대비 위쪽 기대 수익이 충분히 보상되지 않는 자리입니다. ` +
          "추세·수급이 좋아 보여도 진입보다는 다음 더 유리한 R:R 구간을 기다리는 것이 효율적입니다.";
      }
    }

    if (stratMain) stratMain.textContent = mainTxt;
    if (stratDetail) stratDetail.textContent = detailTxt;
  }

  // 5) Fund 섹터 (펀디멘탈 API 연동 전)
  if (fundEl) {
    fundEl.textContent =
      "현재 버전에서는 재무제표/밸류에이션 지표를 API로 직접 불러오지 않습니다. " +
      "관리자 모드의 Pro Raven Engine 구동이 필요합니다";
  }

  // 6) RSI / MACD 박스 (숫자 + 짧은 해석)
  if (rsiBox) {
    if (typeof rsi === "number") {
      let rsiNote = "중립";
      if (rsi >= 70) rsiNote = "과열";
      else if (rsi >= 60) rsiNote = "상승 우위";
      else if (rsi <= 30) rsiNote = "과매도";
      else if (rsi <= 40) rsiNote = "약세";
      rsiBox.textContent = `RSI(14) : ${rsi.toFixed(1)} (${rsiNote})`;
    } else {
      rsiBox.textContent = "RSI 데이터 부족";
    }
  }

  if (macdBox) {
    if (typeof analysis.macd === "number") {
      const dir = analysis.macd >= 0 ? "상승 우위" : "하락 우위";
      let crossTxt = "";
      if (analysis.macdCrossover === "GOLDEN") crossTxt = " · 골든크로스(매수 신호)";
      else if (analysis.macdCrossover === "DEAD") crossTxt = " · 데드크로스(매도 신호)";
      macdBox.textContent = `MACD (12-26-9) : ${
        analysis.macd >= 0 ? "+" : ""
      }${analysis.macd.toFixed(3)} (${dir})${crossTxt}`;
    } else {
      macdBox.textContent = "MACD 계산을 위한 데이터가 부족합니다.";
    }
  }

  // 마지막 분석 결과 저장
  lastAnalysis = {
    data,
    analysis,
    fxRate,
    flowInfo,
    whyInfo,
    patterns
  };
}

// ===============================
// TradingView 차트 위젯 연동
// ===============================
function renderTradingViewChart(symbol) {
  // HTML에서 우선순위대로 컨테이너 탐색
  let container =
    document.getElementById("tv-chart") ||
    document.getElementById("tradingview-chart") ||
    document.querySelector("[data-tv-chart]");

  if (!container) {
    console.warn(
      "[RAVEN] chart container (#tv-chart / #tradingview-chart / [data-tv-chart]) 없음"
    );
    return;
  }

  // id가 없으면 기본 id 부여
  if (!container.id) {
    container.id = "tv-chart";
  }
  const containerId = container.id;

  // 이전 차트 정리
  container.innerHTML = "";

  // TradingView 무료 위젯은 KRX(한국거래소) 실시간 데이터 재배포를 막아둬서
  // 국내 종목은 심볼 형식과 무관하게 항상 에러가 남 — 위젯 호출 자체를 생략하고 안내만 표시
  if (isDomesticTicker(symbol)) {
    container.innerHTML =
      '<div class="chart-placeholder">📈 국내 종목 차트는 준비 중입니다.<br />위 지표/분석 내용을 참고해 주세요.</div>';
    return;
  }

  const initWidget = () => {
    if (typeof TradingView === "undefined" || !TradingView.widget) {
      console.warn("[RAVEN] TradingView 객체 없음");
      return;
    }

    new TradingView.widget({
      autosize: true,
      symbol: symbol.toUpperCase(),
      // 기본 타임프레임: 일봉
      interval: "D",
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      locale: "en",
      toolbar_bg: "#000000",
      enable_publishing: false,
      hide_top_toolbar: false,
      hide_legend: false,
      save_image: false,
      container_id: containerId,
      // 기본 지표: RSI, MACD, MA(5/20/60/120)
      studies: [
        "RSI@tv-basicstudies",
        "MACD@tv-basicstudies",
        "MAExp@tv-basicstudies",
        "MAExp@tv-basicstudies",
        "MAExp@tv-basicstudies",
        "MAExp@tv-basicstudies"
      ],
      study_overrides: {
        "moving average 1.length": 5,
        "moving average 2.length": 20,
        "moving average 3.length": 60,
        "moving average 4.length": 120
      }
    });
  };

  if (typeof TradingView === "undefined") {
    const existing = document.querySelector('script[src*="tv.js"]');
    if (existing) {
      existing.onload = initWidget;
      return;
    }
    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/tv.js";
    script.onload = initWidget;
    document.head.appendChild(script);
  } else {
    initWidget();
  }
}

// ===============================
// 📑 상세 탭 (추세·모멘텀 / 수급 / 패턴·신호 / 실적)
// ===============================
function initResultTabs() {
  const tabBtns = document.querySelectorAll(".tab-btn");
  const track = $("tabs-track");
  if (!tabBtns.length || !track) return;

  tabBtns.forEach((btn, idx) => {
    btn.addEventListener("click", () => {
      tabBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      track.style.transform = `translateX(-${idx * 25}%)`;
    });
  });
}

// ===============================
// 📏 포지션 사이즈 계산기
// ===============================

// 분석 완료 시 통화 라벨과 진입가(현재가) 자동 입력
function preparePositionCalculator(isDomestic, currentPrice) {
  const capitalLabel = document.querySelector('label[for="pos-capital"]');
  if (capitalLabel) {
    capitalLabel.textContent = isDomestic ? "총 자본 (KRW 기준)" : "총 자본 (USD 기준)";
  }

  const entryEl = $("pos-entry");
  if (entryEl && Number.isFinite(currentPrice)) {
    entryEl.value = isDomestic ? Math.round(currentPrice) : currentPrice.toFixed(2);
  }
}

// 총 자본 · 리스크(%) · 진입가/손절가 기준으로 매수 수량과 손실 한도 계산
function calcPositionSize() {
  if (!lastAnalysis) {
    showToast("먼저 종목을 분석해 주세요.");
    return;
  }

  const { data, analysis } = lastAnalysis;
  const domestic = isDomesticTicker(data.symbol);
  const formatPrice = domestic ? formatKRW : formatUSD;

  const capital = Number($("pos-capital")?.value);
  const riskPct = Number($("pos-risk")?.value);
  const entryPrice = Number($("pos-entry")?.value) || analysis.price;
  const stopPrice = analysis.stop;

  const sizeEl = $("pos-size");
  const riskAmountEl = $("pos-risk-amount");

  if (!Number.isFinite(capital) || capital <= 0) {
    showToast("총 자본을 입력해 주세요.");
    return;
  }
  if (!Number.isFinite(riskPct) || riskPct <= 0) {
    showToast("트레이드당 리스크(%)를 입력해 주세요.");
    return;
  }
  if (!Number.isFinite(entryPrice) || !Number.isFinite(stopPrice)) {
    showToast("진입가/손절가 정보가 부족해 계산할 수 없습니다.");
    return;
  }

  const riskPerShare = Math.abs(entryPrice - stopPrice);
  if (riskPerShare <= 0) {
    showToast("진입가와 손절가가 같아 계산할 수 없습니다.");
    return;
  }

  const riskAmount = capital * (riskPct / 100);
  const quantity = Math.floor(riskAmount / riskPerShare);
  const actualLoss = quantity * riskPerShare;

  if (sizeEl) sizeEl.textContent = `수량: ${quantity.toLocaleString()}주`;
  if (riskAmountEl) riskAmountEl.textContent = `손실 한도: ${formatPrice(actualLoss)}`;
}

// 전일 수급 해석 박스 렌더링 (국내 종목 전용, 결과 카드 표시 후 비동기로 채워짐)
function renderSupplyDemandBox(data) {
  const box = $("supply-kis-box");
  if (!box) return;

  if (!data || !data.lines || !data.lines.length) {
    box.classList.add("hidden");
    return;
  }

  const dateEl = $("supply-kis-date");
  const listEl = $("supply-kis-list");
  const outlookEl = $("supply-kis-outlook");

  if (dateEl) dateEl.textContent = data.date ? `기준일: ${data.date}` : "";
  if (listEl) {
    listEl.innerHTML = "";
    data.lines.forEach((line) => {
      const li = document.createElement("li");
      li.textContent = line;
      listEl.appendChild(li);
    });
  }
  if (outlookEl) outlookEl.textContent = data.outlook || "";

  box.classList.remove("hidden");
}

// ===============================
// 메인 실행 로직 (티커 입력 + 버튼/엔터)
// ===============================
async function runAnalysisForTicker(rawSymbol) {
  const symbol = resolveTickerInput(rawSymbol).toUpperCase();
  if (!symbol) {
    showToast("티커를 입력해 주세요. (예: NVDA, AAPL)");
    return;
  }

  // 🔹 새 실행 시: 이전 결과 카드 잠깐 숨기기
  hideResultCard();

  // 🔹 로딩 스피너 ON
  showLoading(true);

  try {
    const domestic = isDomesticTicker(symbol);
    // 벤치마크(RS 비교용)도 여기서 같이 병렬 조회 — RS가 이제 RAVEN SCORE 계산에 직접 들어가서
    // analyzeData()가 실행되기 전에 준비돼 있어야 함 (예전엔 렌더링 끝난 뒤 텍스트만 나중에 덧붙였음)
    const [data, fxRate, stockName, benchmarkData] = await Promise.all([
      fetchStockData(symbol),
      fetchFxRate(),
      domestic ? fetchDomesticStockName(symbol) : fetchOverseasStockName(symbol),
      fetchBenchmarkData(domestic)
    ]);

    const analysis = analyzeData(data, benchmarkData);
    updateUI(data, analysis, fxRate, stockName);
    preparePositionCalculator(domestic, analysis.price);

    // 차트 위젯 렌더
    renderTradingViewChart(symbol);

    // 🔹분석 성공 → 메인 화면도 보라 배경 유지
    document.body.classList.add("raven-result-bg");

    // 🔹 모든 세팅이 끝난 뒤 결과 카드 페이드인
    showResultCard();

    // 전일 수급 해석은 국내 종목만 지원 — 메인 분석을 늦추지 않도록 비동기로 별도 로드
    const supplyKisBox = $("supply-kis-box");
    if (domestic) {
      if (supplyKisBox) supplyKisBox.classList.add("hidden");
      fetchSupplyDemandComment(symbol).then(renderSupplyDemandBox);
    } else if (supplyKisBox) {
      supplyKisBox.classList.add("hidden");
    }
  } catch (err) {
    console.error("[RAVEN] 분석 중 오류:", err);
    showToast("분석 중 오류가 발생했습니다. 티커/네트워크를 확인해 주세요.");
    // 에러 시에는 hideResultCard() 상태 유지 (이미 위에서 호출됨)
  } finally {
    // 🔹 로딩 스피너 OFF
    showLoading(false);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  // 🔒 PIN + 인트로 + 엔트리 화면 초기화
  initLockAndIntro();

  // 국내 종목명 자동완성 (엔트리 화면 + 메인 검색창)
  attachTickerAutocomplete($("entry-ticker"));
  attachTickerAutocomplete($("ticker-input"));

  // 📏 포지션 사이즈 계산기 CALC 버튼
  const posCalcBtn = $("pos-calc-btn");
  if (posCalcBtn) posCalcBtn.addEventListener("click", calcPositionSize);

  // 📑 상세 탭 (추세·모멘텀 / 수급 / 패턴·신호 / 실적)
  initResultTabs();

  // ----- 아래로 기존 검색/분석 로직 그대로 유지 -----
  const input = $("ticker-input");
  const form =
    document.getElementById("analyze-form") ||
    document.getElementById("ticker-form");
  const btn =
    document.getElementById("analyze-btn") ||
    document.getElementById("search-btn");

  const handle = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (!input) return;
    runAnalysisForTicker(input.value);
  };

  if (form && input) {
    form.addEventListener("submit", handle);
  }

  if (btn && input) {
    btn.addEventListener("click", handle);
  }

  if (input) {
    input.addEventListener("keyup", (ev) => {
      if (ev.key === "Enter") {
        handle(ev);
      }
    });
  }

  fetchMacroData().catch((e) =>
    console.warn("[RAVEN] macro fetch on load failed:", e)
  );
});
