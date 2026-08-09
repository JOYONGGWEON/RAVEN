// =======================
// RAVEN v1.0 - Pattern / Signal / Target / Chart 통합 버전
// =======================

// Trend / Momentum / Vol / R:R 카테고리 상태 (추후 버튼화용)
let activeCategory = "trend";

// 1. 설정
// corsproxy.io 공개 프록시 의존 제거 — 이제 백엔드 서버가 Yahoo Finance를 직접 호출함.
// 로컬(localhost/127.0.0.1)에서 열면 로컬 백엔드를, GitHub Pages 등 배포된 곳에서 열면
// Render 백엔드를 자동으로 쓰도록 분기 — 정적 사이트라 빌드 시점 환경변수 주입이 없어서
// 접속 호스트로 판단함.
const API_BASE =
  window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? "http://localhost:3001"
    : "https://raven-backend-z5uc.onrender.com";

// FX 캐시 & 마지막 분석 결과(포지션 계산용)
let fxRateKRW = null;

// 헤드라인 지수/매크로 지표의 마지막 값 스냅샷 — { value, changePct } 형태로 id별 저장.
// AI 분석 요청 시 "화면에 보이는 개별 종목 지표뿐 아니라 오늘 시장 전반 분위기"를 같이 보내기 위한
// 용도(요청받은 AI 알고리즘 업그레이드, 2026-08-01) — renderIndexChip()에서 채움.
let marketSnapshot = {};
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

// 페이지 새로고침·재검색 시 가격/지수 값이 정적으로 뚝 바뀌는 대신 이전 값에서 새 값으로
// 굴러가듯 카운트업되는 시각 효과. 실시간 데이터 스트리밍이 아니라 순수 애니메이션임 —
// 실제로 몇 초마다 값이 갱신되는 건 아니고, 한 번 불러온 값을 부드럽게 보여주는 용도.
// el.dataset.animFrom에 마지막으로 표시한 숫자값을 저장해둬서, 나중에 같은 요소가 다시
// 갱신될 때(예: 다른 종목 재검색) 0이 아니라 이전 값에서부터 자연스럽게 이어서 움직이게 함.
function animateNumberText(el, toValue, formatFn, duration = 600) {
  if (!el || !Number.isFinite(toValue)) return;

  const prevValue = Number(el.dataset.animFrom);
  const fromValue = Number.isFinite(prevValue) ? prevValue : 0;
  const startTime = performance.now();

  function tick(now) {
    const t = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic — 끝으로 갈수록 느려짐
    el.textContent = formatFn(fromValue + (toValue - fromValue) * eased);
    if (t < 1) {
      requestAnimationFrame(tick);
    } else {
      el.dataset.animFrom = String(toValue);
    }
  }
  requestAnimationFrame(tick);
}

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

// 검색/분석 실패 시 결과 카드 대신 표시 — 토스트(3초)만 있으면 사라진 뒤 헤더만 덩그러니
// 남아 보였던 문제를 해결하기 위해, 다음 검색을 시작하기 전까지 계속 남아있는 안내로 대체.
function showSearchErrorState() {
  const el = $("search-error-state");
  if (el) el.classList.remove("hidden");
}

function hideSearchErrorState() {
  const el = $("search-error-state");
  if (el) el.classList.add("hidden");
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

// PIN 성공 후: GOOD DAY TODAY :) → RAVEN is online → 티커 입력
function playIntroSequence() {
  if (!introScreen) return;

  showOverlayScreen(introScreen);

  if (!introTitleEl || !introSubEl) return;

  introTitleEl.textContent = "GOOD DAY TODAY :)";
  introSubEl.textContent = "⚡RAVEN is online";

  introTitleEl.classList.remove("intro-hidden", "intro-visible-short");
  introSubEl.classList.remove("intro-visible-short");
  introSubEl.classList.add("intro-hidden");

  // 인트로 타이틀 2초 페이드인 (끝까지 남아있음)
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

  // chartPreviousClose = 전일 종가 — 지수/선물 카드의 등락률(%) 계산용
  const previousClose =
    typeof meta.chartPreviousClose === "number" ? meta.chartPreviousClose : null;

  return { meta, closes, lastClose, previousClose };
}

// 국내(KOSPI/KOSDAQ) 종목코드는 숫자 6자리, 해외는 알파벳 티커
// 서버 kisMarket.js의 isDomesticSymbol()과 동일한 정규식으로 통일(2026-08-04, 보원케미칼처럼
// 알파벳 섞인 코드를 쓰는 스팩/최근상장 종목이 "해외"로 잘못 분류되던 버그 수정).
function isDomesticTicker(ticker) {
  return /^(?=.*\d)[0-9A-Za-z]{6}$/.test((ticker || "").trim());
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

// 국내 종목코드 → 시장구분(KOSPI/KOSDAQ) 조회 (관심종목 뱃지 표시용) — 같은 엔드포인트를 쓰지만
// 상장목록은 하루 단위로만 바뀌므로, 세션 안에서는 심볼당 한 번만 조회하도록 캐싱함.
const domesticMarketCache = new Map(); // symbol -> "KOSPI" | "KOSDAQ" | null
async function fetchDomesticStockMarket(code) {
  if (domesticMarketCache.has(code)) return domesticMarketCache.get(code);
  try {
    const res = await fetch(`${API_BASE}/api/stocks/name?code=${encodeURIComponent(code)}`);
    if (!res.ok) return null;
    const json = await res.json();
    const market = json.market || null;
    domesticMarketCache.set(code, market);
    return market;
  } catch (e) {
    console.warn("[RAVEN] 시장구분 조회 실패:", e);
    return null;
  }
}

// 해외 티커 → 한글 종목명 조회 (결과 화면 타이틀 표시용)
// KIS "해외주식 상품기본정보"(search-info)의 prdt_name 필드가 한글명을 그대로 줌(예: FLNC→"플루언스 에너지").
// 값이 없으면(신규상장 등) null 반환 — updateUI()의 stockName || data.symbol 폴백이 티커로 표시함.
async function fetchOverseasStockName(symbol) {
  try {
    const res = await fetch(`${API_BASE}/api/kis/overseas-name?symbol=${encodeURIComponent(symbol)}`);
    if (!res.ok) return null;
    const json = await res.json();
    return json.name || null;
  } catch (e) {
    console.warn("[RAVEN] 해외 종목 한글명 조회 실패:", e);
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

// 분기별 손익계산서(실적 탭) — 국내는 KIS, 해외는 Yahoo Finance(Phase 5, 5단계)로 분기.
// 두 백엔드 라우트 모두 같은 응답 모양({ result: { quarters } })으로 맞춰둬서 프론트는 출처만 바꿔 호출하면 됨.
async function fetchIncomeStatementData(symbol, domestic) {
  const path = domestic
    ? `/api/kis/income-statement?symbol=${encodeURIComponent(symbol)}`
    : `/api/yahoo/income-statement?symbol=${encodeURIComponent(symbol)}`;
  try {
    const res = await fetch(`${API_BASE}${path}`);
    if (!res.ok) return null;
    const json = await res.json();
    return (json.result && json.result.quarters) || null;
  } catch (e) {
    console.warn("[RAVEN] 실적 조회 실패:", e);
    return null;
  }
}

// 뉴스 탭 — 국내/해외 둘 다 KIS 하나로 커버됨(Phase 5, 4단계)
async function fetchNewsData(symbol) {
  try {
    const res = await fetch(`${API_BASE}/api/kis/news?symbol=${encodeURIComponent(symbol)}`);
    if (!res.ok) return null;
    const json = await res.json();
    return (json.result && json.result.news) || null;
  } catch (e) {
    console.warn("[RAVEN] 뉴스 조회 실패:", e);
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

// 3-1. 개별 종목 데이터 (OHLC + Volume) — 국내/해외 모두 KIS Developers API로 통합
// (매크로 지표(VIX/10년물/유가)는 Yahoo에 남아있음 — KIS는 지수/원자재를 다루지 않음)
// KIS 캔들 API 공통 호출 — 개별 종목 조회(fetchStockData)와 벤치마크(RS 비교용) 조회가 공유
async function fetchCandleData(symbol) {
  const finalUrl = `${API_BASE}/api/kis/candles?symbol=${encodeURIComponent(
    symbol
  )}&interval=1d&count=180`;

  const response = await fetch(finalUrl);
  if (!response.ok) throw new Error("Network Error");
  const json = await response.json();

  const candles = json?.result?.candles;
  if (!candles || !candles.length) throw new Error("No candle result");

  // KIS 캔들은 최신순으로 내려오므로 오래된 순으로 뒤집음
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

// 장중 단기 흐름(해외는 60분봉, 국내는 호출 자체를 안 함 — 위 fetchStockData 호출부 주석 참고).
// 2026-08-03: 1분봉 RSI가 스윙 타임프레임과 안 맞는 노이즈였다는 피드백을 받아 해외를 60분봉으로
// 전환(server/src/lib/kisMarket.js). "지금 장중 흐름이 일봉 추세와 같은 방향인지" 보는 보조
// 지표라는 목적은 그대로. 장 마감 후/개장 전엔 데이터가 부족하거나 다 같은 값일 수 있어 그 경우엔
// 여전히 soft-fail로 null 반환(메인 분석엔 영향 없음).
async function fetchIntradayCandles(symbol) {
  const finalUrl = `${API_BASE}/api/kis/candles?symbol=${encodeURIComponent(
    symbol
  )}&interval=1m&count=200`;

  try {
    const response = await fetch(finalUrl);
    if (!response.ok) throw new Error("Network Error");
    const json = await response.json();

    // 실측 확인: KIS가 PINC=0일 땐 "오늘 장중 지금까지 경과한 시간만큼"만 60분봉을 주므로(예:
    // 개장 3시간 지났으면 3개), 하루 최대치(미국 기준 6~7개)보다 훨씬 적은 게 정상 — 예전 1분봉
    // 시절의 최소 30개 기준을 그대로 두면 장 초반엔 항상 데이터 부족으로 soft-fail되므로 3개로 낮춤
    const candles = json?.result?.candles;
    if (!candles || candles.length < 3) throw new Error("Not enough intraday candles");

    const chronological = [...candles].reverse();
    const closes = [];
    for (const c of chronological) {
      const cl = Number(c.closePrice);
      if (!Number.isNaN(cl)) closes.push(cl);
    }
    if (closes.length < 3) throw new Error("Not enough clean intraday closes");

    return closes;
  } catch (e) {
    console.warn("[RAVEN] 장중 단기 데이터 조회 실패:", e);
    return null;
  }
}

// 60분봉 종가 배열로 단기 모멘텀 해석 — RSI(14, 60분봉 기준) + 구간 전반부 대비 후반부 가격 가속도.
// 60분봉으로 바뀌면서 "minutes"라는 이름은 더 이상 정확하지 않지만(실제로는 "봉 개수"), narrative
// 쪽에서 시간 단위로 환산해서 쓰므로 필드명은 유지(barCount 의미로 재해석).
function calcIntradayMomentum(closes) {
  if (!Array.isArray(closes) || closes.length < 3) return null;

  const n = closes.length;
  const rsi = calcRSI_Wilder(closes, Math.min(14, n - 1));

  const half = Math.floor(n / 2);
  const firstAvg = closes.slice(0, half).reduce((a, b) => a + b, 0) / half;
  const secondAvg = closes.slice(half).reduce((a, b) => a + b, 0) / (n - half);
  const changePct = firstAvg !== 0 ? ((secondAvg - firstAvg) / firstAvg) * 100 : 0;

  let direction = "NEUTRAL";
  if (changePct >= 0.3) direction = "UP";
  else if (changePct <= -0.3) direction = "DOWN";

  return { rsi, changePct, direction, minutes: n };
}

// 2026-08-03 알고리즘 리뷰: 국내 종목은 KIS가 인트라데이 간격 확장을 안 줘서(60분봉 불가) 스윙
// 도구엔 일봉만으로는 아쉬운 중기 프레임 공백이 있었음 — 국내 전용 KIS 엔드포인트가
// FID_PERIOD_DIV_CODE=W로 주봉을 그대로 주는 걸 확인해서(서버 kisMarket.js 참고) 도입.
// 국내 전용(해외는 이미 60분봉으로 커버됨).
async function fetchWeeklyCandles(symbol) {
  const finalUrl = `${API_BASE}/api/kis/weekly-candles?symbol=${encodeURIComponent(symbol)}`;
  try {
    const response = await fetch(finalUrl);
    if (!response.ok) throw new Error("Network Error");
    const json = await response.json();

    const candles = json?.result?.candles;
    if (!candles || candles.length < 21) throw new Error("Not enough weekly candles");

    const chronological = [...candles].reverse();
    const closes = [];
    for (const c of chronological) {
      const cl = Number(c.closePrice);
      if (!Number.isNaN(cl)) closes.push(cl);
    }
    if (closes.length < 21) throw new Error("Not enough clean weekly closes");

    return closes;
  } catch (e) {
    console.warn("[RAVEN] 주봉 데이터 조회 실패:", e);
    return null;
  }
}

// 주봉 종가로 중기 추세 판단 — 일봉의 MA20/60(단기~중기)과 같은 방식이지만 주봉 EMA5(≈1개월)
// vs EMA20(≈5개월)로, "몇 달짜리 중기 추세"를 별도 확인. 며칠짜리 일봉 신호와 몇 달짜리 주봉
// 추세가 같은 방향이면 신뢰도가 높고, 반대면(예: 일봉은 반등 중인데 주봉은 여전히 하락 추세)
// "그 반등이 중기 하락 추세 속의 일시적 되돌림일 수 있다"는 경고 근거가 됨.
function calcWeeklyTrend(weeklyCloses) {
  if (!Array.isArray(weeklyCloses) || weeklyCloses.length < 21) return null;

  const ma5 = calcEMA(weeklyCloses, 5);
  const ma20 = calcEMA(weeklyCloses, 20);
  if (ma5 == null || ma20 == null) return null;

  let direction = "FLAT";
  if (ma5 > ma20) direction = "UP";
  else if (ma5 < ma20) direction = "DOWN";

  const gapPct = ma20 !== 0 ? ((ma5 - ma20) / ma20) * 100 : 0;
  return { ma5, ma20, direction, gapPct };
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

// 3-2. 환율(USD/KRW) — Yahoo Finance(KRW=X). 지연시세지만 환율은 장중 변동폭이 작아 영향 미미.
async function fetchYahooFxRate() {
  try {
    const res = await fetch(`${API_BASE}/api/yahoo/exchange-rate`);
    if (!res.ok) return null;
    const json = await res.json();
    const rate = Number(json?.result?.rate);
    return Number.isFinite(rate) ? rate : null;
  } catch (e) {
    console.warn("[RAVEN] 환율 조회 실패:", e);
    return null;
  }
}

async function fetchFxRate() {
  if (typeof fxRateKRW === "number") return fxRateKRW;

  const rate = await fetchYahooFxRate();
  if (typeof rate === "number") {
    fxRateKRW = rate;
    return fxRateKRW;
  }
  return null;
}


// 3-4. 헤드라인 지수 10개(5열x2행) + 펼치기 패널의 지수/선물 4종 — 전부 지수/선물/환율/원자재라
// KIS 미지원, 매크로 지표와 동일하게 Yahoo Finance로 조회. 코스피/코스닥도 KIS 종목시세 API가
// 있긴 하지만 지수 종류가 전부 Yahoo 하나로 통일돼 있어야 코드 경로가 단순해서 그대로 Yahoo를 씀.
// 환율(KRW=X)/유가(CL=F)는 2026-08-01부터 여기로 옮겨와 다른 지수와 동일한 ▲/▼% 칩 형태로
// 표시됨(기존 정성적 해석문구 스타일은 폐기). 코스피 야간선물(idx-kospi-night)은 Yahoo에 티커가
// 없어 이 목록엔 없음 — 대신 2026-08-04부터 KIS 자체 API(국내선물옵션 시세, inquire-price)로
// 별도 연동함(아래 fetchKospiNightFutures 참고). 비공식 kred.dev API는 검토만 하고 채택 안 함.
const HEADLINE_INDEXES = [
  { id: "kospi", symbol: "^KS11" },
  { id: "kosdaq", symbol: "^KQ11" },
  { id: "nasdaq", symbol: "^IXIC" },
  { id: "nq-fut", symbol: "NQ=F" },
  { id: "sp500", symbol: "^GSPC" },
  { id: "es-fut", symbol: "ES=F" },
  { id: "sox", symbol: "^SOX" },
  { id: "fx", symbol: "KRW=X", prefix: "₩", decimals: 0 },
  { id: "oil", symbol: "CL=F", prefix: "$" }
];

// 다우존스/러셀2000선물/미국10년물/VIX — 펼치기 패널 한 줄(4개)에 표시. 전부 다른 지수와 동일한
// 칩 스타일로 통일함(세로 정렬·크기가 서로 달라 보이던 문제 — 2026-08-01 사용자 피드백으로 통일).
const EXPANDED_CHIPS = [
  { id: "dow", symbol: "^DJI" },
  { id: "rty-fut", symbol: "RTY=F" },
  // ^TNX(미국10년물)는 Yahoo가 이미 실제 금리(%) 값을 그대로 줌(예: 4.68=4.68%) — 10배 스케일
  // 지수로 착각해 /10 하던 예전 버그가 있었으니 재발 방지 차 이 주석을 남겨둠.
  { id: "rate10y", symbol: "^TNX", suffix: "%" },
  { id: "vix", symbol: "^VIX", decimals: 1 }
];

function renderIndexChip(id, chartData, opts = {}) {
  const box = $(`idx-${id}`);
  if (!box) return;
  const valueEl = box.querySelector(".index-chip-value");
  const changeEl = box.querySelector(".index-chip-change");
  if (!valueEl || !changeEl) return;

  if (!chartData || typeof chartData.previousClose !== "number") {
    valueEl.textContent = "--";
    changeEl.textContent = "데이터 없음";
    changeEl.className = "index-chip-change";
    return;
  }

  const { lastClose, previousClose } = chartData;
  const changePct = ((lastClose - previousClose) / previousClose) * 100;
  const arrow = changePct > 0 ? "▲" : changePct < 0 ? "▼" : "-";
  const cls = changePct > 0 ? "sentiment-pos" : changePct < 0 ? "sentiment-neg" : "";
  const decimals = opts.decimals ?? 2;
  const prefix = opts.prefix || "";
  const suffix = opts.suffix || "";

  marketSnapshot[id] = { value: lastClose, changePct };

  animateNumberText(
    valueEl,
    lastClose,
    (v) => prefix + v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix
  );
  changeEl.textContent = `${arrow} ${Math.abs(changePct).toFixed(2)}%`;
  changeEl.className = `index-chip-change ${cls}`;
}

async function fetchIndexData() {
  const chipDefs = [...HEADLINE_INDEXES, ...EXPANDED_CHIPS];
  const results = await Promise.all(
    chipDefs.map((def) => fetchYahooChart(def.symbol, "1d", "1d").catch(() => null))
  );

  chipDefs.forEach((def, i) => {
    renderIndexChip(def.id, results[i], def);
    // fetchFxRate()가 쓰는 기존 캐시 변수 — 환율 칩이 렌더링될 때마다 같이 채워서 다른 곳(포지션
    // 계산기 등)의 환율 캐시도 최신 상태로 유지.
    if (def.id === "fx" && results[i] && typeof results[i].lastClose === "number") {
      fxRateKRW = results[i].lastClose;
    }
  });
}

// 코스피200 선물(정규장/야간장 공통) — KIS는 지수가 아니라 개별 종목처럼 실시간 체결가만 주는
// 방식이라 Yahoo 지수들과 응답 모양이 달라 별도 함수로 분리. renderIndexChip이 기대하는
// {lastClose, previousClose} 모양은 백엔드가 이미 맞춰서 반환하므로 그대로 재사용 가능.
async function fetchKospiNightFuturesData() {
  const box = $("idx-kospi-night");
  try {
    const res = await fetch(`${API_BASE}/api/kis/kospi-night-futures`);
    if (!res.ok) throw new Error("Network Error");
    const json = await res.json();
    const data = json && json.result;
    if (!data || typeof data.lastClose !== "number") throw new Error("No result");
    if (box) box.classList.remove("index-chip-pending");
    renderIndexChip("kospi-night", data, {});
  } catch (e) {
    console.warn("[RAVEN] 코스피 야간선물 조회 실패:", e);
    if (box) {
      const valueEl = box.querySelector(".index-chip-value");
      const changeEl = box.querySelector(".index-chip-change");
      if (valueEl) valueEl.textContent = "--";
      if (changeEl) {
        changeEl.textContent = "데이터 없음";
        changeEl.className = "index-chip-change";
      }
    }
  }
}

// 헤드라인 아래 "▼ 전체 지표 보기" 토글 — 다우존스/러셀2000선물/10년물/VIX(칩 4개, 한 줄)를 펼침/접음
function toggleMacroExpanded() {
  const panel = $("macro-expanded");
  const label = $("macro-toggle-label");
  if (!panel) return;

  const willShow = !panel.classList.contains("macro-expanded-open");
  panel.classList.toggle("macro-expanded-open");
  if (label) label.textContent = willShow ? "▲ 지표 접기" : "▼ 전체 지표 보기";
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

// RSI가 과매도(30)/과열(70) 기준선을 "오늘 막" 넘었는지 감지 — MACD 크로스오버와 같은 개념을
// RSI에도 적용. Wilder 스무딩은 과거를 안 돌아보는 방식이라, 어제까지의 종가만으로 다시 계산하면
// 그게 곧 "어제자 RSI"가 됨.
function detectRSICross(closes, period = 14) {
  const n = closes.length;
  if (n < period + 3) return "NONE";

  const todayRSI = calcRSI_Wilder(closes, period);
  const prevRSI = calcRSI_Wilder(closes.slice(0, n - 1), period);
  if (todayRSI == null || prevRSI == null) return "NONE";

  if (prevRSI <= 30 && todayRSI > 30) return "BUY";
  if (prevRSI >= 70 && todayRSI < 70) return "SELL";
  return "NONE";
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

// MA20/60 골든·데드크로스 "이벤트" 감지 — 어제→오늘 사이에 대소관계가 막 뒤집혔는지만 봄
// (상태가 아니라 사건 기준이라 며칠째 정배열이어도 매일 반복해서 신호가 뜨지 않음).
// 2026-08-03 알고리즘 리뷰: 이 감지 로직은 원래 server/src/lib/signalDetector.js(관심종목
// 텔레그램 알림 전용)에만 있었고, 온디맨드 분석(이 파일)은 MA20/60의 "지금 상태"(정배열/역배열)만
// 보고 "오늘 막 크로스했다"는 이벤트는 전혀 몰랐음 — 같은 종목인데 텔레그램은 골든크로스를
// 근거로 매수 알림을 보내는 사이 화면 분석은 그 사실 자체를 언급 못 하는 불일치가 있었음.
// signalDetector.js의 detectMACross()와 동일한 로직을 그대로 복제(중복이지만, 이 파일은 브라우저
// 전용이라 서버 모듈을 require할 수 없어서 별도 구현 — 두 파일의 기존 컨벤션과 동일).
function detectMaCross(closes) {
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

// 2026-08-04 알고리즘 리뷰: 20/60/120일선이 역배열(하락 추세)인 상태에서 "가격이 5일선을
// 거래량을 동반하며 뚫어내는" 최초의 순간을 세력 진입/추세전환 초입 신호로 볼 수 있는지 사용자가
// 문의 — 실제로 트레이더들이 참고하는 패턴이 맞음(가장 빠른 이평선이라 초기 반전 신호로 쓰임).
// 다만 "빠른 신호"는 태생적으로 "노이즈에도 빠르게 반응"한다는 뜻이라, 거래량 확인 없이 쓰면
// 대부분 데드캣 바운스(하락 추세 중 일시 반등 후 재하락)로 끝남 — 그래서 이 함수는 반드시
// 역배열(추세 컨텍스트) + 거래량 확인(volumeRatio) 둘 다 있어야만 신호로 침("빠른 진입 =
// 손절 폭이 좁아 R:R 자체는 좋아지지만, 그만큼 승률은 낮아지는 트레이드오프"라는 걸 서술에도 명시).
// 상승 추세(정배열) 쪽도 대칭으로 같이 감지 — "정배열 중 5일선 하향 이탈 + 거래량"은 상승 추세
// 초기 균열 신호로 볼 수 있음.
function detectMa5Breakout(closes, ma20, ma60, volumeRatio) {
  const ma5Series = calcEMASeries(closes, 5);
  if (!ma5Series || typeof ma20 !== "number" || typeof ma60 !== "number") return null;

  const n = closes.length;
  const todayMa5 = ma5Series[n - 1];
  const prevMa5 = ma5Series[n - 2];
  if (todayMa5 == null || prevMa5 == null) return null;

  const prevClose = closes[n - 2];
  const todayClose = closes[n - 1];
  const volumeConfirmed = Number.isFinite(volumeRatio) && volumeRatio >= 1.5;

  const reverseArray = ma20 < ma60; // 역배열(하락 추세 컨텍스트)
  const normalArray = ma20 > ma60; // 정배열(상승 추세 컨텍스트)

  if (reverseArray && prevClose <= prevMa5 && todayClose > todayMa5) {
    return { type: "BULL_BREAK", volumeConfirmed };
  }
  if (normalArray && prevClose >= prevMa5 && todayClose < todayMa5) {
    return { type: "BEAR_BREAK", volumeConfirmed };
  }
  return null;
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

  return { macd, signal, histogram, crossover, macdSeries };
}

// MACD 다이버전스 — 가격은 오르는데 MACD 모멘텀은 꺾이는(또는 그 반대) 구간 감지.
// OBV 다이버전스와 같은 방식(구간 시작 vs 끝 비교)으로, MACD 라인 값 자체는 가격 스케일에 따라
// 절대값이 들쭉날쭉해서 구간 내 값 범위 대비 상대적인 변화폭(%)으로 정규화함.
function detectMacdDivergence(closes, macdSeries, lookback = 20) {
  const n = closes.length;
  if (!Array.isArray(macdSeries) || n < lookback + 1) return null;

  const startIdx = n - 1 - lookback;
  if (macdSeries[startIdx] == null || macdSeries[n - 1] == null) return null;

  const priceStart = closes[startIdx];
  const priceChangePct =
    priceStart !== 0 ? ((closes[n - 1] - priceStart) / priceStart) * 100 : 0;

  const macdSlice = macdSeries.slice(startIdx, n).filter((v) => v != null);
  const macdRange = macdSlice.length
    ? Math.max(...macdSlice) - Math.min(...macdSlice) || 1e-9
    : 1e-9;
  const macdDeltaPct =
    ((macdSeries[n - 1] - macdSeries[startIdx]) / macdRange) * 100;

  let divergence = "NONE";
  if (priceChangePct >= 1.5 && macdDeltaPct <= -15) {
    divergence = "BEARISH"; // 가격은 오르는데 MACD 모멘텀은 이미 꺾이는 중 — 상승 동력 약화
  } else if (priceChangePct <= -1.5 && macdDeltaPct >= 15) {
    divergence = "BULLISH"; // 가격은 빠지는데 MACD 모멘텀은 개선되는 중 — 하락 동력 약화
  }

  return { priceChangePct, macdDeltaPct, divergence, lookback };
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

  // adxSeries를 남겨서 "지금 ADX가 몇인지"뿐 아니라 "최근 며칠 사이 강해지는지/약해지는지"도
  // 판단할 수 있게 함 — 예전엔 마지막 값 하나만 남겨서 숫자가 같아도 강화/약화 국면을 구분 못 했음.
  const adxSeries = [];
  let adx = validDx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  adxSeries.push(adx);
  for (let i = period; i < validDx.length; i++) {
    adx = (adx * (period - 1) + validDx[i]) / period;
    adxSeries.push(adx);
  }

  const lastTR = trSmoothed[trSmoothed.length - 1];
  const plusDI = (plusDMSmoothed[plusDMSmoothed.length - 1] / lastTR) * 100;
  const minusDI = (minusDMSmoothed[minusDMSmoothed.length - 1] / lastTR) * 100;

  return { adx, plusDI, minusDI, adxSeries };
}

// ADX 시리즈로 "추세 강도가 강해지는 중인지 약해지는 중인지" 판단 —
// ADX 숫자 자체는 25로 같아도, 15에서 올라오는 중인지 35에서 내려오는 중인지는 완전히 다른 국면임
function detectAdxTrend(adxSeries, lookback = 5) {
  if (!Array.isArray(adxSeries) || adxSeries.length < lookback + 1) return "FLAT";
  const last = adxSeries[adxSeries.length - 1];
  const prev = adxSeries[adxSeries.length - 1 - lookback];
  const delta = last - prev;
  if (delta >= 3) return "RISING";
  if (delta <= -3) return "FALLING";
  return "FLAT";
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

function pickSupportResistance(clusters, lastPrice, isSupport, maxDistPct = 0.3) {
  const filtered = clusters.filter((c) => {
    if (isSupport ? c.price >= lastPrice : c.price <= lastPrice) return false;
    const distPct = Math.abs(lastPrice - c.price) / lastPrice;
    return distPct <= maxDistPct;
  });
  if (!filtered.length) return [];

  filtered.sort((a, b) => b.score - a.score);
  const top = filtered.slice(0, 5);

  top.sort(
    (a, b) => Math.abs(lastPrice - a.price) - Math.abs(lastPrice - b.price)
  );

  return top;
}

// 5. 지표 계산 엔진
function analyzeData(data, benchmarkData, intradayCloses, weeklyCloses) {
  const closes = data.closes;
  const highs = data.highs;
  const lows = data.lows;
  const volumes = data.volumes || [];
  const n = closes.length;

  const lastPrice = data.price || closes[n - 1];

  const rsInfo = benchmarkData ? calcRelativeStrength(data, benchmarkData) : null;
  const intradayInfo = calcIntradayMomentum(intradayCloses);
  const weeklyTrend = calcWeeklyTrend(weeklyCloses);

  const ma5 = calcEMA(closes, 5);
  const ma20 = calcEMA(closes, 20);
  const ma60 = calcEMA(closes, 60);
  const ma120 = calcEMA(closes, 120);

  let rsi = calcRSI_Wilder(closes, 14);
  if (rsi == null) {
    rsi = 50;
  }
  const rsiCross = detectRSICross(closes, 14);

  const macdFull = calcMACDFull(closes);
  const macd = macdFull ? macdFull.macd : null;
  const macdSignal = macdFull ? macdFull.signal : null;
  const macdHistogram = macdFull ? macdFull.histogram : null;
  const macdCrossover = macdFull ? macdFull.crossover : "NONE";
  const macdDivergence = macdFull
    ? detectMacdDivergence(closes, macdFull.macdSeries, 20)
    : null;
  const maCrossover = detectMaCross(closes);

  const atr = calcATR(highs, lows, closes, 14);
  const atrPct = typeof atr === "number" && lastPrice > 0 ? (atr / lastPrice) * 100 : null;

  const adxInfo = calcADX(highs, lows, closes, 14);
  const adx = adxInfo ? adxInfo.adx : null;
  const plusDI = adxInfo ? adxInfo.plusDI : null;
  const minusDI = adxInfo ? adxInfo.minusDI : null;
  const adxTrend = adxInfo ? detectAdxTrend(adxInfo.adxSeries) : "FLAT";

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

    // 지지/저항 후보의 최대 허용 거리 — 예전엔 터치 횟수(score)만으로 순위를 매겨서,
    // 몇 달 전 오래된 고점/저점이 지금 가격과 20~50%+ 떨어져 있어도 "1차/2차"로 뽑히는 문제가 있었음
    // (실제로 재현: 지지 -20.6%, 저항 +56.2% 같은 비현실적인 레벨이 나온 걸 확인함).
    // ATR% 기반으로 "지금 실제로 의미 있는 거리"만 후보로 남기고, 그 안에 없으면 그냥 없는 걸로 처리
    // (아래 60봉 fallback 로직이 대신 더 가까운 값을 잡아줌).
    const srMaxDist = Number.isFinite(atrPct)
      ? Math.max(0.12, Math.min(0.3, (atrPct * 6) / 100))
      : 0.18;

    const supportLevels = pickSupportResistance(lowClusters, lastPrice, true, srMaxDist);
    const resistanceLevels = pickSupportResistance(
      highClusters,
      lastPrice,
      false,
      srMaxDist
    );

    if (supportLevels.length > 0) support1 = supportLevels[0].price;
    if (supportLevels.length > 1) support2 = supportLevels[1].price;

    if (resistanceLevels.length > 0) resistance1 = resistanceLevels[0].price;
    if (resistanceLevels.length > 1) resistance2 = resistanceLevels[1].price;

    // 오늘 봉 자체는 제외하고 계산 — 포함시키면 급등일에 "저항선"이 오늘 자신의 고점이 되어
    // 목표가가 현재가보다 낮게 나오는 모순이 생김 (실제로 재현되는 걸 확인하고 고침)
    //
    // ⚠️ 이 fallback도 위 클러스터링 픽과 똑같이 srMaxDist(최대 허용 거리)를 적용해야 함 —
    // 처음엔 클러스터링 쪽만 고쳤는데, 실제 종목(삼성전기)에서 60봉 최고가가 현재가 대비 +64%나
    // 떨어져 있는데도 그대로 저항선/목표가로 잡히는 게 재현됨. 여기서도 벗어나면 그냥 null로 두고
    // 아래 ATR 기반 R:R 배수 fallback이 대신 잡도록 함.
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

  const ma5Breakout = detectMa5Breakout(closes, ma20, ma60, volumeRatio);

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

  // 2026-08-03 알고리즘 리뷰: MA20/60 골든·데드크로스 "이벤트"는 관심종목 텔레그램 알림
  // (signalDetector.js)에만 반영되고 SCORE엔 전혀 없었음 — MACD보다 느린 이동평균(20/60일) 교차라
  // 더 굵직한 추세 전환 신호로 보고 MACD(±5)보다 약간 크게 반영.
  if (maCrossover === "GOLDEN") score += 8;
  else if (maCrossover === "DEAD") score -= 8;

  // 2026-08-03: 주봉 기준 중기 추세(국내 전용, 위 calcWeeklyTrend 참고) — 일봉/ADX가 이미
  // 단기~중기 추세를 반영하고 있어서 비중은 작게(±6) 두되, "몇 달짜리 중기 추세와 방향이
  // 같은지"를 별도로 확인하는 용도. 아직 백테스트로 검증된 가중치는 아니라 보수적으로 작게 잡음.
  if (weeklyTrend) {
    if (weeklyTrend.direction === "UP") score += 6;
    else if (weeklyTrend.direction === "DOWN") score -= 6;
  }

  // 2026-08-04: 역배열 중 거래량 동반 5일선 상향 돌파(세력 진입 초기 신호 후보) — 빠른 신호라
  // 노이즈에도 잘 반응하므로 거래량 확인이 없으면 아예 점수에 반영 안 함(위 detectMa5Breakout
  // 주석 참고). 확인되면 소폭 반영(±5) — MA20/60 크로스(±8)보다는 작게, 아직 더 굵직한 크로스로
  // 확정되지 않은 "초기 신호"이기 때문.
  if (ma5Breakout && ma5Breakout.volumeConfirmed) {
    if (ma5Breakout.type === "BULL_BREAK") score += 5;
    else if (ma5Breakout.type === "BEAR_BREAK") score -= 5;
  }

  // 거래량 확인 — 예전엔 volumeRatio(20일 평균 대비 당일 거래량)를 계산만 해두고 SCORE엔 전혀
  // 안 썼음. 실제 트레이더는 거래량 확인 없는 가격 움직임을 잘 신뢰하지 않음: 평소보다 훨씬
  // 많은 거래량을 동반한 상승/하락은 확인(가점/감점)으로, 반대로 평소보다 훨씬 적은 거래량은
  // 방향에 상관없이 "확신이 부족한 움직임"으로 보고 소폭 감점.
  if (Number.isFinite(volumeRatio) && Number.isFinite(dailyChangePct)) {
    if (volumeRatio >= 1.8) {
      if (dailyChangePct > 0) score += 4;
      else if (dailyChangePct < 0) score -= 4;
    } else if (volumeRatio < 0.5) {
      score -= 2;
    }
  }

  // 지수 대비 상대강도(RS) — 예전엔 개별 종목 지표만 봐서, 업종/시장 전체가 빠지는 중에도
  // 종목만 보고 좋다고 오판할 수 있었음. 벤치마크(국내: KODEX200, 해외: SPY) 대비 20일 성과 격차를 반영.
  if (rsInfo && Number.isFinite(rsInfo.rs20)) {
    score += clamp(rsInfo.rs20 * 0.4, -8, 8);
  }

  score = Math.round(Math.max(0, Math.min(99, score)));
  const rank = rankFromScore(score);

  return {
    price: lastPrice,
    ma5,
    ma20,
    ma60,
    ma120,
    rsi,
    rsiCross,
    macd,
    macdSignal,
    macdHistogram,
    macdCrossover,
    macdDivergence,
    maCrossover,
    weeklyTrend,
    ma5Breakout,
    atr,
    atrPct,
    adx,
    plusDI,
    minusDI,
    adxTrend,
    rsInfo,
    intradayInfo,
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

  // OBV 다이버전스는 "오늘 하루" 얘기인 flowNote에 억지로 끼워넣지 않고,
  // 수급 탭의 별도 박스(obv-txt)에서 렌더링하도록 obvInfo만 그대로 반환함
  const obvInfo = calcOBVSignal(closes, data.volumes, 10);

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
// 2026-08-03 알고리즘 리뷰: 실제 트레이더라면 절대 하지 않을 방식이 하나 있었음 — 이 판정이
// 오직 R:R(목표가/손절가까지의 거리 비율)만 보고 매수/매도를 정했고, 같은 엔진이 이미 계산해둔
// RAVEN SCORE/등급(추세 강도·모멘텀·RS 등을 종합한 값)은 R:R 계산이 유효할 때는 전혀 참고하지
// 않았음. 그 결과 실측으로 재현됨: 삼성전자(005930)가 SCORE는 D(추세·모멘텀이 나쁨)인데도 지지선이
// 멀고 저항선이 가까운 기하학적 이유만으로 R:R이 2를 넘으면 "매수" 배지가 뜰 수 있는 구조였음 —
// 같은 화면 안에서 SCORE는 "추세가 나쁘다"고 하는데 배지는 "사라"고 말하는 자기모순. 실제 트레이더는
// 가격 구조(R:R)만 보고 진입하지 않고 반드시 추세/모멘텀이 그 방향을 지지하는지 확인하므로,
// R:R 신호가 SCORE 등급과 정면으로 반대일 때(R:R은 매수인데 등급 D, 또는 R:R은 매도인데 등급 S/A)는
// 신호를 유보하고 중립으로 완화함 — conflict 플래그로 그 사실 자체를 UI에 노출(그냥 "애매한
// 구간"으로 뭉개지 않고 "두 지표가 서로 반대라 유보했다"는 걸 명시).
function computeVerdict(analysis) {
  const { rewardPct1: upPctRaw, riskPct: downPctRaw, rrRatio: rrRaw, rank } =
    analysis;

  const isValid =
    Number.isFinite(upPctRaw) &&
    Number.isFinite(downPctRaw) &&
    downPctRaw > 0 &&
    Number.isFinite(rrRaw);

  let tier = "NEUTRAL";
  let conflict = false;
  if (isValid) {
    if (rrRaw >= 2) {
      if (rank === "D") {
        tier = "NEUTRAL";
        conflict = true;
      } else {
        tier = "BUY";
      }
    } else if (rrRaw < 1) {
      if (rank === "S" || rank === "A") {
        tier = "NEUTRAL";
        conflict = true;
      } else {
        tier = "SELL";
      }
    }
  } else if (rank === "S" || rank === "A") {
    tier = "BUY";
  } else if (rank === "D") {
    tier = "SELL";
  }

  return { tier, isValid, upPctRaw, downPctRaw, rrRaw, conflict, rank };
}

// ────────────────────────────────
// 탭 하단 종합 요약 — 각 탭 안의 여러 해석을 한 문장 결론으로 묶음.
// 상단 RAVEN 전략요약(computeVerdict 기반)이 "지금 진입해도 되는 자리인가"를 답한다면,
// 이 요약들은 "추세는/수급은/패턴은 각각 어떤 쪽을 가리키는가"를 답하는 역할 분담.
// ────────────────────────────────
function summarizeTrendMomentum(analysis) {
  const { ma20, ma60, ma120, rsi, macd, adx, adxTrend, rsiCross, macdCrossover, rsInfo, macdDivergence, intradayInfo } = analysis;

  let bullPoints = 0;
  let bearPoints = 0;

  if (ma20 && ma60 && ma120) {
    if (ma20 > ma60 && ma60 > ma120) bullPoints++;
    else if (ma20 < ma60 && ma60 < ma120) bearPoints++;
  }
  if (typeof rsi === "number") {
    if (rsi >= 55) bullPoints++;
    else if (rsi <= 45) bearPoints++;
  }
  if (typeof macd === "number") {
    if (macd >= 0) bullPoints++;
    else bearPoints++;
  }
  if (rsInfo && Number.isFinite(rsInfo.rs20)) {
    if (rsInfo.rs20 >= 2) bullPoints++;
    else if (rsInfo.rs20 <= -2) bearPoints++;
  }

  let verdictWord = "혼조/중립";
  if (bullPoints - bearPoints >= 2) verdictWord = "상승 우위";
  else if (bearPoints - bullPoints >= 2) verdictWord = "하락 우위";

  const bullets = [`추세·모멘텀은 ${verdictWord} 구간입니다.`];

  if (typeof adx === "number") {
    bullets.push(
      adx >= 25
        ? "추세 강도(ADX)까지 뚜렷해 신뢰도가 높은 신호입니다."
        : "다만 ADX 기준 추세 강도는 약해 큰 확신을 갖기는 이릅니다."
    );
    // ADX 값 자체보다 방향(강화/약화)이 다른 신호를 줄 때만 추가로 언급 —
    // 예: 숫자는 낮아도(약함) 최근 올라오는 중이면 추세가 막 시작되는 신호일 수 있음
    if (adxTrend === "RISING" && adx < 25) {
      bullets.push("다만 ADX가 최근 상승 중이라, 추세가 이제 막 형성되기 시작하는 초기 국면일 수 있습니다.");
    } else if (adxTrend === "FALLING" && adx >= 25) {
      bullets.push("다만 ADX가 최근 하락 중이라, 뚜렷했던 추세 강도가 식어가고 있을 가능성이 있습니다.");
    }
  }

  if (macdCrossover === "GOLDEN") bullets.push("MACD 골든크로스도 함께 발생했습니다.");
  else if (macdCrossover === "DEAD") bullets.push("MACD 데드크로스도 함께 발생했습니다.");
  else if (rsiCross === "BUY") bullets.push("RSI가 과매도 구간을 막 벗어났습니다.");
  else if (rsiCross === "SELL") bullets.push("RSI가 과열 구간에서 이탈했습니다.");

  if (macdDivergence && macdDivergence.divergence === "BEARISH") {
    bullets.push("다만 MACD 약세 다이버전스가 나와, 상승 동력이 소진되고 있을 가능성도 함께 감안해야 합니다.");
  } else if (macdDivergence && macdDivergence.divergence === "BULLISH") {
    bullets.push("MACD 강세 다이버전스도 감지되어, 하락 동력이 약해지고 있을 가능성이 있습니다.");
  }

  // 장중 단기(해외 종목만, 60분봉 기준) 흐름 — 일봉 추세와 같은 방향인지 엇갈리는지 확인.
  // 국내는 KIS가 1분봉·최대 30건뿐이라 노이즈가 너무 커서(2026-08-03 피드백 검토 후) 호출 자체를
  // 안 함 — 국내 종목은 항상 intradayInfo가 null이라 이 블록이 그냥 스킵됨(정상 동작).
  if (intradayInfo) {
    const dailyUp = verdictWord === "상승 우위";
    const dailyDown = verdictWord === "하락 우위";
    const hoursTxt = `약 ${intradayInfo.minutes}시간(60분봉 기준)`;

    if (intradayInfo.direction === "UP" && dailyDown) {
      bullets.push(
        `다만 최근 ${hoursTxt} 흐름은 반등 시도 중이라 일봉 추세와 엇갈립니다 — 단기 눌림/저점 매수 시그널일 수 있으니 확인이 필요합니다.`
      );
    } else if (intradayInfo.direction === "DOWN" && dailyUp) {
      bullets.push(
        `다만 최근 ${hoursTxt} 흐름은 눌리는 중이라 일봉 추세와 엇갈립니다 — 단기 조정 가능성을 함께 감안해야 합니다.`
      );
    } else if (intradayInfo.direction === "UP" || intradayInfo.direction === "DOWN") {
      bullets.push(
        `최근 ${hoursTxt} 흐름도 일봉 추세와 같은 방향으로 진행 중입니다(60분봉 RSI ${intradayInfo.rsi.toFixed(
          1
        )}).`
      );
    }
  }

  return bullets;
}

function summarizeSupply(flowInfo) {
  const { flowLabel, obvInfo } = flowInfo;
  const bullets = [`수급은 [${flowLabel}] 상태입니다.`];

  if (obvInfo && obvInfo.divergence === "BEARISH") {
    bullets.push("다만 최근 10일 OBV 다이버전스가 나와, 상승 동력이 약해지고 있을 가능성을 함께 감안해야 합니다.");
  } else if (obvInfo && obvInfo.divergence === "BULLISH") {
    bullets.push("최근 10일 OBV 기준으로는 저점 매집 신호도 함께 감지됩니다.");
  } else if (obvInfo) {
    bullets.push("최근 10일 누적 수급(OBV) 방향도 대체로 같은 쪽을 가리키고 있습니다.");
  }

  return bullets;
}

function summarizePattern(patterns, verdict) {
  const top = patterns && patterns[0];
  const tierWord =
    verdict.tier === "BUY" ? "매수 우위" : verdict.tier === "SELL" ? "매도 신중" : "중립·관망";

  if (top) {
    return [
      `대표 패턴은 [${top.name}]이고, R:R 기준 판정은 [${tierWord}]입니다.`,
      "패턴과 R:R이 같은 방향을 가리키는지 함께 확인하는 것이 좋습니다."
    ];
  }
  return [`뚜렷한 캔들 패턴은 감지되지 않았고, R:R 기준 판정은 [${tierWord}]입니다.`];
}

// 탭 하단 종합 요약(불릿 리스트)을 <ul> 요소에 렌더링
function renderBulletList(el, bullets) {
  if (!el) return;
  el.innerHTML = "";
  (bullets || []).forEach((line) => {
    const li = document.createElement("li");
    li.textContent = line;
    el.appendChild(li);
  });
}

// 이미 여러 문장이 하나의 문자열로 붙어있는 서술(예: calcFlowSignal의 flowNote)을 함수 반환
// 타입을 바꾸지 않고도 문장 단위 배열로 쪼개기 위한 범용 헬퍼. "마침표/느낌표/물음표 + 공백"
// 뒤에서만 자르므로 "3.5%" 같은 소수점 숫자(마침표 뒤 공백 없음)는 쪼개지지 않음.
function splitSentences(text) {
  if (!text) return [];
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 추세/모멘텀/수급/패턴/신호 등 본문 서술을 문장 단위 불릿으로 렌더링.
// el 자체는 <p>/<div> 등 아무 태그여도 되고(내부에 <ul>을 새로 만들어 넣음), lines의 각 항목은
// innerHTML로 렌더링되어 toneSpan()으로 만든 부분 강조 문구를 그대로 심을 수 있음.
function renderNarrativeBullets(el, lines) {
  if (!el) return;
  el.innerHTML = "";
  if (!lines || !lines.length) return;

  const ul = document.createElement("ul");
  ul.className = "narrative-bullets";
  lines.forEach((line) => {
    if (!line) return;
    const li = document.createElement("li");
    li.innerHTML = line;
    ul.appendChild(li);
  });
  el.appendChild(ul);
}

// 지표 박스(RSI/MACD/ADX/ATR/RS) 값 줄을 "숫자값" + "▶ 해석" 두 줄로 분리 렌더링
// 문단 안의 특정 핵심 문구만 색칠할 때 쓰는 인라인 span (지표박스 전체 색칠과는 별개 용도)
function toneSpan(text, sentiment) {
  return `<span class="sentiment-${sentiment}">${text}</span>`;
}

// sentiment: "pos"(긍정/녹색) | "neu"(중립/주황) | "neg"(부정/빨강) | undefined(색 없음, 기본색 유지)
// interpHtml은 innerHTML로 렌더링됨 — toneSpan()으로 만든 부분 강조(예: MACD 크로스오버 문구만
// 별도 색칠)를 문장 안에 그대로 심을 수 있게 하기 위함(아래 MACD 박스 참고).
function setIndicatorBox(el, valueText, interpHtml, sentiment) {
  if (!el) return;
  el.innerHTML = "";

  const valueSpan = document.createElement("span");
  valueSpan.className = "indicator-value";
  valueSpan.textContent = valueText;
  el.appendChild(valueSpan);

  if (interpHtml) {
    const interpSpan = document.createElement("span");
    interpSpan.className = "indicator-interp";
    if (sentiment) interpSpan.classList.add(`sentiment-${sentiment}`);
    interpSpan.innerHTML = `▶ ${interpHtml}`;
    el.appendChild(interpSpan);
  }
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
      direction: "pos",
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
      direction: "neg",
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
      direction: "pos",
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
        direction: "neg",
        strength: 2,
        comment:
          "윗꼬리가 긴 역망치형 캔들로, 위쪽에서 매도 압력이 강하게 나온 신호입니다. 저항선 부근이라면 단기 피크/조정 가능성을 시사합니다."
      });
    } else {
      patterns.push({
        name: "Inverted Hammer",
        direction: "pos",
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
        direction: "pos",
        strength: 2,
        comment:
          "아랫꼬리가 긴 Dragonfly Doji로, 하락 중 매수 방어가 강하게 들어온 모양입니다. 지지선 부근이라면 반등 신호가 될 수 있습니다."
      });
    } else if (upperWick > body * 4 && lowerWick < body * 0.5) {
      patterns.push({
        name: "Gravestone Doji",
        direction: "neg",
        strength: 2,
        comment:
          "윗꼬리가 긴 Gravestone Doji로, 상승 중 위에서 매도 압력이 강한 형태입니다. 저항 부근이라면 피크/조정 신호일 수 있습니다."
      });
    } else {
      patterns.push({
        name: "Doji",
        direction: "neu",
        strength: 1,
        comment:
          "시가와 종가가 거의 같은 십자형 캔들로, 매수·매도 힘이 팽팽하게 맞선 변곡 신호입니다. 이후 봉의 방향성이 중요합니다."
      });
    }
  }

  // 4-5-1) Doji 반전 확인 — 어제 방향성 없는 Doji가 나온 뒤, 오늘 그 레인지를 상당폭 뛰어넘는
  // 확실한 방향성 캔들이 나오면 "관망(도지)"이 끝나고 다음 파동이 시작됐다고 볼 수 있는 확인 패턴.
  // 예전엔 Doji 자체는 당일 하나만 보고 판정해서, 다음날 확인 캔들이 나와도 아무 신호가 안 잡혔음.
  const isDoji1 = body1 / (range1 || 1e-9) < 0.1;
  if (isDoji1 && bodyRatio > 0.5 && body > range1 * 0.8) {
    if (isBull) {
      patterns.push({
        name: "Doji 반전 확인(상승)",
        direction: "pos",
        strength: 4,
        comment:
          "전일 방향성 없는 Doji 이후, 오늘 그 범위를 상당폭 뛰어넘는 강한 양봉이 나와 매수 우위로 방향이 확인된 패턴입니다."
      });
    } else if (isBear) {
      patterns.push({
        name: "Doji 반전 확인(하락)",
        direction: "neg",
        strength: 4,
        comment:
          "전일 방향성 없는 Doji 이후, 오늘 그 범위를 상당폭 뛰어넘는 강한 음봉이 나와 매도 우위로 방향이 확인된 패턴입니다."
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
      direction: "pos",
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
      direction: "neg",
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
      direction: "pos",
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
      direction: "neg",
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
      direction: "pos",
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
      direction: "neg",
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
      direction: "neu",
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
      direction: "pos",
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
      direction: "neg",
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
      direction: "neu",
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
      direction: "neg",
      strength: 2,
      comment:
        "전일과 오늘의 고점이 거의 같은 높이에서 막힌 집게형 상단 패턴입니다. 같은 가격대에서 매도 물량이 반복적으로 나왔다는 뜻으로, 저항선 부근이라면 신뢰도가 더 높아집니다."
    });
  }

  if (lowDiff < 0.08 && isBear1 && isBull) {
    patterns.push({
      name: "Tweezer Bottom",
      direction: "pos",
      strength: 2,
      comment:
        "전일과 오늘의 저점이 거의 같은 높이에서 지지된 집게형 하단 패턴입니다. 같은 가격대에서 매수세가 반복적으로 들어왔다는 뜻으로, 지지선 부근이라면 신뢰도가 더 높아집니다."
    });
  }

  patterns.sort((a, b) => b.strength - a.strength);

  return patterns;
}

// RAVEN SCORE(0~99) → S/A/B/C/D 랭크 밴드. analyzeData()의 최초 계산과, 연속매매 반영으로
// 점수가 사후 조정될 때(updateScoreAndRankDisplay 참고)의 재계산 양쪽에서 공용으로 씀 —
// 경계값이 두 곳에서 따로 관리되면 어긋날 위험이 있어 하나로 통일.
function rankFromScore(score) {
  if (score >= 85) return "S";
  if (score >= 70) return "A";
  if (score >= 55) return "B";
  if (score < 35) return "D";
  return "C";
}

// RAVEN SCORE의 랭크 밴드(위 rankFromScore의 S/A/B/C/D 경계와 동일) 안에서, 점수 위치에 따라
// +/- 세부등급을 붙임(밴드 하위 1/3="-", 중간 1/3="", 상위 1/3="+"). +/-만 <sup>로 위첨자 처리.
function formatRankGrade(score, letter) {
  const bands = { S: [85, 99], A: [70, 84], B: [55, 69], C: [35, 54], D: [0, 34] };
  const [min, max] = bands[letter] || [0, 99];
  const width = max - min + 1;
  const pos = score - min;
  const third = width / 3;

  let mod = "";
  if (pos < third) mod = "-";
  else if (pos >= third * 2) mod = "+";

  return mod ? `${letter}<sup>${mod}</sup>` : letter;
}

// RAVEN SCORE/RANK 배지 렌더링 — updateUI()의 최초 렌더와, 연속매매 수급 데이터가 늦게 도착한 뒤의
// 사후 조정(applyInvestorStreakToScore) 양쪽에서 공용으로 씀(중복 계산 금지).
function updateScoreAndRankDisplay(score, rank) {
  const scoreEl = $("ai-score");
  const rankEl = $("ai-rank");
  const scoreUnitEl = $("ai-score-unit");

  if (scoreEl) scoreEl.textContent = score;
  if (rankEl) rankEl.innerHTML = formatRankGrade(score, rank);

  const color = score >= 70 ? "#10b981" : score >= 40 ? "#3b82f6" : "#ef4444";
  if (scoreEl) {
    scoreEl.style.color = color;
    scoreEl.style.textShadow = `0 0 10px ${color}88`;
  }
  if (rankEl) {
    rankEl.style.color = color;
    rankEl.style.textShadow = `0 0 10px ${color}88`;
  }
  if (scoreUnitEl) scoreUnitEl.style.color = color;
}

// 6-2. 종목 라벨 / 섹터 태깅 (간단 버전 보조)
// 7. UI 업데이트 (섹터/패턴/시나리오 포함)
function updateUI(data, analysis, fxRate, stockName) {
  const priceEl = $("ticker-price");
  const scoreEl = $("ai-score");
  const rankEl = $("ai-rank");

  const trendEl = $("trend-txt");
  const momentumEl = $("momentum-txt");
  const waveEl = $("wave-txt");
  const supplyEl = $("supply-txt");
  const obvEl = $("obv-txt");
  const patternEl = $("pattern-txt"); // 패턴 카드
  const signalEl = $("signal-txt"); // 시그널 카드

  const rsiBox = $("rsi-txt");
  const macdBox = $("macd-txt");
  const adxBox = $("adx-txt");
  const atrBox = $("atr-txt");

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

  // 티커가 바뀌면 이전 종목 가격에서 굴러오는 게 아니라 0에서부터 카운트업(서로 다른 통화/자릿수
  // 종목 사이를 이어서 굴리면 어색해 보임) — 같은 종목을 재검색한 경우엔 이전 값에서 자연스럽게 이어짐.
  if (priceEl) {
    if (priceEl.dataset.animSymbol !== data.symbol) {
      delete priceEl.dataset.animFrom;
      priceEl.dataset.animSymbol = data.symbol;
    }
    animateNumberText(priceEl, analysis.price, formatPrice);
  }

  // 원화 환산가는 메인 가격과 무게감을 다르게 — 작은 보조 표기로 분리
  const priceFxEl = $("ticker-price-fx");
  if (priceFxEl) {
    if (!isDomestic && typeof fxRate === "number") {
      const krw = analysis.price * fxRate;
      priceFxEl.textContent = "≈ ₩" + Math.round(krw).toLocaleString("ko-KR");
    } else {
      priceFxEl.textContent = "";
    }
  }

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

  // 점수 / 랭크 — 하나의 배지(RAVEN SCORE)로 통합. 랭크 글자 안에서도 점수 위치에 따라
  // 세부등급(+/-)을 붙여줌(예: A 밴드의 상위 1/3이면 A+). +/-는 <sup>로 위첨자 처리.
  updateScoreAndRankDisplay(analysis.score, analysis.rank);

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

    // 각 통계 문구(예: "▼ DOWN: 22.0%")가 좁은 화면에서 라벨과 숫자 사이로 줄바꿈되며
    // 잘리는 게 실측으로 확인돼서, 문구 단위로 white-space:nowrap을 걸어 덩어리째로만
    // 줄바꿈되도록 함(RS 표기 줄바꿈 버그와 같은 유형).
    mainComment =
      `<span style="color:#10b981; white-space:nowrap;">▲ UP: ${upPct}%</span> ` +
      `<span style="color:#ef4444; white-space:nowrap; margin-left:6px;">▼ DOWN: ${downPct}%</span> ` +
      `<span style="color:#666; margin:0 6px;">·</span>` +
      `<span style="color:#3b82f6; font-weight:700; white-space:nowrap;">R:R ≈ ${rrText} : 1</span> ` +
      `<span style="color:${verdictColor}; font-weight:600; white-space:nowrap; margin-left:6px;">${verdictBracket}</span>`;
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
    adxTrend,
    atr,
    atrPct,
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

  // 가격과 (+/-%)를 한 줄로 이어붙이면 좁은 폭에서 괄호 중간이 어중간하게 줄바꿈되던 문제(실측
  // 피드백) — 가격/퍼센트를 별도 줄로 명시적으로 분리(innerHTML+<br>)해서 항상 그 경계에서만
  // 줄바꿈되도록 함.
  const setTargetBox = (box, level) => {
    if (!box) return;
    if (Number.isFinite(level) && Number.isFinite(price)) {
      const pct = fmtPct(level, price);
      box.innerHTML = `${formatPrice(level)}<br><span class="target-box-pct">${pct}</span>`;
    } else {
      box.textContent = "-";
    }
  };

  if (target1Box || target2Box || stopBox) {
    setTargetBox(target1Box, target1);
    setTargetBox(target2Box, target2);
    setTargetBox(stopBox, stop);
  }

  // ==== Trend 카드 텍스트 ====
  // 문장별로 배열에 담아 renderNarrativeBullets()로 불릿(•) 렌더링 — 한 문단으로 이어붙이면
  // 좁은 화면에서 문장 중간이 어중간하게 줄바꿈되던 걸 개선(실측 피드백).
  if (trendEl) {
    let lines = ["단기/중기 이평선 기준으로 추세를 평가합니다."];

    if (ma20 && ma60 && ma120) {
      const isBullTrend =
        ma20 > ma60 && ma60 > ma120 && price >= ma20 * 0.97 && price <= ma20 * 1.1;
      const isBullPullback =
        ma20 > ma60 && ma60 > ma120 && price < ma20 && price > ma60 * 0.97;
      const isBearTrend =
        ma20 < ma60 && price < ma20 && price < ma60 && price < ma120;

      if (isBullTrend) {
        lines = [
          "20·60·120일선이 정배열이고, 현재가도 20일선 위에 위치한 전형적인 상승 추세 구간입니다.",
          "추세 추종 매매가 유리한 자리입니다."
        ];
      } else if (isBullPullback) {
        lines = [
          "중장기적으로는 정배열 상승 추세지만, 현재가는 20일선 아래/60일선 위의 눌림 구간입니다.",
          "추세 안에서의 단기 조정으로 보는 쪽이 자연스럽습니다."
        ];
      } else if (isBearTrend) {
        lines = [
          "20·60·120일선이 역배열에 가깝고, 현재가도 주요 이평선 아래에 위치한 약세/하락 추세 구간입니다.",
          "반등보다는 하락 추세 연장이 우세한 자리입니다."
        ];
      } else {
        lines = [
          "이평선 배열과 현재가 위치가 애매한 중립/전환 구간입니다.",
          "추세보다는 지지·저항과 수급 변화를 우선적으로 보는 편이 좋습니다."
        ];
      }
    } else {
      lines = ["이평선 데이터가 부족해 뚜렷한 추세 판단이 어렵습니다."];
    }

    renderNarrativeBullets(trendEl, lines);
  }

  // ==== 상대강도(RS) — RSI/MACD/ADX/ATR과 같은 지표 박스로 통일 ====
  // 예전엔 추세 문단 하단의 작은 보조 줄이라 눈에 잘 안 띄었음. "이평선 배열이 어떤지"와
  // "시장 대비 잘 가는지"는 서로 다른 질문이라 별도 지표 박스로 승격.
  const rsEl = $("rs-txt");
  if (rsEl) {
    if (rsInfo && (Number.isFinite(rsInfo.rs20) || Number.isFinite(rsInfo.rs60))) {
      // "20일 +6.5%p / 60일 +4.6%p"처럼 단어+숫자가 섞인 형태는 좁은 화면에서 어중간하게
      // 줄바꿈되기 쉬워서, "20일/60일 = +6.5/+4.6(%p)" 형태로 숫자만 붙여 자연스럽게 줄바꿈되게 함.
      // 2026-08-03 피드백: "(%p)" 단위 표기 제거
      const fmtRs = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
      let display;
      if (Number.isFinite(rsInfo.rs20) && Number.isFinite(rsInfo.rs60)) {
        display = `20일/60일 = ${fmtRs(rsInfo.rs20)}/${fmtRs(rsInfo.rs60)}`;
      } else if (Number.isFinite(rsInfo.rs20)) {
        display = `20일 = ${fmtRs(rsInfo.rs20)}`;
      } else {
        display = `60일 = ${fmtRs(rsInfo.rs60)}`;
      }
      const primary = Number.isFinite(rsInfo.rs20) ? rsInfo.rs20 : rsInfo.rs60;

      let verdict = "시장과 비슷한 흐름";
      let sentiment = "neu";
      if (primary >= 5) {
        verdict = "시장 대비 아웃퍼폼";
        sentiment = "pos";
      } else if (primary <= -5) {
        verdict = "시장 대비 언더퍼폼 — 개별 지표가 좋아도 주의";
        sentiment = "neg";
      }

      setIndicatorBox(rsEl, display, verdict, sentiment);
    } else {
      setIndicatorBox(rsEl, "데이터 부족");
    }
  }

  // ==== Momentum 카드 텍스트 ====
  if (momentumEl) {
    let lines = [];

    if (rsi >= 70) {
      lines = [
        `RSI ${rsi.toFixed(1)}로 단기 과열 구간에 진입한 상태입니다.`,
        "추세는 강하지만 신규 진입보다는 분할 청산/눌림 대기가 더 유리할 수 있습니다."
      ];
    } else if (rsi >= 60) {
      lines = [
        `RSI ${rsi.toFixed(1)}로 모멘텀은 강세 우위입니다.`,
        "추세 추종 관점에서 눌림 매수나 돌파 매매를 고려할 수 있는 구간입니다."
      ];
    } else if (rsi <= 30) {
      lines = [
        `RSI ${rsi.toFixed(1)}로 과매도 구간에 가까운 자리입니다.`,
        "기술적 반등 여지는 있지만, 추세 자체가 약세라면 역추세 매매는 고위험 구간입니다."
      ];
    } else if (rsi <= 40) {
      lines = [
        `RSI ${rsi.toFixed(1)}로 모멘텀은 다소 약세 쪽으로 기울어 있습니다.`,
        "추가 하락이 이어질 수 있어 보수적인 접근이 필요합니다."
      ];
    } else {
      lines = [
        `RSI ${rsi.toFixed(1)}로 모멘텀은 중립 구간입니다.`,
        "뚜렷한 과열/과매도 신호보다는 추세와 지지·저항에서 방향성을 확인하는 편이 좋습니다."
      ];
    }

    // MACD 다이버전스 — 가격과 모멘텀 지표가 서로 다른 말을 하는 구간이라 별도 불릿으로 경고.
    // 핵심 문구("약세/강세 다이버전스")만 색칠 — 문단 전체를 물들이면 오히려 안 읽혀서 키워드만.
    if (analysis.macdDivergence && analysis.macdDivergence.divergence === "BEARISH") {
      lines.push(
        `최근 ${analysis.macdDivergence.lookback}일간 가격은 올랐지만 MACD 모멘텀은 오히려 꺾이는 ${toneSpan("약세 다이버전스", "neg")}가 나타나, 상승 동력이 소진되고 있을 가능성이 있습니다.`
      );
    } else if (analysis.macdDivergence && analysis.macdDivergence.divergence === "BULLISH") {
      lines.push(
        `최근 ${analysis.macdDivergence.lookback}일간 가격은 빠졌지만 MACD 모멘텀은 오히려 개선되는 ${toneSpan("강세 다이버전스", "pos")}가 나타나, 하락 동력이 약해지고 있을 가능성이 있습니다.`
      );
    }

    renderNarrativeBullets(momentumEl, lines);
  }

  // ===== Flow / WhyToday / 패턴 계산 =====
  const flowInfo = calcFlowSignal(data, analysis);
  const whyInfo = calcWhyTodaySignal(data, analysis, flowInfo);
  const patterns = detectCandlePatterns(data, analysis);

  const { support1: s1, support2: s2, resistance1: r1, resistance2: r2, price: px, rsi: rsiVal } =
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

  // ==== CHECK POINT: 지지/저항 시각 사다리 + 구조 설명 ====
  // 예전엔 "1차 지지선 $x (-y%) · 2차 지지선 $z (-w%) ..."처럼 텍스트로만 쭉 나열해서
  // 한눈에 위치 관계를 파악하기 어려웠음 — 항상 5칸(2차지지/1차지지/현재가/1차저항/2차저항)
  // 고정 순서·동일 폭으로 배치. 값이 없는 칸은 자리만 유지한 채 빈 칩으로 표시.
  const waveLadderEl = $("wave-ladder");
  if (waveLadderEl) {
    const fmtChip = (label, lv, type) => {
      if (!Number.isFinite(lv) || !Number.isFinite(px) || px === 0) {
        return { label, price: null, pctText: "", pctSign: null, type };
      }
      const pct = ((lv - px) / px) * 100;
      const sign = pct >= 0 ? "+" : "";
      return {
        label,
        price: lv,
        pctText: `${sign}${pct.toFixed(1)}%`,
        pctSign: pct >= 0 ? "positive" : "negative",
        type
      };
    };

    const slots = [
      fmtChip("2차 지지", s2, "support"),
      fmtChip("1차 지지", s1, "support"),
      { label: "현재가", price: Number.isFinite(px) ? px : null, pctText: "", type: "current" },
      fmtChip("1차 저항", r1, "resistance"),
      fmtChip("2차 저항", r2, "resistance")
    ];

    waveLadderEl.innerHTML = "";
    slots.forEach((c) => {
      const chip = document.createElement("div");
      chip.className = `wave-chip ${c.type}${c.price == null ? " empty" : ""}`;

      const labelDiv = document.createElement("div");
      labelDiv.className = "wave-chip-label";
      labelDiv.textContent = c.label;
      chip.appendChild(labelDiv);

      const priceDiv = document.createElement("div");
      priceDiv.className = "wave-chip-price";
      priceDiv.textContent = c.price == null ? "—" : formatPrice(c.price);
      chip.appendChild(priceDiv);

      if (c.pctText) {
        const pctDiv = document.createElement("div");
        pctDiv.className = `wave-chip-pct${c.pctSign ? ` ${c.pctSign}` : ""}`;
        pctDiv.textContent = c.pctText;
        chip.appendChild(pctDiv);
      }

      waveLadderEl.appendChild(chip);
    });
  }

  if (waveEl) {
    // Wave는 "지금 구조가 어떻게 생겼는지"만 순수하게 설명함 —
    // 매수/매도 전략 판단은 위쪽 RAVEN 전략요약(strategy-main/detail)에 이미 있어서 여기서 안 겹치게 함
    let waveLines = ["최근 파동 구조와 지지·저항 위치를 기준으로 파동을 해석합니다."];

    if (s1 && r1) {
      if (nearSupport && !nearResistance) {
        waveLines = [
          `현재가는 주요 지지선 근처(≈ ${formatPrice(s1)})에 위치한 파동 하단 구간입니다.`,
          "이전 저점·매물대에서 형성된 자리로, 지지선이 유지되는지 이탈하는지에 따라 다음 파동의 방향이 갈립니다."
        ];
      } else if (!nearSupport && nearResistance) {
        waveLines = [
          `현재가는 주요 저항선 근처(≈ ${formatPrice(r1)})에 위치한 파동 상단 구간입니다.`,
          "이전 고점·매물대에서 형성된 자리로, 저항을 돌파하는지 되밀리는지에 따라 다음 파동의 방향이 갈립니다."
        ];
      } else if (nearSupport && nearResistance) {
        waveLines = [
          "지지와 저항 레벨이 서로 가깝게 밀집한 박스 구간 상·하단에 동시에 걸쳐 있는 구조입니다.",
          "박스 폭이 좁아, 어느 한쪽을 벗어나는 순간 다음 파동의 방향이 비교적 빠르게 드러나는 자리입니다."
        ];
      } else {
        waveLines = [
          `현재가는 지지선(≈ ${formatPrice(s1)})과 저항선(≈ ${formatPrice(r1)}) 사이 중간에 위치한 파동 중단 구간입니다.`,
          "박스 상·하단 중 어느 쪽에 먼저 재접근하느냐가 다음 파동을 가늠하는 기준점이 됩니다."
        ];
      }
    } else {
      waveLines = [
        "최근 스윙 고점/저점을 기반으로 한 명확한 지지·저항 레벨이 충분히 잡히지 않은 구간입니다.",
        "이 경우에는 이평선·RSI 등 모멘텀 지표와 상위 타임프레임 차트를 함께 보고 파동 위치를 판단하는 것이 좋습니다."
      ];
    }

    renderNarrativeBullets(waveEl, waveLines);
  }

  // ==== Supply: 오늘 캔들·거래량 기준 매수/매도 압력 해석 ====
  // 예전엔 여기에 calcWhyTodaySignal(왜 오늘 이런 흐름인가 — "이벤트/맥락 측면")까지 합쳐서 보여줬는데,
  // ①"이벤트/맥락"이라는 말 자체가 무슨 뜻인지 알기 어렵고 ②평이한 날엔 "평범한 범위 안"이라는
  // 사실상 빈 내용이 대부분이라 오히려 수급 탭이 부실해 보인다는 피드백을 받아 제거함.
  // 특이하게 강한 재료/악재 가능성이 있을 때만 신호(signal-txt) 쪽에 짧게 덧붙이도록 이동함.
  if (supplyEl) {
    renderNarrativeBullets(supplyEl, splitSentences(flowInfo.flowNote));
  }

  // ==== OBV: 최근 10일 누적 거래량 vs 가격 다이버전스 ====
  // (오늘 캔들 하나만 보던 수급 박스와 달리, 여러 날에 걸친 매집/분산 신호라 별도 박스로 분리)
  if (obvEl) {
    const obvInfo = flowInfo.obvInfo;
    let obvTxt;
    if (!obvInfo) {
      obvTxt = "OBV 계산을 위한 데이터가 부족합니다.";
    } else if (obvInfo.divergence === "BEARISH") {
      obvTxt =
        `최근 ${obvInfo.lookback}일간 가격은 +${obvInfo.priceChangePct.toFixed(
          1
        )}% 올랐는데, 누적 거래량(OBV) 기준 수급은 오히려 빠지는 다이버전스가 나타났습니다. ` +
        "상승이 소수의 거래에 의존하고 있다는 신호로, 고점 분산(매집 소진) 가능성을 염두에 둬야 합니다.";
    } else if (obvInfo.divergence === "BULLISH") {
      obvTxt =
        `최근 ${obvInfo.lookback}일간 가격은 ${obvInfo.priceChangePct.toFixed(
          1
        )}% 빠졌는데, 누적 거래량(OBV) 기준 수급은 오히려 느는 다이버전스가 나타났습니다. ` +
        "저점에서 조용히 매집이 들어오고 있을 가능성이 있는 구간입니다.";
    } else {
      obvTxt =
        `최근 ${obvInfo.lookback}일간 가격 흐름(${
          obvInfo.priceChangePct >= 0 ? "+" : ""
        }${obvInfo.priceChangePct.toFixed(1)}%)과 누적 거래량(OBV) 방향이 대체로 일치합니다. ` +
        "뚜렷한 매집·분산 다이버전스 신호는 없는 구간입니다.";
    }
    renderNarrativeBullets(obvEl, splitSentences(obvTxt));
  }

  const supplySummaryEl = $("supply-summary-txt");
  renderBulletList(supplySummaryEl, summarizeSupply(flowInfo));

  // ==== Pattern 카드 ====
  if (patternEl) {
    if (!patterns || patterns.length === 0) {
      renderNarrativeBullets(patternEl, [
        "오늘 일봉 기준으로는 교과서적인 강/약세 패턴이 뚜렷하게 감지되지 않습니다.",
        "단일 봉보다는 추세와 지지·저항, 거래량을 함께 보고 해석하는 편이 좋습니다."
      ]);
    } else {
      const top = patterns[0];
      const others = patterns.slice(1, 3);
      const otherNames = others.map((p) => p.name).join(", ");

      const patternLines = [`대표 패턴: [${top.name}]`, `해석: ${top.comment}`];
      if (otherNames) {
        patternLines.push(`보조 패턴(참고용): ${otherNames}`);
      }

      renderNarrativeBullets(patternEl, patternLines);
    }
  }

  // ==== Signal: 패턴 + 파동 + 수급 종합 ====
  if (signalEl) {
    const { flowType } = flowInfo;
    const top = patterns && patterns[0] ? patterns[0] : null;
    const topName = top ? top.name : null;
    const isDojiLike =
      topName === "Doji" ||
      topName === "Dragonfly Doji" ||
      topName === "Gravestone Doji";

    let signalLines = [];

    if (topName && isDojiLike) {
      // 도지 계열 패턴은 변곡 시나리오 위주 — 시나리오 하나(제목+화살표 설명)를 한 불릿으로 묶음
      if (nearSupport) {
        signalLines = [
          `지지선(${formatPrice(s1)}) 바로 위에서 ${topName} 패턴이 나타난 상태입니다.`,
          "● 시나리오 1) 지지선 위 양봉 마감 → 지지선 방어 확인 + 반등 시그널 강화\n→ 다음 캔들이 지지선 위에서 중/장대 양봉으로 마감하면, 단기 반등 파동이 시작될 가능성이 큽니다.",
          "● 시나리오 2) 지지선 이탈 음봉 마감 → 반등 실패 + 하락 파동 재개\n→ 지지선 아래로 종가가 밀리면 손절/관망이 유리한 구간입니다."
        ];
      } else if (nearResistance) {
        signalLines = [
          `저항선(${formatPrice(r1)}) 바로 아래에서 ${topName} 패턴이 출현했습니다.`,
          "● 시나리오 1) 저항 돌파 양봉 마감 → 추세 연장/상단 돌파 신호\n→ 다음 캔들이 저항선을 명확히 돌파한 양봉이면, 돌파 후 눌림 구간까지 단기 추세 추종 전략이 유리할 수 있습니다.",
          "● 시나리오 2) 저항 맞고 음봉 마감 → 피크 아웃·조정 가능성\n→ 저항선 터치 후 윗꼬리 긴 음봉으로 마감되면 단기 상방 피로 신호로, 분할 청산/헤지 관점이 필요합니다."
        ];
      } else {
        signalLines = [
          `${topName} 패턴(도지형)이 중립 구간에서 출현했습니다.`,
          "현재 위치는 뚜렷한 지지·저항 레벨과 약간 떨어진 구간이어서, 다음 봉 방향성을 섣불리 단정 짓기 어렵습니다.",
          "다음 캔들의 몸통 방향(양/음)과 거래량이 함께 증가하는지 확인한 뒤, 지지·저항선 재접근 구간에서 진입/청산 타이밍을 잡는 것이 유리합니다."
        ];
      }
    } else {
      signalLines.push(
        topName
          ? `대표 패턴 [${topName}]을 기준으로 파동과 지지·저항을 종합 평가합니다.`
          : "수급 탭의 흐름을 참고해 파동과 지지·저항을 종합 평가합니다."
      );

      if (nearSupport) {
        signalLines.push(
          `현재가는 주요 지지선(${s1 ? formatPrice(s1) : "N/A"}) 근처에 위치한 눌림 구간입니다.`
        );
        if (flowType === "BUY_DOMINANT" || flowType === "REBOUND_BUY") {
          signalLines.push(
            "지지선에서 매수세가 우위인 구조라면, 다음 캔들이 지지선 위 양봉으로 마감할 경우 단기 매수 시그널로 해석할 수 있습니다."
          );
        } else if (flowType === "SELL_DOMINANT") {
          signalLines.push(
            "다만 아직 매도 우위 흐름이 강하다면, 지지선 이탈 음봉이 한 번 더 나올 수 있어 보수적인 접근이 필요합니다."
          );
        } else {
          signalLines.push(
            "수급이 중립에 가까워, 추가 하락 후 진짜 매수세가 들어오는지 한 차례 더 지켜본 뒤 진입하는 편이 안전합니다."
          );
        }
      } else if (nearResistance) {
        signalLines.push(
          `현재가는 주요 저항선(${r1 ? formatPrice(r1) : "N/A"}) 근처 상단 파동 영역입니다.`
        );
        if (flowType === "BUY_DOMINANT") {
          signalLines.push(
            "강한 매수 우위 속에서 저항 돌파를 시도하는 구간이라, 다음 캔들이 저항 위에서 안착하면 돌파 추세 추종 시그널로 볼 수 있습니다."
          );
        } else if (flowType === "REJECTION_SELL" || flowType === "SELL_DOMINANT") {
          signalLines.push(
            "저항선에서 매도/청산이 강하게 나오는 형태라면, 다음 캔들이 저항 아래 음봉으로 마감될 경우 단기 조정/하락 파동 진입 신호로 볼 수 있습니다."
          );
        } else {
          signalLines.push(
            "수급이 애매한 상태라, 돌파 실패 시 되돌림 폭이 커질 수 있습니다. 신규 매수보다는 기존 보유 물량 관리에 중점을 두는 편이 좋습니다."
          );
        }
      } else {
        signalLines.push(
          "지지·저항 사이의 중립 파동 구간에 위치해 있어, 다음 캔들 하나만으로 방향성을 강하게 확정하긴 어렵습니다."
        );
        signalLines.push(
          "이 구간에서는 박스 상·하단(지지/저항)에 다시 접근할 때의 수급 패턴을 보면서 진입/청산 타이밍을 잡는 전략이 적합합니다."
        );
      }

      if (rrOk) {
        signalLines.push(
          `현재 구조 기준 R:R ≈ ${rrRatio.toFixed(2)}:1 (위험 ${riskPct.toFixed(
            1
          )}%, 기대 수익 ${rewardPct1.toFixed(1)}%)로 계산됩니다.`
        );
        signalLines.push(
          "손절 폭 대비 기대 수익이 충분히 유리한지(≥ 1.5:1)를 기준으로 진입 여부를 판단하는 것을 권장합니다."
        );
      }
    }

    // 오늘 변동이 단순 일상적 수급이 아니라 실제 재료(뉴스/이벤트)가 있었을 가능성이 높을 때만
    // 짧게 덧붙임 — "평이한 세션" 같은 평범한 날까지 매번 언급하면 내용 없는 문장만 늘어나서
    // 특이한 날에만 노출되도록 제한함 (예전엔 이 판단이 수급 탭에 "이벤트/맥락 측면"이라는
    // 불명확한 이름으로 항상 붙어 있어서 무슨 뜻인지 알기 어렵고 중복도 심했음).
    if (whyInfo.whyLabel === "강한 재료 가능성" || whyInfo.whyLabel === "악재/청산 가능성") {
      signalLines.push(`📰 ${whyInfo.whyNote}`);
    }

    renderNarrativeBullets(signalEl, signalLines);
  }

  // ==== 자비스 전략 요약 (strategy-main / strategy-detail) ====
  const stratMain = $("strategy-main");
  const stratDetail = $("strategy-detail");

  if (stratMain || stratDetail) {
    // 위쪽 배지(status-badge)와 반드시 같은 판정을 쓰도록 verdict.tier 안에서만 세부 시나리오를 고름
    // (전에는 여기서 R:R 임계값을 따로 재계산해서 배지와 반대되는 문구가 뜨는 버그가 있었음)
    const rrTxt = Number.isFinite(rrRatio)
      ? `R:R ≈ ${rrRatio.toFixed(2)}:1`
      : "R:R 계산 불가(지지·저항 부족, 등급 기준 판정)";

    const fmtLevelPct = (level) => {
      if (!Number.isFinite(level) || !Number.isFinite(px) || px === 0) return null;
      const pct = ((level - px) / px) * 100;
      return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
    };

    // 목표가/손절가를 숫자만 보여주고 끝내지 않고, 구체적인 실행 기준(몇 %에서 뭘 할지)까지 문장으로 제시
    const buildActionLines = (target1Note, target2Note, stopNote) => {
      const lines = [];
      if (Number.isFinite(target1)) {
        lines.push(`🎯 1차 목표가 ${formatPrice(target1)}(${fmtLevelPct(target1)}) — ${target1Note}`);
      }
      if (Number.isFinite(target2) && target2Note) {
        lines.push(`🎯 2차 목표가 ${formatPrice(target2)}(${fmtLevelPct(target2)}) — ${target2Note}`);
      }
      if (Number.isFinite(stop)) {
        lines.push(`🛑 손절가 ${formatPrice(stop)}(${fmtLevelPct(stop)}) — ${stopNote}`);
      }
      return lines;
    };

    // 2026-08-03 알고리즘 리뷰 ④: 손절가가 진입 시점 기준으로 고정된 채 끝나서, 가격이 유리하게
    // 움직인 뒤에도 그대로 방치하면 이미 확보한 수익까지 반납할 위험이 있음 — 목표가의 절반 지점을
    // 넘어서면 손절가를 본전(진입가 가정=현재가) 수준으로 올리라는 트레일링 스탑 가이드를 추가.
    // BUY 판정에서만 의미 있음(SELL/NEUTRAL 판정에서는 신규 진입을 권하지 않으므로 트레일링 대상이 없음).
    const buildTrailingStopLine = () => {
      if (!Number.isFinite(target1) || !Number.isFinite(px) || target1 === px) return "";
      const halfway = px + (target1 - px) * 0.5;
      if (!Number.isFinite(halfway)) return "";
      return `🔁 트레일링: 이후 가격이 ${formatPrice(halfway)}(1차 목표가의 절반 지점) 부근까지 오르면, 손절가를 진입가(본전) 수준으로 올려 이미 확보한 수익을 방어하는 것을 권장합니다.`;
    };

    // 2026-08-04 피드백: 지지 이탈/저항 돌파 "그 다음"까지 연계해달라는 요청 — 1차 레벨이 뚫렸을 때
    // 다음 기준점(2차 지지/저항)까지 미리 시나리오로 제시. 2차 레벨 자체가 없으면(먼 과거/거리제한
    // 밖이라 못 찾은 경우) "다음 기준점이 뚜렷하지 않다"는 사실 자체를 알려줌(없는 숫자를 지어내지 않음).
    const buildBreakScenarioLine = (kind) => {
      if (kind === "support") {
        if (!Number.isFinite(s1)) return "";
        if (Number.isFinite(s2)) {
          return `📉 이탈 시나리오: ${formatPrice(s1)} 지지가 종가 기준으로 무너지면, 다음은 2차 지지선 ${formatPrice(s2)}(${fmtLevelPct(s2)}) 부근까지 하락 폭이 열릴 수 있습니다.`;
        }
        return `📉 이탈 시나리오: ${formatPrice(s1)} 지지가 무너지면 다음 기준점이 뚜렷하지 않아, 하락 변동성이 커질 수 있는 구간입니다.`;
      }
      if (kind === "resistance") {
        if (!Number.isFinite(r1)) return "";
        if (Number.isFinite(r2)) {
          return `📈 돌파 시나리오: ${formatPrice(r1)} 저항을 종가 기준으로 돌파하면, 다음은 2차 저항선 ${formatPrice(r2)}(${fmtLevelPct(r2)}) 부근까지 상승 폭이 열릴 수 있습니다.`;
        }
        return `📈 돌파 시나리오: ${formatPrice(r1)} 저항을 돌파하면 다음 기준점이 뚜렷하지 않아, 추세 가속 구간으로 볼 수 있습니다.`;
      }
      return "";
    };

    // ⚠️ 실제로 발견된 누락: MACD 크로스오버/다이버전스·ADX·RS 체크가 "지지선 근처 매수"/"저항선
    // 근처 매도" 두 분기에만 있고, "과매도 역추세"·"R:R 불리"·"중립/관망" 세 분기엔 아예 없어서
    // MACD 지표박스엔 골든크로스가 뜨는데 RAVEN SIGNAL엔 언급이 통째로 빠지는 문의를 받음(FLNC로
    // 재현됨 — 아마 R:R이 애매해 NEUTRAL로 떨어진 케이스). 5개 분기 전부 같은 로직을 쓰도록 통일.
    // direction: 이 분기가 암시하는 방향("BUY"|"SELL"|"NEUTRAL") — 같은 방향 신호는 그대로,
    // 반대 방향 신호는 "다만 ~"로 주의 요인으로 표시, NEUTRAL은 방향성 없이 사실만 나열.
    // ⚠️ 실제 버그(사용자 재보고): 골든크로스/강세다이버전스 같은 핵심 포인트에 색상 강조가 전혀
    // 안 먹었음 — 예전엔 전부 "highlight"(노란색) 하나로 뭉뚱그렸거나(MA크로스/MACD크로스/주봉추세),
    // 아예 toneSpan 자체를 빼먹은 항목도 있었음(MACD다이버전스/RS/거래량). "긍정=초록·부정=빨강·
    // 중립=노랑" 요청대로, 각 신호 문구 자체가 내포한 강세/약세 성격에 맞춰 pos/neg로 칠하고
    // (다만 ~로 반대방향임을 알려도 문구 자체의 색은 그대로 유지 — 예: SELL 판정 중에 나온 골든크로스는
    // "다만 골든크로스"라고 경고하되 골든크로스 자체는 여전히 강세 사실이라 초록으로 표시),
    // 방향성 없는 순수 강도/거래부족 정보만 중립(노랑)으로 둠.
    const buildIndicatorBits = (direction) => {
      const bits = [];

      if (typeof adx === "number") {
        if (adx >= 25) bits.push(`ADX ${adx.toFixed(1)}로 추세 강도까지 뚜렷`);
        else if (adx < 20) bits.push(`ADX ${adx.toFixed(1)}로 추세 신뢰도는 낮은 편`);
      }
      if (adxTrend === "RISING") bits.push("추세 강도 강화 중");
      else if (adxTrend === "FALLING") bits.push("추세 강도는 약화 중");

      // 2026-08-03 알고리즘 리뷰: MA20/60 크로스 이벤트는 관심종목 텔레그램 알림에만 있고 이
      // 화면엔 아예 없었음 — MACD와 같은 패턴으로 추가(더 굵직한 신호라 별도로 강조).
      if (analysis.maCrossover === "GOLDEN") {
        const txt = toneSpan("MA20/60 골든크로스 동반", "pos");
        bits.push(direction === "SELL" ? `다만 ${txt}` : txt);
      } else if (analysis.maCrossover === "DEAD") {
        const txt = toneSpan("MA20/60 데드크로스 동반", "neg");
        bits.push(direction === "BUY" ? `다만 ${txt}` : txt);
      }

      // 2026-08-04: 역배열/정배열 컨텍스트 + 거래량 확인이 같이 있어야만 의미 있는 "초기 신호"라
      // volumeConfirmed일 때만 서술에 노출(거래량 없는 5일선 돌파는 노이즈일 확률이 높아 생략).
      if (analysis.ma5Breakout && analysis.ma5Breakout.volumeConfirmed) {
        if (analysis.ma5Breakout.type === "BULL_BREAK") {
          const txt = toneSpan("역배열 중 거래량 동반 5일선 상향 돌파(초기 반전 신호 후보)", "pos");
          bits.push(direction === "SELL" ? `다만 ${txt}` : txt);
        } else if (analysis.ma5Breakout.type === "BEAR_BREAK") {
          const txt = toneSpan("정배열 중 거래량 동반 5일선 하향 이탈(초기 균열 신호 후보)", "neg");
          bits.push(direction === "BUY" ? `다만 ${txt}` : txt);
        }
      }

      // 2026-08-03: 주봉 기준 중기 추세(국내 전용) — 일봉 판정과 같은 방향이면 뒷받침 근거로,
      // 반대 방향이면(예: 일봉은 매수 신호인데 주봉은 여전히 하락 추세) "다만"으로 주의를 줌 —
      // 며칠짜리 반등이 몇 달짜리 하락 추세 속의 일시적 되돌림일 수 있다는 걸 놓치지 않게 함.
      if (analysis.weeklyTrend) {
        if (analysis.weeklyTrend.direction === "UP") {
          const txt = toneSpan("주봉 기준 중기 추세도 상승 우위", "pos");
          bits.push(direction === "SELL" ? `다만 ${txt}` : txt);
        } else if (analysis.weeklyTrend.direction === "DOWN") {
          const txt = toneSpan("주봉 기준 중기 추세는 하락 우위", "neg");
          bits.push(direction === "BUY" ? `다만 ${txt}` : txt);
        }
      }

      if (analysis.macdCrossover === "GOLDEN") {
        const txt = toneSpan("MACD 골든크로스 동반", "pos");
        bits.push(direction === "SELL" ? `다만 ${txt}` : txt);
      } else if (analysis.macdCrossover === "DEAD") {
        const txt = toneSpan("MACD 데드크로스 동반", "neg");
        bits.push(direction === "BUY" ? `다만 ${txt}` : txt);
      }

      if (analysis.macdDivergence && analysis.macdDivergence.divergence === "BULLISH") {
        const txt = toneSpan("MACD 강세 다이버전스 감지", "pos");
        bits.push(direction === "SELL" ? `다만 ${txt}` : txt);
      } else if (analysis.macdDivergence && analysis.macdDivergence.divergence === "BEARISH") {
        const txt = toneSpan("MACD 약세 다이버전스 감지", "neg");
        bits.push(direction === "BUY" ? `다만 ${txt}` : txt);
      }

      if (rsInfo && Number.isFinite(rsInfo.rs20)) {
        if (rsInfo.rs20 >= 5) {
          const txt = toneSpan("지수 대비 아웃퍼폼 중", "pos");
          bits.push(direction === "SELL" ? `다만 ${txt}` : txt);
        } else if (rsInfo.rs20 <= -5) {
          const txt = toneSpan("지수 대비 언더퍼폼 중", "neg");
          bits.push(direction === "BUY" ? `다만 ${txt}` : txt);
        }
      }

      // 2026-08-03: 거래량 확인 — SCORE 반영과 같은 근거로, 서술에도 노출해서 왜 점수가
      // 조정됐는지 사용자가 알 수 있게 함.
      if (Number.isFinite(analysis.volumeRatio) && Number.isFinite(analysis.dailyChangePct)) {
        if (analysis.volumeRatio >= 1.8 && analysis.dailyChangePct > 0) {
          const txt = toneSpan("거래량 급증 동반 상승(수급 확인)", "pos");
          bits.push(direction === "SELL" ? `다만 ${txt}` : txt);
        } else if (analysis.volumeRatio >= 1.8 && analysis.dailyChangePct < 0) {
          const txt = toneSpan("거래량 급증 동반 하락(매도세 확인)", "neg");
          bits.push(direction === "BUY" ? `다만 ${txt}` : txt);
        } else if (analysis.volumeRatio < 0.5) {
          bits.push(toneSpan("거래량이 평소보다 크게 부족(확신 낮은 움직임)", "neu"));
        }
      }

      return bits;
    };

    // 위쪽 "수급"/"패턴" 탭에서 이미 계산해둔 신호를 전략요약에도 반영 —
    // 예전엔 지지·저항·R:R만 보고 판단해서 같은 화면 안의 수급/패턴 정보와 따로 놀았음
    // [수급 상태]/[캔들 패턴]은 눈에 잘 띄어야 하는 핵심 키워드라 노란색으로 강조(toneSpan highlight)
    // 2026-08-04 피드백: 수급/캔들패턴 태그가 실제 방향성과 무관하게 항상 노란색(highlight)
    // 하나였음 — 다른 신호들처럼 긍정(초록)/부정(빨강)/중립(노랑)으로 분리.
    const FLOW_DIRECTION = {
      BUY_DOMINANT: "pos",
      REBOUND_BUY: "pos",
      SELL_DOMINANT: "neg",
      REJECTION_SELL: "neg",
      NEUTRAL: "neu",
      BATTLE: "neu",
      EMPTY: "neu",
      INDECISION: "neu",
    };
    const buildContextLine = () => {
      const bits = [];
      if (flowInfo && flowInfo.flowLabel) {
        const sentiment = FLOW_DIRECTION[flowInfo.flowType] || "neu";
        bits.push(`수급은 ${toneSpan(`[${flowInfo.flowLabel}]`, sentiment)}`);
      }
      const topPattern = patterns && patterns[0];
      if (topPattern) {
        bits.push(`대표 캔들 패턴은 ${toneSpan(`[${topPattern.name}]`, topPattern.direction || "neu")}`);
      }
      return bits.length ? `참고로 현재 ${bits.join(", ")} 상태입니다.` : "";
    };

    let mainTxt = "중립 / 관망 구간";
    let detailLines = [];
    // conflict: R:R 기하학은 매수/매도를 가리키는데 RAVEN SCORE 등급이 정반대(D인데 R:R매수,
    // S/A인데 R:R매도)라 신호를 유보한 경우 — "애매해서 중립"이 아니라 "서로 반대라 유보"라는
    // 진짜 이유를 그대로 알려줌(무슨 이유로 중립인지 안 보이면 사용자가 오해하기 쉬움)
    if (verdict.conflict) {
      if (rrRatio >= 2) {
        mainTxt = "R:R은 매수 구조지만 추세 신호와 상충 (유보)";
        detailLines.push(
          `현재 구조상 R:R ≈ ${rrRatio.toFixed(2)}:1로 가격만 보면 매수 유리해 보이지만, RAVEN SCORE 등급이 ${verdict.rank}(추세·모멘텀이 좋지 않음)라 두 신호가 정반대입니다.`
        );
        detailLines.push(
          "가격 구조(지지·저항)만 보고 진입하기보다, 추세가 실제로 돌아서는지(ADX 반등, MACD 골든크로스 등) 확인 후 진입해도 늦지 않습니다."
        );
      } else {
        mainTxt = "R:R은 매도 구조지만 추세 신호와 상충 (유보)";
        detailLines.push(
          `현재 구조상 R:R ≈ ${rrRatio.toFixed(2)}:1로 가격만 보면 위험이 커 보이지만, RAVEN SCORE 등급이 ${verdict.rank}(추세·모멘텀이 강함)라 두 신호가 정반대입니다.`
        );
        detailLines.push(
          "추세가 좋은 종목의 일시적 눌림일 수 있어, 기존 보유분을 서둘러 정리하기보다 추세 훼손 여부(주요 이평선 이탈 등)를 먼저 확인하는 편이 안전합니다."
        );
      }
    } else {
      detailLines.push("지지선·저항선·RSI·R:R를 종합했을 때 뚜렷한 매수/매도 우위가 아닌 구간입니다.");
    }
    const neutralBits = buildIndicatorBits("NEUTRAL");
    if (neutralBits.length) {
      detailLines.push(`참고할 지표: ${neutralBits.join(", ")}.`);
    }
    detailLines.push("레버리지/단기 트레이딩보다는 관망 또는 소량만 대응하는 것을 권장합니다.");
    detailLines.push(
      ...buildActionLines(
        "여기까지 오르면 돌파 여부를 보고 추종 매수 재검토",
        null,
        "여기까지 빠지면 지지 여부를 보고 매수 재검토"
      )
    );

    if (verdict.tier === "BUY") {
      if (typeof rsiVal === "number" && rsiVal < 30) {
        mainTxt = "과매도 역추세 (고위험)";
        const oversoldBits = buildIndicatorBits("BUY");
        detailLines = [`RSI가 ${rsiVal.toFixed(1)}로 과매도 구간에 진입한 상태입니다.`];
        if (oversoldBits.length) detailLines.push(`추가로 ${oversoldBits.join(", ")} 상태입니다.`);
        detailLines.push("단기 기술적 반등 가능성은 있지만, 추세 자체가 약세라 고위험 역추세 전략입니다.");
        detailLines.push("포지션 크기를 줄이고, 지지선 이탈 시 재진입을 포기하는 강한 손절 기준이 필요합니다.");
        detailLines.push(
          ...buildActionLines(
            "반등 목표가 — 추세가 약하므로 도달 시 빠른 분할 익절 권장",
            null,
            "역추세 전략은 손절이 생명 — 이탈 시 미련 없이 즉시 손절"
          )
        );
        const trailingLine1 = buildTrailingStopLine();
        if (trailingLine1) detailLines.push(trailingLine1);
      } else {
        mainTxt = "지지선 근처 눌림 매수 우위";
        const bits = [];
        if (nearSupport) bits.push(`1차 지지선(${s1 ? formatPrice(s1) : "N/A"}) 근처`);
        bits.push(...buildIndicatorBits("BUY"));

        detailLines = [];
        if (bits.length) detailLines.push(`현재가가 ${bits.join(", ")} 상태입니다.`);
        detailLines.push(`${rrTxt}로 손절 대비 기대 수익이 유리한 구조입니다.`);
        detailLines.push("지지선 이탈 시 빠른 손절을 전제로 한 분할 매수 전략이 1안입니다.");
        detailLines.push(
          ...buildActionLines(
            "도달 시 절반 익절 후 나머지는 2차 목표가까지 홀딩 고려",
            "추세 지속 시 최종 목표가",
            "지지선 이탈 확정 시(종가 기준) 미련 없이 손절"
          )
        );
        const trailingLine2 = buildTrailingStopLine();
        if (trailingLine2) detailLines.push(trailingLine2);
        const breakLine2 = buildBreakScenarioLine("support");
        if (breakLine2) detailLines.push(breakLine2);
      }
    } else if (verdict.tier === "SELL") {
      if (nearResistance) {
        mainTxt = "저항선 근처 리스크 우위";
        const bits = [`1차 저항선(${r1 ? formatPrice(r1) : "N/A"}) 근처 상단 파동`];
        bits.push(...buildIndicatorBits("SELL"));

        detailLines = [
          `현재가가 ${bits.join(", ")}에 위치해 있고, ${rrTxt}로 아래쪽 리스크가 더 큰 구조입니다.`,
          "신규 매수보다는 기존 보유 물량의 분할 청산/헤지 전략이 1순위입니다."
        ];
        detailLines.push(
          ...buildActionLines(
            "저항 돌파 실패 시(반등 후 재하락) 기존 보유 물량 분할 청산 구간",
            null,
            "저항 부근에서도 밀리면서 이 가격대까지 빠지면 손절 검토"
          )
        );
        const breakLine3 = buildBreakScenarioLine("resistance");
        if (breakLine3) detailLines.push(breakLine3);
      } else {
        mainTxt = "R:R 불리 (위험 대비 보상 부족)";
        const rrBits = buildIndicatorBits("SELL");
        detailLines = [
          `현재 ${rrTxt}로, 손절 폭 대비 위쪽 기대 수익이 충분히 보상되지 않는 자리입니다.`
        ];
        if (rrBits.length) detailLines.push(`추가로 ${rrBits.join(", ")} 상태입니다.`);
        detailLines.push("추세·수급이 좋아 보여도 진입보다는 다음 더 유리한 R:R 구간을 기다리는 것이 효율적입니다.");
        detailLines.push(
          ...buildActionLines(
            "여기까지 오르면 R:R이 개선되니 그때 재검토",
            null,
            "이 가격대까지 밀리면 추가 하락 리스크가 커지는 구간"
          )
        );
      }
    }

    const ctx = buildContextLine();
    if (ctx) detailLines.push(ctx);

    if (stratMain) {
      stratMain.textContent = mainTxt;
      stratMain.classList.remove("tier-buy", "tier-sell", "tier-neutral");
      stratMain.classList.add(
        verdict.tier === "BUY" ? "tier-buy" : verdict.tier === "SELL" ? "tier-sell" : "tier-neutral"
      );
    }
    renderNarrativeBullets(stratDetail, detailLines);
  }

  // 5) Fund/뉴스 섹터 — 새 티커 분석 시작 시 이전 종목의 실적 차트·뉴스 목록을 지우고 로딩 상태로 리셋.
  // 실제 데이터 렌더링은 runAnalysisForTicker()에서 fetchIncomeStatementData()/fetchNewsData() 완료 후
  // 비동기로 처리(수급 탭과 동일한 패턴 — 메인 분석을 늦추지 않음).
  resetEarningsPanel();
  resetNewsPanel();

  // 6) RSI / MACD 박스 (숫자 + 짧은 해석)
  if (rsiBox) {
    if (typeof rsi === "number") {
      // 과열/과매도는 방향성 자체보다 "반전 위험 구간"이라는 경고 성격이 강해서 중립(주황) 취급.
      // 상승 우위만 명확한 긍정, 약세만 명확한 부정으로 분류.
      let rsiNote = "중립";
      let sentiment = "neu";
      if (rsi >= 70) rsiNote = "과열";
      else if (rsi >= 60) { rsiNote = "상승 우위"; sentiment = "pos"; }
      else if (rsi <= 30) rsiNote = "과매도";
      else if (rsi <= 40) { rsiNote = "약세"; sentiment = "neg"; }

      let crossTxt = "";
      if (analysis.rsiCross === "BUY") crossTxt = " · 과매도 탈출(반등 신호)";
      else if (analysis.rsiCross === "SELL") crossTxt = " · 과열 이탈(조정 신호)";

      setIndicatorBox(rsiBox, rsi.toFixed(1), `${rsiNote}${crossTxt}`, sentiment);
    } else {
      setIndicatorBox(rsiBox, "데이터 부족");
    }
  }

  if (macdBox) {
    if (typeof analysis.macd === "number") {
      const dir = analysis.macd >= 0 ? "상승 우위" : "하락 우위";
      const sentiment = analysis.macd >= 0 ? "pos" : "neg";
      // ⚠️ 실측 피드백으로 발견한 문제: MACD 라인이 마이너스(하락 우위)인데 골든크로스가 막 나온
      // 경우처럼 두 신호가 엇갈릴 수 있는데, 예전엔 문장 전체를 dir(라인 방향) 기준 한 색으로만
      // 칠해서 "골든크로스(매수 신호)"라는 글자가 빨갛게 나오는 모순이 있었음 — 크로스오버 문구는
      // toneSpan으로 그 자체의 방향에 맞게 별도 색칠(전체 문장의 기본색인 dir과 달라도 그대로 유지).
      let crossTxt = "";
      if (analysis.macdCrossover === "GOLDEN") {
        crossTxt = ` · ${toneSpan("골든크로스(매수 신호)", "pos")}`;
      } else if (analysis.macdCrossover === "DEAD") {
        crossTxt = ` · ${toneSpan("데드크로스(매도 신호)", "neg")}`;
      }
      const macdValueText = `${
        analysis.macd >= 0 ? "+" : ""
      }${analysis.macd.toFixed(3)}`;
      setIndicatorBox(macdBox, macdValueText, `${dir}${crossTxt}`, sentiment);
    } else {
      setIndicatorBox(macdBox, "데이터 부족");
    }
  }

  if (adxBox) {
    if (typeof adx === "number") {
      let strengthNote = "보통";
      if (adx >= 25) strengthNote = "뚜렷함";
      else if (adx < 20) strengthNote = "약함(횡보 가능성)";

      // ADX 자체는 추세 "강도"라 방향성이 없음 — 색깔은 DI+/DI-가 가리키는 방향으로 정하되,
      // 추세가 약하면(횡보 가능성) 그 방향을 신뢰하기 어려우니 중립으로 둠.
      // ⚠️ 예전엔 "추세 뚜렷함, DI- 우위"처럼 강도와 방향을 분리해서 적어, 강도(뚜렷함)만 보고
      // "왜 좋은 신호인데 빨간색이지?"라고 오해하기 쉬웠음(실측 피드백) — 방향을 "추세" 앞에 붙여
      // "하락 추세 뚜렷함"처럼 강도+방향이 한 문구로 읽히도록 수정.
      let directionPrefix = "";
      let diSuffix = "";
      let sentiment = "neu";
      if (typeof plusDI === "number" && typeof minusDI === "number") {
        const bullish = plusDI > minusDI;
        if (adx >= 20) {
          directionPrefix = bullish ? "상승 " : "하락 ";
          sentiment = bullish ? "pos" : "neg";
        } else {
          // 추세 자체가 약하면 방향을 "추세" 앞에 못 붙이고(신뢰 어려움) 참고용으로만 뒤에 표기
          diSuffix = bullish ? ", DI+ 우위" : ", DI- 우위";
        }
      }
      // ADX 숫자가 같아도 강해지는 중인지 약해지는 중인지에 따라 의미가 다름
      // (예: 15→25는 추세가 막 시작되는 신호, 35→25는 추세가 식어가는 신호 — 둘 다 "25"지만 정반대 국면)
      let adxTrendTxt = "";
      if (adxTrend === "RISING") adxTrendTxt = ", 강도 강화 중";
      else if (adxTrend === "FALLING") adxTrendTxt = ", 강도 약화 중";
      setIndicatorBox(adxBox, adx.toFixed(1), `${directionPrefix}추세 ${strengthNote}${diSuffix}${adxTrendTxt}`, sentiment);
    } else {
      setIndicatorBox(adxBox, "데이터 부족");
    }
  }

  if (atrBox) {
    if (typeof atr === "number") {
      const atrPctTxt = typeof atrPct === "number" ? ` (${atrPct.toFixed(1)}%)` : "";
      // 20일 변동성(volatility)은 RAVEN SCORE에 감점/가점으로 이미 반영되고 있는데
      // 정작 화면 어디에도 안 보여서 "왜 이 종목만 점수가 깎였는지" 알 수 없었음 — 여기 노출.
      // ATR 자체는 방향성 없는 변동성 지표라 기본은 무채색 유지 — "점수 감점 요인"이 붙을 때만
      // (RAVEN SCORE에 실제로 불리하게 반영된다는 뜻이라) 부정으로 표시.
      let volTxt = "";
      let sentiment;
      if (typeof volatility === "number") {
        if (volatility > 6) { volTxt = " · 20일 변동성 높음(점수 감점 요인)"; sentiment = "neg"; }
        else if (volatility > 0 && volatility < 2) { volTxt = " · 20일 변동성 매우 낮음(점수 감점 요인)"; sentiment = "neg"; }
      }
      setIndicatorBox(atrBox, `${formatPrice(atr)}${atrPctTxt}`, `손절폭 산정 기준${volTxt}`, sentiment);
    } else {
      setIndicatorBox(atrBox, "데이터 부족");
    }
  }

  const trendSummaryEl = $("trend-summary-txt");
  renderBulletList(trendSummaryEl, summarizeTrendMomentum(analysis));

  const patternSummaryEl = $("pattern-summary-txt");
  renderBulletList(patternSummaryEl, summarizePattern(patterns, verdict));

  // 마지막 분석 결과 저장 (AI 서술 분석 요청 시 이 값을 그대로 서버에 전달)
  lastAnalysis = {
    data,
    analysis,
    fxRate,
    flowInfo,
    whyInfo,
    patterns,
    stockName,
    supplyDemand: null
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
// 📑 상세 탭 (추세·모멘텀 / 수급 / 패턴·신호 / 실적 / 뉴스)
// ===============================
function initResultTabs() {
  const tabBtns = document.querySelectorAll(".tab-btn");
  const panels = document.querySelectorAll(".tab-panel");
  if (!tabBtns.length || !panels.length) return;

  // 2026-08-04 3차 재확인: QHD 100% 배율(스케일링/줌 전혀 없는 네이티브 렌더링)에서도 재현된다는
  // 보고로, 서브픽셀 translateX 반올림 가설이 틀렸다는 게 확인됨 — 슬라이드(translateX +
  // overflow:hidden) 방식 자체가 크롬 컴포지터에서 원인을 특정하기 어려운 seam을 만드는 것으로
  // 보고, 슬라이드를 아예 포기함. 비활성 탭 패널은 display:none이라 레이아웃/페인트 자체가 안
  // 일어나서 옆 패널이 비쳐 보일 방법이 구조적으로 없어짐.
  // 이후 재요청: 전환 애니메이션 자체는 있는 게 낫겠다 — seam 원인이었던 "이동"(translateX) 대신
  // 제자리에서 살짝 떠오르며 페이드인하는 방식으로 복원(위치를 안 바꾸니 컴포지터 seam과 무관함).
  // display:none→grid 전환은 그 자체로 애니메이션이 안 되므로, 먼저 .active로 grid를 걸고
  // 강제 reflow(offsetWidth 읽기)를 시킨 다음 .tab-fade-in을 붙여야 CSS 트랜지션이 재생됨.
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;
      tabBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      panels.forEach((p) => {
        const isTarget = p.dataset.tabPanel === target;
        p.classList.toggle("active", isTarget);
        p.classList.remove("tab-fade-in");
        if (isTarget) {
          void p.offsetWidth; // 강제 reflow — display:none→grid가 먼저 적용되게 함
          p.classList.add("tab-fade-in");
        }
      });
    });
  });
}

// RAVEN SCORE 캡션의 ℹ️ 버튼 → 산정 방식 팝업 열기/닫기 (요청 반영, 2026-08-04)
function initScoreFormulaModal() {
  const btn = $("score-formula-btn");
  const modal = $("score-formula-modal");
  const backdrop = $("score-formula-backdrop");
  const closeBtn = $("score-formula-close");
  if (!btn || !modal) return;

  const open = () => modal.classList.remove("hidden");
  const close = () => modal.classList.add("hidden");

  btn.addEventListener("click", open);
  if (backdrop) backdrop.addEventListener("click", close);
  if (closeBtn) closeBtn.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) close();
  });
}

// ===============================
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

  if (dateEl) dateEl.textContent = data.date ? `기준일: ${data.date}` : "";
  if (listEl) {
    listEl.innerHTML = "";
    data.lines.forEach((line) => {
      const li = document.createElement("li");
      li.textContent = line;
      listEl.appendChild(li);
    });
  }

  box.classList.remove("hidden");

  // 2026-08-04 피드백: outlook(전일 수급 박스 자체의 결론 문장)과 outlookShort(수급 종합의 결론
  // 문장)가 표현만 다를 뿐 사실상 같은 내용을 두 번 말하는 것처럼 보인다는 지적 — 전일 수급
  // 박스는 원자료(항목별 해석 리스트)만 보여주는 역할로 좁히고, 결론은 수급 종합 하나로 일원화.
  const supplySummaryEl = $("supply-summary-txt");
  if (supplySummaryEl && data.outlookShort) {
    const li = document.createElement("li");
    li.textContent = data.outlookShort;
    supplySummaryEl.appendChild(li);
  }
}

// ===============================
// 실적 탭 (Phase 5, 3단계 — 분기별 매출액/영업이익)
// ===============================

// 새 티커 분석 시작 시 이전 종목의 실적 차트를 지우고 로딩 상태로 리셋
function resetEarningsPanel() {
  const svg = $("fund-chart");
  const empty = $("fund-chart-empty");
  const legend = $("fund-legend");
  const labelsEl = $("fund-chart-labels");
  const listEl = $("fund-quarter-list");
  const headerEl = $("fund-quarter-header");
  const summaryEl = $("fund-summary-txt");

  if (svg) {
    svg.innerHTML = "";
    svg.classList.add("hidden");
  }
  if (legend) legend.classList.add("hidden");
  if (labelsEl) {
    labelsEl.innerHTML = "";
    labelsEl.classList.add("hidden");
  }
  if (listEl) {
    listEl.innerHTML = "";
    listEl.classList.add("hidden");
  }
  if (headerEl) headerEl.classList.add("hidden");
  if (empty) {
    empty.textContent = "데이터를 불러오는 중...";
    empty.classList.remove("hidden");
  }
  if (summaryEl) renderBulletList(summaryEl, ["분석 중..."]);
}

// KIS 손익계산서(국내)는 억원 단위로 옴 — 1조원 넘어가면 "조원" 단위로 환산해서 표시(가독성)
function formatEokwon(value) {
  if (!Number.isFinite(value)) return "-";
  const trillions = value / 10000;
  if (Math.abs(trillions) >= 1) {
    return `${trillions.toLocaleString("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}조원`;
  }
  return `${Math.round(value).toLocaleString("ko-KR")}억원`;
}

// Yahoo Finance(해외)는 달러 원단위 그대로 옴(예: 29589000000) — B(십억)/M(백만) 단위로 환산
function formatUsdCompact(value) {
  if (!Number.isFinite(value)) return "-";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toLocaleString("en-US", { maximumFractionDigits: 2 })}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toLocaleString("en-US", { maximumFractionDigits: 1 })}M`;
  return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
}

// ⚠️ 실제 버그: 이 맵이 원래 국내(KIS, 결산월이 항상 정확히 03/06/09/12월)만 염두에 두고 만들어져서
// 4개월만 있었음 — 해외(Yahoo) 분기 데이터의 asOfDate가 이 4개월이 아닌 달로 찍히면(회사마다 회계연도가
// 달라 분기 마감월이 다를 수 있음) 전부 "Q?"로 표시되던 문제였음. 서버(yahooFundamentals.js)가 label을
// 계산할 때 쓰는 것과 동일한 "01~12월 전체를 분기로 버킷팅"하는 맵으로 맞춰서 항상 숫자가 나오게 함.
const QUARTER_MONTH_LABEL = {
  "01": "1", "02": "1", "03": "1",
  "04": "2", "05": "2", "06": "2",
  "07": "3", "08": "3", "09": "3",
  "10": "4", "11": "4", "12": "4",
};
function shortQuarterLabel(yyyymm) {
  const year = yyyymm.slice(2, 4);
  const q = QUARTER_MONTH_LABEL[yyyymm.slice(4, 6)] || "?";
  return `'${year} Q${q}`;
}

// 분기별 매출액/영업이익 그룹 막대 차트 — Chart.js 등 외부 라이브러리 없이 순수 SVG로 직접 그림
// (막대 8개 x 2계열 정도의 단순한 차트라 새 의존성을 추가할 필요가 없다고 판단함, 2026-08-01).
// 매출액과 영업이익을 같은 스케일에 그려서 영업이익률이 막대 높이 비율로도 바로 보이게 함 —
// 영업적자 분기는 기준선(baseline) 아래로 내려가는 빨간 막대로 표시.
// currency: "KRW"(국내, KIS 억원 단위) | "USD"(해외, Yahoo Finance 달러 원단위) — 단위 포맷터만 다름.
function renderEarningsChart(quarters, currency) {
  const svg = $("fund-chart");
  const empty = $("fund-chart-empty");
  const legend = $("fund-legend");
  const labelsEl = $("fund-chart-labels");
  const listEl = $("fund-quarter-list");
  const headerEl = $("fund-quarter-header");
  const summaryEl = $("fund-summary-txt");
  if (!svg || !empty) return;

  const fmt = currency === "USD" ? formatUsdCompact : formatEokwon;

  const showEmpty = (msg) => {
    empty.textContent = msg;
    empty.classList.remove("hidden");
    svg.classList.add("hidden");
    if (legend) legend.classList.add("hidden");
    if (labelsEl) labelsEl.classList.add("hidden");
    if (listEl) listEl.classList.add("hidden");
    if (headerEl) headerEl.classList.add("hidden");
    renderBulletList(summaryEl, [msg]);
  };

  if (!quarters || !quarters.length) {
    showEmpty("실적 데이터를 불러오지 못했습니다.");
    return;
  }

  // 2026-08-04 피드백: 8분기(2년치)는 너무 많아 보임 — 최근 5분기만(예: '25 Q1~'26 Q1)
  const shown = quarters.slice(-5);
  empty.classList.add("hidden");

  // --- SVG 그룹 막대 차트 ---
  const slotWidth = 60;
  const barWidth = 18;
  const gap = 4;
  const height = 100;
  const width = shown.length * slotWidth;

  const maxPos = Math.max(1, ...shown.map((q) => Math.max(q.revenue, q.operatingProfit, 0)));
  const maxNeg = Math.max(0, ...shown.map((q) => Math.max(-q.operatingProfit, 0)));
  const span = maxPos + maxNeg;
  const baselineY = height * (maxPos / span);

  let svgContent = "";
  if (maxNeg > 0) {
    svgContent += `<line x1="0" y1="${baselineY.toFixed(2)}" x2="${width}" y2="${baselineY.toFixed(2)}" stroke="rgba(148,163,184,0.35)" stroke-width="1" />`;
  }

  shown.forEach((q, i) => {
    const groupPad = (slotWidth - (barWidth * 2 + gap)) / 2;
    const revX = i * slotWidth + groupPad;
    const profitX = revX + barWidth + gap;

    const revHeight = (q.revenue / span) * height;
    svgContent += `<rect x="${revX.toFixed(2)}" y="${(baselineY - revHeight).toFixed(2)}" width="${barWidth}" height="${revHeight.toFixed(2)}" rx="2" fill="var(--accent)" />`;

    const profit = q.operatingProfit;
    if (profit >= 0) {
      const h = (profit / span) * height;
      svgContent += `<rect x="${profitX.toFixed(2)}" y="${(baselineY - h).toFixed(2)}" width="${barWidth}" height="${h.toFixed(2)}" rx="2" fill="var(--success)" />`;
    } else {
      const h = (-profit / span) * height;
      svgContent += `<rect x="${profitX.toFixed(2)}" y="${baselineY.toFixed(2)}" width="${barWidth}" height="${h.toFixed(2)}" rx="2" fill="var(--danger)" />`;
    }
  });

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = svgContent;
  svg.classList.remove("hidden");

  // --- 분기 라벨: SVG 밖 별도 HTML 행에 그림 (preserveAspectRatio="none"으로 늘어난 SVG 안에
  // <text>를 넣으면 글자가 가로/세로 비율이 달라져 찌그러져 보이는 문제를 피하기 위함) ---
  if (labelsEl) {
    labelsEl.innerHTML = "";
    shown.forEach((q) => {
      const span2 = document.createElement("span");
      span2.textContent = shortQuarterLabel(q.yyyymm);
      labelsEl.appendChild(span2);
    });
    labelsEl.classList.remove("hidden");
  }

  if (legend) legend.classList.remove("hidden");

  // --- 분기별 정확한 수치 목록(차트만으론 정밀한 값을 읽기 어려우므로 병기) — 최신 분기가 위로 오게 역순 ---
  if (listEl) {
    listEl.innerHTML = "";
    shown
      .slice()
      .reverse()
      .forEach((q) => {
        const li = document.createElement("li");
        li.className = "earnings-quarter-row";
        const marginPct = q.revenue ? (q.operatingProfit / q.revenue) * 100 : null;
        const marginTxt = Number.isFinite(marginPct) ? ` (${marginPct.toFixed(1)}%)` : "";
        li.innerHTML =
          `<span class="earnings-capsule">${q.label || shortQuarterLabel(q.yyyymm)}</span>` +
          `<span class="earnings-capsule">${fmt(q.revenue)}</span>` +
          `<span class="earnings-capsule">${fmt(q.operatingProfit)}${marginTxt}</span>`;
        listEl.appendChild(li);
      });
    listEl.classList.remove("hidden");
    if (headerEl) headerEl.classList.remove("hidden");
  }

  // --- 종합 요약: 다른 탭들(추세/수급/패턴)처럼 숫자 나열이 아니라 여러 분기를 종합한 "해석"을
  // 불릿으로 제공(요청 반영) — ①최근 분기 실적+전년동기대비(YoY) ②최근 수 개 분기의 매출·이익률
  // 추세 방향(표/차트로는 눈으로 훑어야 알 수 있는 걸 문장으로 정리).
  if (summaryEl) {
    renderBulletList(summaryEl, summarizeEarnings(shown, quarters, fmt));
  }
}

function summarizeEarnings(shown, allQuarters, fmt) {
  const bullets = [];
  const latest = shown[shown.length - 1];
  const latestYear = Number(latest.yyyymm.slice(0, 4));
  const latestMonth = latest.yyyymm.slice(4, 6);
  const yearAgo = allQuarters.find(
    (q) => q.yyyymm.slice(4, 6) === latestMonth && Number(q.yyyymm.slice(0, 4)) === latestYear - 1
  );
  const latestMargin = latest.revenue ? (latest.operatingProfit / latest.revenue) * 100 : null;

  let latestLine = `최근 분기(${latest.label || shortQuarterLabel(latest.yyyymm)}) 매출액 ${fmt(
    latest.revenue
  )}, 영업이익 ${fmt(latest.operatingProfit)}`;
  if (Number.isFinite(latestMargin)) latestLine += `(영업이익률 ${latestMargin.toFixed(1)}%)`;
  if (latest.operatingProfit < 0) latestLine += " — 영업적자";
  bullets.push(latestLine + ".");

  if (yearAgo) {
    let yoyLine = "";
    const revYoy = yearAgo.revenue ? ((latest.revenue - yearAgo.revenue) / yearAgo.revenue) * 100 : null;
    if (Number.isFinite(revYoy)) {
      yoyLine += `전년 동기 대비 매출 ${revYoy >= 0 ? "+" : ""}${revYoy.toFixed(1)}%`;
    }
    if (yearAgo.operatingProfit < 0 && latest.operatingProfit >= 0) {
      yoyLine += (yoyLine ? ", " : "") + "영업이익 흑자 전환";
    } else if (yearAgo.operatingProfit >= 0 && latest.operatingProfit < 0) {
      yoyLine += (yoyLine ? ", " : "") + "영업이익 적자 전환";
    } else if (yearAgo.operatingProfit) {
      const opYoy = ((latest.operatingProfit - yearAgo.operatingProfit) / Math.abs(yearAgo.operatingProfit)) * 100;
      yoyLine += (yoyLine ? ", " : "") + `영업이익 ${opYoy >= 0 ? "+" : ""}${opYoy.toFixed(1)}%`;
    }
    if (yoyLine) bullets.push(yoyLine + ".");
  }

  // 최근 3~4개 분기의 매출/이익률 방향성 — 표·차트를 하나하나 비교하지 않아도 흐름을 바로 알 수 있게.
  const recent = shown.slice(-4);
  if (recent.length >= 3) {
    const revUpCount = recent
      .slice(1)
      .filter((q, i) => q.revenue > recent[i].revenue).length;
    const revDownCount = recent.length - 1 - revUpCount;
    let trendWord = "혼조";
    if (revUpCount >= recent.length - 1) trendWord = "꾸준한 증가";
    else if (revDownCount >= recent.length - 1) trendWord = "꾸준한 감소";
    else if (revUpCount > revDownCount) trendWord = "대체로 증가";
    else if (revDownCount > revUpCount) trendWord = "대체로 감소";
    bullets.push(`최근 ${recent.length}개 분기 매출액은 ${trendWord} 추세입니다.`);

    const margins = recent
      .map((q) => (q.revenue ? (q.operatingProfit / q.revenue) * 100 : null))
      .filter((m) => Number.isFinite(m));
    if (margins.length >= 3) {
      const marginDelta = margins[margins.length - 1] - margins[0];
      if (marginDelta >= 2) {
        bullets.push(`영업이익률이 ${margins[0].toFixed(1)}%→${margins[margins.length - 1].toFixed(1)}%로 개선되는 흐름입니다.`);
      } else if (marginDelta <= -2) {
        bullets.push(`영업이익률이 ${margins[0].toFixed(1)}%→${margins[margins.length - 1].toFixed(1)}%로 악화되는 흐름입니다.`);
      } else {
        bullets.push(`영업이익률은 최근 ${recent.length}개 분기 동안 ${margins[0].toFixed(1)}%대에서 큰 변화 없이 유지되고 있습니다.`);
      }
    }
  }

  return bullets;
}

// ===============================
// 뉴스 탭 (Phase 5, 4단계) — 국내/해외 모두 KIS news-title 엔드포인트 하나로 커버됨
// ===============================

function resetNewsPanel() {
  const listEl = $("news-list");
  const emptyEl = $("news-empty");
  if (listEl) {
    listEl.innerHTML = "";
    listEl.classList.add("hidden");
  }
  if (emptyEl) {
    emptyEl.textContent = "데이터를 불러오는 중...";
    emptyEl.classList.remove("hidden");
  }
}

function renderNewsList(news) {
  const listEl = $("news-list");
  const emptyEl = $("news-empty");
  if (!listEl || !emptyEl) return;

  if (!news || !news.length) {
    emptyEl.textContent = "관련 뉴스를 찾지 못했습니다.";
    emptyEl.classList.remove("hidden");
    listEl.classList.add("hidden");
    return;
  }

  emptyEl.classList.add("hidden");
  listEl.innerHTML = "";
  news.slice(0, 15).forEach((n) => {
    const li = document.createElement("li");
    li.className = "news-row";
    const meta = [n.date, n.time].filter(Boolean).join(" ");
    const metaLine = [meta, n.source].filter(Boolean).join(" · ");
    const title = n.title || "(제목 없음)";
    // KIS news-title 응답엔 기사 원문 링크 필드 자체가 없음(국내/해외 둘 다 실측 확인 —
    // 내부 일련번호만 있고 공개 URL 없음, 이 세션에도 재확인함) — 완전한 "원문 링크"는 이
    // 데이터소스로는 불가능해서, 대신 구글 일반검색(결과 페이지 자체가 뜸)보다 실제 기사가 바로
    // 클릭되는 구글 뉴스검색으로 교체(요청 반영, 완전한 해결은 아니고 클릭 경험 개선).
    const searchUrl = `https://news.google.com/search?q=${encodeURIComponent(
      [title, n.source].filter(Boolean).join(" ")
    )}&hl=ko&gl=KR`;
    li.innerHTML =
      `<a class="news-title" href="${searchUrl}" target="_blank" rel="noopener noreferrer">${title}</a>` +
      (metaLine ? `<div class="news-meta">${metaLine}</div>` : "");
    listEl.appendChild(li);
  });
  listEl.classList.remove("hidden");
}

// 외국인/기관 연속매매(investorStreakTone, -2~+2)를 RAVEN SCORE에 소폭 반영 — 전일 수급(KIS)은
// 메인 렌더링보다 늦게 도착하므로, 이미 그려진 SCORE 배지를 사후 조정하는 방식(로딩 순서 자체를
// 바꾸지 않고 늦게 도착한 데이터를 반영하는 기존 패턴 — renderSupplyDemandBox와 동일).
// RS(rsInfo.rs20 * 0.4, clamp ±8)와 같은 크기의 가중치를 씀 — 다른 보조 요인들과 비슷한 비중.
function applyInvestorStreakToScore(sdData, symbol) {
  if (!sdData || !Number.isFinite(sdData.investorStreakTone) || sdData.investorStreakTone === 0) return;
  // 이 응답이 오는 사이에 사용자가 다른 종목을 새로 검색했을 수 있음 — 지금 화면과 다른 종목이면 무시
  if (!lastAnalysis || lastAnalysis.data.symbol !== symbol) return;

  const delta = Math.max(-8, Math.min(8, sdData.investorStreakTone * 4));
  if (delta === 0) return;

  const newScore = Math.round(Math.max(0, Math.min(99, lastAnalysis.analysis.score + delta)));
  const newRank = rankFromScore(newScore);
  lastAnalysis.analysis.score = newScore;
  lastAnalysis.analysis.rank = newRank;

  updateScoreAndRankDisplay(newScore, newRank);
  // 2026-08-04 피드백: 캡션에 "(외국인·기관 연속매매 반영 ±N점)"을 매번 덧붙이던 걸 생략 —
  // 점수/등급 자체는 그대로 조정되어 반영되지만, 캡션 문구는 건드리지 않고 그대로 둠
  // (캡션에 새로 추가된 산정방식 안내 버튼(ℹ️)이 여기서 캡션 전체를 덮어쓰면 같이 사라지는
  // 문제도 있었음).
}

// ===============================
// 관심종목 (Phase 3)
// ===============================
let watchlistCache = [];

async function fetchWatchlist() {
  try {
    const res = await fetch(`${API_BASE}/api/watchlist`);
    if (!res.ok) return [];
    const json = await res.json();
    return json.result || [];
  } catch (e) {
    console.warn("[RAVEN] 관심종목 조회 실패:", e);
    return [];
  }
}

async function addToWatchlist(symbol, domestic, name) {
  try {
    const res = await fetch(`${API_BASE}/api/watchlist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol, domestic, name: name || null })
    });
    return res.ok;
  } catch (e) {
    console.warn("[RAVEN] 관심종목 추가 실패:", e);
    return false;
  }
}

async function removeFromWatchlist(symbol) {
  try {
    const res = await fetch(`${API_BASE}/api/watchlist/${encodeURIComponent(symbol)}`, {
      method: "DELETE"
    });
    return res.ok;
  } catch (e) {
    console.warn("[RAVEN] 관심종목 삭제 실패:", e);
    return false;
  }
}

// 종목 현재가/등락률 조회(관심종목 패널 각 줄에 표시용) — 기존 /api/kis/candles를 count=2로 호출해서
// 최신 종가/전일 종가만 뽑아 씀(국내/해외 모두 이 엔드포인트 하나로 처리됨, 신규 API 불필요).
// 응답은 최신순이라 candles[0]=오늘, candles[1]=전일(kisMarket.js의 fetchCandles 규약).
async function fetchWatchlistItemQuote(symbol) {
  try {
    const res = await fetch(`${API_BASE}/api/kis/candles?symbol=${encodeURIComponent(symbol)}&interval=1d&count=2`);
    if (!res.ok) return null;
    const json = await res.json();
    const candles = json.result && json.result.candles;
    if (!Array.isArray(candles) || candles.length < 2) return null;
    const last = Number(candles[0].closePrice);
    const prev = Number(candles[1].closePrice);
    if (!Number.isFinite(last) || !Number.isFinite(prev) || !prev) return null;
    return { last, changePct: ((last - prev) / prev) * 100 };
  } catch (e) {
    return null;
  }
}

async function updateWatchlistItemGroup(symbol, groupName) {
  try {
    const res = await fetch(`${API_BASE}/api/watchlist/${encodeURIComponent(symbol)}/group`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group_name: groupName })
    });
    return res.ok;
  } catch (e) {
    console.warn("[RAVEN] 관심종목 그룹 변경 실패:", e);
    return false;
  }
}

// 미국 성조기 — 이모지(🇺🇸)가 Windows에서 "US" 텍스트로만 나오는 문제 때문에 OS/폰트 의존 없는
// 인라인 SVG로 대체(13줄 stripe + 캔턴만 표현한 단순화 버전, 뱃지 크기가 작아 별 디테일은 생략).
const US_FLAG_SVG = `<svg viewBox="0 0 19 10" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="미국">
  <rect width="19" height="10" fill="#B22234"/>
  <g fill="#fff">
    <rect y="0.77" width="19" height="0.77"/>
    <rect y="2.31" width="19" height="0.77"/>
    <rect y="3.85" width="19" height="0.77"/>
    <rect y="5.38" width="19" height="0.77"/>
    <rect y="6.92" width="19" height="0.77"/>
    <rect y="8.46" width="19" height="0.77"/>
  </g>
  <rect width="7.6" height="5.38" fill="#3C3B6E"/>
</svg>`;

// 관심종목 항목 한 줄 생성 — 이름(코드 괄호 없이)/시장구분 뱃지/현재가·등락률(비동기 채움)/그룹 이동
// select/삭제 버튼. 종목명 옆 이름수정 연필 아이콘은 삭제함(2026-08-09 피드백 — 그룹명 수정 기능을
// 만들다가 잘못 종목명 쪽에도 붙었던 것, 그 자리에 시장구분 뱃지를 넣음).
function buildWatchlistItemRow(item, groupNames) {
  const row = document.createElement("div");
  row.className = "watchlist-sidebar-item";

  const star = document.createElement("span");
  star.className = "watchlist-sidebar-item-star";
  star.textContent = "★";
  row.appendChild(star);

  const main = document.createElement("div");
  main.className = "watchlist-sidebar-item-main";

  // 라벨 + 시장구분 뱃지를 한 줄(가로)로, 그 아래 가격을 별도 줄(세로)로 배치하기 위한 래퍼.
  const labelRow = document.createElement("div");
  labelRow.className = "watchlist-sidebar-item-label-row";

  const label = document.createElement("span");
  label.className = "watchlist-sidebar-item-label";
  label.textContent = item.name || item.symbol;
  labelRow.appendChild(label);

  // 시장구분 뱃지 — 해외는 바로 성조기, 국내는 KOSPI/KOSDAQ를 비동기로 채움(상장목록 조회가
  // 필요해서). renderWatchlistSidebar가 rowEl.querySelector로 이 요소를 찾아 채워 넣음.
  // ⚠️ 이모지 🇺🇸(지역표시 문자 2개 조합)는 Windows(Segoe UI Emoji)가 플래그 리가처를 지원 안 해서
  // "US" 텍스트 두 글자로만 표시됨(실사용자 스크린샷으로 확인) — OS/폰트에 의존하지 않는 인라인 SVG로
  // 대체함.
  const marketBadge = document.createElement("span");
  if (isDomesticTicker(item.symbol)) {
    marketBadge.className = "watchlist-sidebar-item-market";
  } else {
    marketBadge.className = "watchlist-sidebar-item-flag";
    marketBadge.innerHTML = US_FLAG_SVG;
    marketBadge.title = "해외(미국) 종목";
  }
  labelRow.appendChild(marketBadge);
  main.appendChild(labelRow);

  const priceEl = document.createElement("span");
  priceEl.className = "watchlist-sidebar-item-price";
  priceEl.textContent = "…";
  main.appendChild(priceEl);

  main.addEventListener("click", () => {
    runAnalysisForTicker(item.symbol);
    closeWatchlistSidebarOnMobile();
  });
  row.appendChild(main);

  // 그룹 이동 select — "미분류" + 기존 그룹명들 + "새 그룹 만들기"
  // 2026-08-04 피드백: 현재 그룹명 텍스트 없이 화살표만 보이면 됨 — 처음엔 select 폭만 줄이고
  // 텍스트를 투명 처리했는데, 20px처럼 작은 폭에서는 크롬이 네이티브 화살표 자체를 그려주지
  // 않아서 아무것도 안 보이는 버그가 됨(실측 확인). select는 완전히 투명한 채로 wrapper 전체를
  // 덮게 하고(클릭/키보드 동작은 그대로 유지), 화살표는 별도 span으로 항상 보이게 직접 그림.
  const groupWrap = document.createElement("span");
  groupWrap.className = "watchlist-sidebar-item-group-wrap";

  const groupSelect = document.createElement("select");
  groupSelect.className = "watchlist-sidebar-item-group";
  groupSelect.title = "그룹 이동";
  const currentGroup = item.group_name || "미분류";
  const optionValues = ["미분류", ...groupNames.filter((g) => g !== "미분류"), "+ 새 그룹"];
  optionValues.forEach((g) => {
    const opt = document.createElement("option");
    opt.value = g;
    opt.textContent = g;
    if (g === currentGroup) opt.selected = true;
    groupSelect.appendChild(opt);
  });
  groupSelect.addEventListener("click", (e) => e.stopPropagation());
  groupSelect.addEventListener("change", async () => {
    let target = groupSelect.value;
    if (target === "+ 새 그룹") {
      const typed = window.prompt("새 그룹 이름을 입력하세요");
      if (!typed || !typed.trim()) {
        groupSelect.value = currentGroup;
        return;
      }
      target = typed.trim();
    }
    const finalGroup = target === "미분류" ? null : target;
    const ok = await updateWatchlistItemGroup(item.symbol, finalGroup);
    if (ok) {
      const cacheItem = watchlistCache.find((w) => w.symbol === item.symbol);
      if (cacheItem) cacheItem.group_name = finalGroup;
      renderWatchlistSidebar(watchlistCache);
    } else {
      showToast("그룹 변경에 실패했습니다.");
      groupSelect.value = currentGroup;
    }
  });
  groupWrap.appendChild(groupSelect);
  const groupArrow = document.createElement("span");
  groupArrow.className = "watchlist-sidebar-item-group-arrow";
  groupArrow.textContent = "▾";
  groupArrow.setAttribute("aria-hidden", "true");
  groupWrap.appendChild(groupArrow);
  row.appendChild(groupWrap);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "watchlist-sidebar-item-remove";
  removeBtn.textContent = "×";
  removeBtn.title = "관심종목에서 삭제";
  removeBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const ok = await removeFromWatchlist(item.symbol);
    if (ok) {
      renderWatchlistSidebar(watchlistCache.filter((w) => w.symbol !== item.symbol));
      updateWatchlistStarState();
    } else {
      showToast("관심종목 삭제에 실패했습니다.");
    }
  });
  row.appendChild(removeBtn);

  return row;
}

// 관심종목 목록 렌더링 — 그룹별로 묶어서 표시(그룹 없는 종목은 "미분류"). 각 줄의 현재가/등락률은
// KIS 호출이 필요해서 렌더링을 막지 않도록 종목마다 약간의 시차를 두고 비동기로 채움(레이트리밋 방지).
function renderWatchlistSidebar(list) {
  const countEl = $("watchlist-count");
  const listEl = $("watchlist-sidebar-list");
  const emptyEl = $("watchlist-sidebar-empty");
  if (!listEl) return;

  watchlistCache = list;

  if (!list.length) {
    listEl.innerHTML = "";
    if (countEl) countEl.textContent = "";
    if (emptyEl) emptyEl.classList.remove("hidden");
    return;
  }

  if (countEl) countEl.textContent = `(${list.length})`;
  if (emptyEl) emptyEl.classList.add("hidden");

  // 그룹명 순서: 처음 등장한 순서대로(안정적인 표시 순서), "미분류"는 항상 맨 뒤
  const groupOrder = [];
  list.forEach((item) => {
    const g = item.group_name || "미분류";
    if (g !== "미분류" && !groupOrder.includes(g)) groupOrder.push(g);
  });
  if (list.some((item) => !item.group_name)) groupOrder.push("미분류");

  listEl.innerHTML = "";
  const priceTargets = []; // { symbol, el } — 렌더링 끝난 뒤 시차를 두고 순차 조회
  const marketTargets = []; // { symbol, el } — 국내 종목만, KOSPI/KOSDAQ 뱃지 비동기로 채움

  groupOrder.forEach((groupName) => {
    const header = document.createElement("div");
    header.className = "watchlist-group-header";

    // 2026-08-04 피드백: 지난번엔 종목 개별 이름 수정으로 오해해서 구현했는데, 실제로는 이
    // 그룹명(예: "에너지") 자체를 수정하고 싶다는 요청이었음 — 연필 아이콘을 그룹명 "앞"에 배치.
    // "미분류"는 실제 그룹이 아니라 그룹 미지정 상태를 나타내는 placeholder라 수정 대상에서 제외.
    if (groupName !== "미분류") {
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "watchlist-group-edit";
      editBtn.textContent = "✎";
      editBtn.title = "그룹명 수정";
      editBtn.addEventListener("click", async () => {
        const typed = window.prompt("그룹 이름을 입력하세요", groupName);
        if (!typed || !typed.trim() || typed.trim() === groupName) return;
        const newName = typed.trim();
        const members = watchlistCache.filter((w) => (w.group_name || "미분류") === groupName);
        const results = await Promise.all(
          members.map((m) => updateWatchlistItemGroup(m.symbol, newName))
        );
        if (results.every(Boolean)) {
          members.forEach((m) => {
            m.group_name = newName;
          });
          renderWatchlistSidebar(watchlistCache);
        } else {
          showToast("그룹명 변경에 실패했습니다.");
        }
      });
      header.appendChild(editBtn);
    }

    const labelSpan = document.createElement("span");
    labelSpan.textContent = groupName;
    header.appendChild(labelSpan);
    listEl.appendChild(header);

    list
      .filter((item) => (item.group_name || "미분류") === groupName)
      .forEach((item) => {
        const rowEl = buildWatchlistItemRow(item, groupOrder);
        listEl.appendChild(rowEl);
        priceTargets.push({ symbol: item.symbol, el: rowEl.querySelector(".watchlist-sidebar-item-price") });
        const marketEl = rowEl.querySelector(".watchlist-sidebar-item-market");
        if (marketEl) marketTargets.push({ symbol: item.symbol, el: marketEl });
      });
  });

  priceTargets.forEach(({ symbol, el }, i) => {
    setTimeout(async () => {
      const quote = await fetchWatchlistItemQuote(symbol);
      if (!el) return;
      if (!quote) {
        el.textContent = "시세 조회 실패";
        return;
      }
      const isDomestic = isDomesticTicker(symbol);
      const priceTxt = isDomestic ? formatKRW(quote.last) : formatUSD(quote.last);
      const arrow = quote.changePct > 0 ? "▲" : quote.changePct < 0 ? "▼" : "-";
      el.textContent = `${priceTxt} ${arrow}${Math.abs(quote.changePct).toFixed(2)}%`;
      el.classList.add(quote.changePct > 0 ? "sentiment-pos" : quote.changePct < 0 ? "sentiment-neg" : "");
    }, i * 350);
  });

  // 시장구분(KOSPI/KOSDAQ)은 우리 서버 자체 조회(캐시된 상장목록)라 KIS 레이트리밋과 무관 —
  // 시차 없이 한 번에 조회. 못 찾은 경우(상장폐지 등)는 빈 뱃지를 그냥 숨김.
  marketTargets.forEach(({ symbol, el }) => {
    fetchDomesticStockMarket(symbol).then((market) => {
      if (!el) return;
      if (market) {
        el.textContent = market;
      } else {
        el.remove();
      }
    });
  });
}

async function refreshWatchlistPanel() {
  renderWatchlistSidebar(await fetchWatchlist());
}

// 좌측 상시 패널 열기/닫기 — 2026-08-01부터 배경을 어둡게 가리는 backdrop 없이 화살표 버튼 하나로만
// 여닫음(토스증권처럼 패널이 본문 위에 뜰 뿐 나머지 화면 조작은 막지 않음).
function openWatchlistSidebar() {
  const sidebar = $("watchlist-sidebar");
  const toggleBtn = $("watchlist-rail-toggle");
  const icon = $("watchlist-rail-toggle-icon");
  if (!sidebar) return;
  sidebar.classList.add("open");
  if (toggleBtn) toggleBtn.classList.add("rail-open");
  if (icon) icon.textContent = "«";
  // 헤더/결과카드가 .top-header/.card 자체는 body class로만 반응하므로(DOM 순서상
  // #watchlist-sidebar가 .top-header보다 뒤에 있어 인접형제 선택자로는 header를 못 건드림)
  document.body.classList.add("watchlist-rail-open");
}

function closeWatchlistSidebar() {
  const sidebar = $("watchlist-sidebar");
  const toggleBtn = $("watchlist-rail-toggle");
  const icon = $("watchlist-rail-toggle-icon");
  if (!sidebar) return;
  sidebar.classList.remove("open");
  if (toggleBtn) toggleBtn.classList.remove("rail-open");
  if (icon) icon.textContent = "»";
  document.body.classList.remove("watchlist-rail-open");
}

function toggleWatchlistSidebar() {
  const sidebar = $("watchlist-sidebar");
  if (!sidebar) return;
  if (sidebar.classList.contains("open")) closeWatchlistSidebar();
  else openWatchlistSidebar();
}

// 좁은 화면(모바일)에서는 패널이 본문을 거의 다 가리므로, 종목을 클릭해 분석을 실행한 뒤엔 자동으로
// 닫아줌 — 데스크톱 폭에서는 상시 패널 컨셉이라 그대로 열어둠(토스도 종목 클릭으로 패널이 안 닫힘).
function closeWatchlistSidebarOnMobile() {
  if (window.innerWidth < 768) closeWatchlistSidebar();
}

// 페이지 로드 시 뷰포트 폭에 따라 기본 열림/닫힘 상태 결정 + 화살표 버튼 이벤트 연결.
// 데스크톱(≥768px)에서는 토스처럼 기본 열림, 모바일은 패널이 화면을 거의 다 가려서 기본 닫힘으로 시작.
function initWatchlistRail() {
  const toggleBtn = $("watchlist-rail-toggle");
  if (toggleBtn) toggleBtn.addEventListener("click", toggleWatchlistSidebar);

  if (window.matchMedia("(min-width: 768px)").matches) {
    openWatchlistSidebar();
  }
}

// 현재 분석 중인 종목이 관심종목에 있는지에 따라 별표 아이콘 상태 갱신
function updateWatchlistStarState() {
  const starBtn = $("watchlist-toggle-btn");
  if (!starBtn) return;

  const symbol = lastAnalysis?.data?.symbol;
  if (!symbol) {
    starBtn.classList.remove("active");
    starBtn.textContent = "☆";
    return;
  }

  const inWatchlist = watchlistCache.some((w) => w.symbol === symbol);
  starBtn.classList.toggle("active", inWatchlist);
  starBtn.textContent = inWatchlist ? "★" : "☆";
}

// 2026-08-03 알고리즘 리뷰: 온디맨드 분석(R:R+SCORE 기준, computeVerdict)과 관심종목 텔레그램
// 알림(골든/데드크로스+거래량급증+연속매매 기준, signalDetector.js)이 서로 완전히 다른 로직이라
// 같은 종목에 대해 두 시스템이 말없이 어긋날 수 있었음 — 관심종목이면 텔레그램 판정도 같이
// 보여줘서 사용자가 직접 대조할 수 있게 함(하나로 강제 통합하는 대신 교차 확인 방식 채택 —
// 두 시스템의 판단 근거 자체가 달라서 억지로 합치면 각자의 신호 의미가 흐려짐).
async function renderWatchlistCrossCheck(symbol) {
  const el = $("watchlist-cross-check");
  if (!el) return;

  const inWatchlist = watchlistCache.some((w) => w.symbol === symbol);
  if (!inWatchlist) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/watchlist/check-now/${encodeURIComponent(symbol)}`);
    if (!res.ok) throw new Error("check-now failed");
    const result = await res.json();

    // 그 사이 다른 종목을 검색했을 수 있음 — 지금 화면과 다른 종목이면 무시
    if (!lastAnalysis || lastAnalysis.data.symbol !== symbol) return;

    if (!result || result.signal === "NONE") {
      el.classList.add("hidden");
      el.innerHTML = "";
      return;
    }

    const label = result.signal === "BUY" ? "매수" : "매도";
    const tone = result.signal === "BUY" ? "pos" : "neg";
    const reasonsHtml = (result.reasons || [])
      .map((r) => `<li>${r}</li>`)
      .join("");
    el.innerHTML =
      `<div class="watchlist-cross-check-title">📡 관심종목 알림 시스템 판정: <span class="sentiment-${tone}">${label}</span> (신뢰도: ${result.confidence})</div>` +
      (reasonsHtml ? `<ul class="watchlist-cross-check-reasons">${reasonsHtml}</ul>` : "");
    el.classList.remove("hidden");
  } catch (e) {
    console.warn("[RAVEN] 관심종목 교차 확인 조회 실패:", e);
    el.classList.add("hidden");
    el.innerHTML = "";
  }
}

async function toggleWatchlistForCurrentTicker() {
  const symbol = lastAnalysis?.data?.symbol;
  if (!symbol) return;

  const domestic = isDomesticTicker(symbol);
  const name = lastAnalysis?.stockName || null;
  const displayLabel = name || symbol;
  const alreadyIn = watchlistCache.some((w) => w.symbol === symbol);

  if (alreadyIn) {
    const ok = await removeFromWatchlist(symbol);
    if (ok) {
      showToast(`${displayLabel} 관심종목에서 삭제됨`);
      await refreshWatchlistPanel();
      updateWatchlistStarState();
      renderWatchlistCrossCheck(symbol);
    } else {
      showToast("관심종목 삭제에 실패했습니다.");
    }
  } else {
    const ok = await addToWatchlist(symbol, domestic, name);
    if (ok) {
      showToast(`${displayLabel} 관심종목에 추가됨`);
      await refreshWatchlistPanel();
      updateWatchlistStarState();
      renderWatchlistCrossCheck(symbol);
    } else {
      showToast("관심종목 추가에 실패했습니다.");
    }
  }
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

  // 🔹 새 실행 시: 이전 결과 카드 잠깐 숨기기 (이전 실패 안내가 떠 있었다면 그것도 같이 정리)
  hideResultCard();
  hideSearchErrorState();

  // 새 종목 분석 시작 시 이전 티커의 AI 서술 분석 결과는 더 이상 유효하지 않으므로 숨김
  const prevAiResult = $("ai-analysis-result");
  if (prevAiResult) prevAiResult.classList.add("hidden");

  // 🔹 엔트리(검색) 화면을 벗어나는 시점부터 보라색 배경 유지 — 예전엔 분석 "성공" 시에만
  // 켜져서, 첫 검색이 실패하면 헤더/에러 안내 뒤가 기본 검은 배경으로 남아 이질감이 있었음
  document.body.classList.add("raven-result-bg");

  // 🔹 로딩 스피너 ON
  showLoading(true);

  try {
    const domestic = isDomesticTicker(symbol);
    // 벤치마크(RS 비교용)도 여기서 같이 병렬 조회 — RS가 이제 RAVEN SCORE 계산에 직접 들어가서
    // analyzeData()가 실행되기 전에 준비돼 있어야 함 (예전엔 렌더링 끝난 뒤 텍스트만 나중에 덧붙였음)
    // 2026-08-03 피드백 검토: 국내는 KIS가 1분봉만 지원하고 그마저도 1회 최대 30건(=30분치)이라
    // 60분봉으로 리샘플링해도 1개 봉이 안 나올 만큼 데이터가 얕음 — 30분치 노이즈로 "장중 흐름이
    // 엇갈립니다" 같은 판단을 내리는 게 오히려 신뢰도를 떨어뜨린다고 판단해서 국내는 이 보조지표
    // 자체를 아예 호출하지 않음(해외는 서버가 60분봉으로 전환됨 — kisMarket.js 참고).
    const [data, fxRate, stockName, benchmarkData, intradayCloses, weeklyCloses] = await Promise.all([
      fetchStockData(symbol),
      fetchFxRate(),
      domestic ? fetchDomesticStockName(symbol) : fetchOverseasStockName(symbol),
      fetchBenchmarkData(domestic),
      domestic ? Promise.resolve(null) : fetchIntradayCandles(symbol),
      // 주봉(중기 추세) — 국내 전용, 위 fetchWeeklyCandles 주석 참고
      domestic ? fetchWeeklyCandles(symbol) : Promise.resolve(null)
    ]);

    const analysis = analyzeData(data, benchmarkData, intradayCloses, weeklyCloses);
    updateUI(data, analysis, fxRate, stockName);
    updateWatchlistStarState();
    // 관심종목 텔레그램 신호 교차 확인 — 메인 분석을 늦추지 않도록 비동기(수급/실적 탭과 같은 패턴)
    renderWatchlistCrossCheck(symbol);

    // 차트 위젯 렌더
    renderTradingViewChart(symbol);

    // 🔹 모든 세팅이 끝난 뒤 결과 카드 페이드인
    showResultCard();

    // 전일 수급 해석은 국내 종목만 지원 — 메인 분석을 늦추지 않도록 비동기로 별도 로드
    const supplyKisBox = $("supply-kis-box");
    if (domestic) {
      if (supplyKisBox) supplyKisBox.classList.add("hidden");
      fetchSupplyDemandComment(symbol).then((sdData) => {
        renderSupplyDemandBox(sdData);
        if (lastAnalysis) lastAnalysis.supplyDemand = sdData;
        applyInvestorStreakToScore(sdData, symbol);
      });
    } else if (supplyKisBox) {
      supplyKisBox.classList.add("hidden");
    }

    // 실적(분기 매출/영업이익) 탭도 같은 패턴 — 국내는 KIS, 해외는 Yahoo Finance(Phase 5 5단계), 비동기 로드
    // (resetEarningsPanel()은 updateUI() 안에서 이미 호출됨)
    fetchIncomeStatementData(symbol, domestic).then((quarters) => {
      if (!lastAnalysis || lastAnalysis.data.symbol !== symbol) return; // 그 사이 다른 종목 검색 시 무시
      renderEarningsChart(quarters, domestic ? "KRW" : "USD");
    });

    // 뉴스 탭 — 국내/해외 모두 지원(Phase 5, 4단계), 비동기 로드 (resetNewsPanel()도 updateUI() 안에서 호출됨).
    // lastAnalysis.news에도 캐싱해둬서 AI 분석 요청 시 최근 헤드라인을 실제 근거로 같이 보낼 수 있게 함.
    fetchNewsData(symbol).then((news) => {
      if (!lastAnalysis || lastAnalysis.data.symbol !== symbol) return;
      renderNewsList(news);
      lastAnalysis.news = news;
    });
  } catch (err) {
    console.error("[RAVEN] 분석 중 오류:", err);
    showToast("분석 중 오류가 발생했습니다. 티커/네트워크를 확인해 주세요.");
    // 에러 시에는 hideResultCard() 상태 유지(이미 위에서 호출됨) + 토스트가 사라진 뒤에도
    // 화면이 헤더만 남아 비어 보이지 않도록 다음 검색 전까지 남는 안내를 표시
    showSearchErrorState();
  } finally {
    // 🔹 로딩 스피너 OFF
    showLoading(false);
  }
}

// ===============================
// 🤖 AI 서술 분석 (Phase 4) — 버튼 클릭 시에만 호출 (API 호출당 비용 발생하므로 자동 실행 안 함)
// ===============================
// 2026-08-03 피드백: 서술 멘트가 가끔 화살표/불릿 기호로 시작하는 경우가 있다고 해서 확인함 —
// 코드 안에서 "▶"를 붙이는 곳은 setIndicatorBox() 한 곳뿐이고 지표박스 전용이라 서술 문단과는
// 무관함(늘 붙는 거라 "가끔"과도 안 맞음). 가장 유력한 원인은 AI 서술 분석(Claude 응답)이
// 시스템 프롬프트의 "불릿 금지" 지시에도 가끔 스스로 목록처럼 포맷팅해서 답할 가능성 —
// 프롬프트를 더 명시적으로 바꾸는 것과 별개로, 화면에 실제로 보이면 안 되니 방어적으로 문단
// 맨 앞의 불릿 기호를 클라이언트에서도 한 번 더 제거함.
function sanitizeAiNarrative(text) {
  if (!text) return text;
  return text.replace(/^[ \t]*[▶▸►•‣∙\-*][ \t]+/gm, "");
}

async function requestAiAnalysis() {
  if (!lastAnalysis) {
    showToast("먼저 티커를 검색해서 분석을 실행해 주세요.");
    return;
  }

  const btn = $("ai-analyze-btn");
  const resultBox = $("ai-analysis-result");
  const txtEl = $("ai-analysis-txt");

  if (btn) {
    btn.disabled = true;
    btn.textContent = "🤖 분석 중...";
  }

  try {
    const { data, analysis, patterns, stockName, supplyDemand, flowInfo, news } = lastAnalysis;
    const verdict = computeVerdict(analysis);
    const domestic = isDomesticTicker(data.symbol);

    // 시장 전반 배경 — 개별 종목 지표만 반복 서술하지 말고 "오늘 시장 전체가 어땠는지" 대비해서
    // 해석하라는 요청(2026-08-01)에 따라, 이미 헤더에 렌더링 중인 지수 스냅샷을 그대로 재사용해서 전달.
    // 국내 종목은 코스피/코스닥, 해외는 나스닥/S&P500/필라델피아반도체/다우존스를 기준으로 삼고,
    // VIX(위험선호도)는 국내/해외 공통으로 항상 포함.
    const market = domestic
      ? { kospi: marketSnapshot.kospi, kosdaq: marketSnapshot.kosdaq, vix: marketSnapshot.vix }
      : {
          nasdaq: marketSnapshot.nasdaq,
          sp500: marketSnapshot.sp500,
          sox: marketSnapshot.sox,
          dow: marketSnapshot.dow,
          vix: marketSnapshot.vix
        };

    const payload = {
      ticker: data.symbol,
      displayName: stockName || data.symbol,
      isDomestic: domestic,
      price: analysis.price,
      currency: domestic ? "KRW" : "USD",
      score: analysis.score,
      rank: analysis.rank,
      verdict: {
        tier: verdict.tier,
        rrRaw: verdict.rrRaw,
        upPctRaw: verdict.upPctRaw,
        downPctRaw: verdict.downPctRaw
      },
      indicators: {
        rsi: analysis.rsi,
        rsiCross: analysis.rsiCross,
        macd: analysis.macd,
        macdSignal: analysis.macdSignal,
        macdHistogram: analysis.macdHistogram,
        macdCrossover: analysis.macdCrossover,
        maCrossover: analysis.maCrossover,
        weeklyTrend: analysis.weeklyTrend,
        ma5Breakout: analysis.ma5Breakout,
        // ⚠️ 실제로 계산되고 화면(모멘텀/추세 탭)엔 이미 반영되던 값들인데 AI 프롬프트엔
        // 안 보내고 있었던 것들 — 추세 강도 변화(adxTrend)와 MACD 다이버전스는 사람이 볼 때도
        // 중요한 판단 근거라 AI 서술에도 반영되도록 추가함.
        adxTrend: analysis.adxTrend,
        macdDivergence: analysis.macdDivergence,
        adx: analysis.adx,
        plusDI: analysis.plusDI,
        minusDI: analysis.minusDI,
        atr: analysis.atr,
        atrPct: analysis.atrPct,
        volatility: analysis.volatility,
        dailyChangePct: analysis.dailyChangePct,
        volumeRatio: analysis.volumeRatio,
        rsInfo: analysis.rsInfo
      },
      levels: {
        support1: analysis.support1,
        support2: analysis.support2,
        resistance1: analysis.resistance1,
        resistance2: analysis.resistance2,
        target1: analysis.target1,
        target2: analysis.target2,
        stop: analysis.stop
      },
      patterns: (patterns || []).map((p) => ({
        name: p.name,
        strength: p.strength,
        comment: p.comment
      })),
      // 당일 거래량·캔들 기준 수급(수급 탭 상단 카드)과 OBV 다이버전스 — 예전엔 AI에 안 보내고
      // 있어서, 화면엔 "수급 공백"/"OBV 다이버전스" 같은 근거가 떠 있는데 AI 서술만 그걸 모르고
      // 쓰는 불일치가 있었음.
      flow: flowInfo
        ? {
            flowLabel: flowInfo.flowLabel,
            flowNote: flowInfo.flowNote,
            obvInfo: flowInfo.obvInfo
          }
        : null,
      // supplyDemandText(한 줄 결론)만 보내던 걸, 실제 5종 개별 수치가 담긴 lines도 같이 보내서
      // AI가 "외국인 N일 연속 순매도" 같은 구체적 근거를 그대로 인용할 수 있게 함.
      supplyDemandText: supplyDemand && supplyDemand.outlook ? supplyDemand.outlook : null,
      supplyDemandLines: supplyDemand && Array.isArray(supplyDemand.lines) ? supplyDemand.lines : null,
      market,
      // 뉴스 탭에서 이미 조회해둔 실제 헤드라인(최근 5개) — AI가 "호재/악재"를 지어내지 않고
      // 실제 헤드라인을 근거로 인용할 수 있게 함. 아직 뉴스가 안 온 상태(비동기 로딩 중)면 빈 배열.
      news: Array.isArray(news) ? news.slice(0, 5).map((n) => n.title).filter(Boolean) : []
    };

    const res = await fetch(`${API_BASE}/api/ai/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error(`AI 분석 요청 실패 (status ${res.status})`);
    const json = await res.json();

    if (txtEl) txtEl.textContent = sanitizeAiNarrative(json.narrative) || "분석 결과를 받아오지 못했습니다.";
    if (resultBox) resultBox.classList.remove("hidden");
  } catch (err) {
    console.error("[RAVEN] AI 분석 오류:", err);
    showToast("AI 분석 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "🤖 AI 분석 요청";
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  // 🔒 PIN + 인트로 + 엔트리 화면 초기화
  initLockAndIntro();

  // 국내 종목명 자동완성 (엔트리 화면 + 메인 검색창)
  attachTickerAutocomplete($("entry-ticker"));
  attachTickerAutocomplete($("ticker-input"));

  // ★ 관심종목 — 좌측 상시 패널 초기화(뷰포트 폭에 따라 기본 열림/닫힘) + 목록 로드 + 별표 토글 버튼
  initWatchlistRail();
  refreshWatchlistPanel();
  const watchlistStarBtn = $("watchlist-toggle-btn");
  if (watchlistStarBtn) {
    watchlistStarBtn.addEventListener("click", toggleWatchlistForCurrentTicker);
  }

  // 🤖 AI 서술 분석 요청 버튼
  const aiAnalyzeBtn = $("ai-analyze-btn");
  if (aiAnalyzeBtn) {
    aiAnalyzeBtn.addEventListener("click", requestAiAnalysis);
  }

  // 📑 상세 탭 (추세·모멘텀 / 수급 / 패턴·신호 / 실적)
  initResultTabs();

  // RAVEN SCORE 산정 방식 안내 팝업
  initScoreFormulaModal();

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

  fetchIndexData().catch((e) =>
    console.warn("[RAVEN] index fetch on load failed:", e)
  );
  fetchKospiNightFuturesData().catch((e) =>
    console.warn("[RAVEN] kospi night futures fetch on load failed:", e)
  );
});
