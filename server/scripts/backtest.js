// RAVEN 백테스팅 엔진 — 2026-08-12
//
// 목적: RAVEN SCORE/SIGNAL은 지금까지 전부 "근거는 있지만 실증은 안 된" 규칙기반 로직이었음
// (예: ADX 20 이상만 MA크로스 신호로 인정, MACD 크로스오버 4번째 카테고리 추가 등 — 전부 코드
// 주석에 이유는 적혀있지만 과거 데이터로 승률을 재본 적은 없었음). 이 스크립트는 signalDetector.js의
// 실제 프로덕션 판정 함수(detectMACross/calcADX/detectMacdCross/detectVolumeSurge/calcTargetStop)를
// "그날까지의 데이터만" 잘라서 과거 매일 재현하고(lookahead 없음), 신호가 뜬 날 이후 실제 가격이
// target1/stop 중 뭘 먼저 쳤는지로 승률을 측정함.
//
// 실행: cd server && node scripts/backtest.js
//
// ⚠️ 알려진 한계(결과 해석 시 감안할 것):
// - KIS 일봉 조회가 배치당 100건, 백테스트용으로 최대 8배치(≈800거래일≈3년치)까지 늘렸지만
//   실제 상장 이력이 짧은 종목/최근 신규상장 종목은 이보다 훨씬 적은 표본만 나올 수 있음
// - "표본 수(N)가 작으면 승률 숫자 자체를 신뢰하지 말 것" — 특히 종목별로 쪼개면 N이 10~20개
//   수준일 수 있어 통계적으로 거의 무의미함. 카테고리 합산(전종목) 수치를 우선 참고할 것
// - walk-forward 최적화(예: 최적 ADX 임계값을 이 백테스트 결과로 역산해서 다시 끼워맞추는 것)는
//   안 함 — 지금 이 엔진의 역할은 "기존 규칙이 대략 방향은 맞는지" 확인이지, 새 임계값을 여기서
//   확정하는 게 아님(과적합 위험, project_raven_algorithm_update 메모리 참고)
// - 코스피/코스닥 전체가 아니라 사용자의 실제 관심종목만 대상 — 생존편향(관심종목은 이미 어느 정도
//   관심 가질 만한 이유가 있어 골랐을 것)이 있을 수 있음을 감안할 것

const { getWatchlist } = require("../src/scheduler");
const { fetchCandles: fetchKisCandles, isDomesticSymbol } = require("../src/lib/kisMarket");
const {
  calcADX,
  detectMACross,
  detectMacdCross,
  detectVolumeSurge,
  calcTargetStop,
  ADX_TREND_THRESHOLD,
} = require("../src/lib/signalDetector");

const EXTENDED_HISTORY_DAYS = 750; // ≈3년치 (KIS 8배치 상한)
const START_IDX = 60; // MA60 워밍업(60개) — detectMACross가 이전 값까지 필요해서 61번째 봉부터 유효
const LOOKAHEAD_DAYS = 20; // 스윙(며칠~몇 주) 전제에 맞춘 목표가/손절가 도달 확인 기간
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchExtendedHistory(symbol) {
  const rows = await fetchKisCandles(symbol, EXTENDED_HISTORY_DAYS);
  const chronological = [...rows].reverse(); // KIS는 최신순 → 과거→현재 순으로 뒤집음

  const dates = [];
  const opens = [];
  const highs = [];
  const lows = [];
  const closes = [];
  const volumes = [];
  for (const r of chronological) {
    const o = Number(r.openPrice);
    const h = Number(r.highPrice);
    const l = Number(r.lowPrice);
    const c = Number(r.closePrice);
    const v = Number(r.volume);
    if ([o, h, l, c, v].some((n) => Number.isNaN(n))) continue;
    dates.push(r.date);
    opens.push(o);
    highs.push(h);
    lows.push(l);
    closes.push(c);
    volumes.push(v);
  }
  return { dates, opens, highs, lows, closes, volumes };
}

// ⚠️ 2026-08-12 실측 중 발견한 버그: calcTargetStop()은 처음부터 "롱 진입" 전용 공식이라
// target1은 항상 진입가보다 위, stop은 항상 아래로 나옴(방향 무관하게 고정) — RAVEN 자체가
// 공매도를 지원 안 하는 롱 전용 툴이라 원래도 그렇게 설계된 것(SELL 신호는 "숏을 새로 열어라"가
// 아니라 "보유 중이면 나가라"는 의미). 첫 시도에서 SELL을 "target1(아래)/stop(위)"로 뒤집어
// 해석했다가 — 실제로는 target1이 여전히 위, stop이 여전히 아래라 두 기준이 진입가를 사실상
// 거꾸로 감싸는 꼴이 되어 거의 매번 "당일 즉시 양쪽 다 히트"로 잘못 판정되고, 그게 전부 SELL
// "승리"로 집계되어 승률 95~100%라는 명백히 비현실적인 결과가 나온 걸 실측으로 확인함
// (직접 계산: 삼성전자 한 시점에서 target1=+27%/stop=-18.8%로 나오는데, 이건 SELL 관점에선
// "위/아래 둘 다 진입가 근처가 아니라 애초에 매매 기준으로 쓸 수 없는 숫자"였음).
// → BUY만 target1/stop 히트 여부로 판정(calcTargetStop의 원래 의도와 일치하는 유일한 경우),
// SELL은 target/stop을 아예 안 쓰고 "lookahead 기간 뒤 실제로 가격이 내렸는지"(방향 정확도)로
// 판정 — "매도/회피 신호가 실제로 하락을 예측했는가"라는, 롱 전용 툴에 맞는 질문으로 바꿈.
function evaluateOutcome(direction, entryPrice, target1, stop, highs, lows, closes, fromIdx) {
  const endIdx = Math.min(fromIdx + LOOKAHEAD_DAYS - 1, closes.length - 1);
  const rawReturnPct = ((closes[endIdx] - entryPrice) / entryPrice) * 100;
  // "맞은 방향이면 +"로 통일 — BUY는 오르면 +, SELL(하락 예측)은 내리면 +
  const directionalReturnPct = direction === "SELL" ? -rawReturnPct : rawReturnPct;

  if (direction === "BUY") {
    for (let j = fromIdx; j <= endIdx; j++) {
      const hitTarget = highs[j] >= target1;
      const hitStop = lows[j] <= stop;
      if (hitTarget && hitStop) return { outcome: "LOSS", returnPct: directionalReturnPct }; // 같은 날 양쪽 다 걸치면 보수적으로 손절 우선
      if (hitTarget) return { outcome: "WIN", returnPct: directionalReturnPct };
      if (hitStop) return { outcome: "LOSS", returnPct: directionalReturnPct };
    }
    return { outcome: "TIMEOUT", returnPct: directionalReturnPct };
  }

  return { outcome: directionalReturnPct > 0 ? "WIN" : "LOSS", returnPct: directionalReturnPct };
}

function newStat() {
  return { n: 0, win: 0, loss: 0, timeout: 0, returnSum: 0 };
}

function recordOutcome(stat, result) {
  stat.n++;
  if (result.outcome === "WIN") stat.win++;
  else if (result.outcome === "LOSS") stat.loss++;
  else stat.timeout++;
  stat.returnSum += result.returnPct;
}

function formatStat(label, stat) {
  const decided = stat.win + stat.loss;
  const winRate = decided > 0 ? ((stat.win / decided) * 100).toFixed(1) : "N/A";
  const avgReturn = stat.n > 0 ? (stat.returnSum / stat.n).toFixed(2) : "N/A";
  return `${label.padEnd(28)} N=${String(stat.n).padEnd(4)} 승=${String(stat.win).padEnd(3)} 패=${String(
    stat.loss
  ).padEnd(3)} 미결=${String(stat.timeout).padEnd(3)} 승률(결판난 것 중)=${winRate}%  평균 방향적중 수익률=${avgReturn}%`;
}

// 2026-08-12 추가: 신호별 승률/수익률만 보고 "좋다/나쁘다"를 판단하면 함정이 있음 — 예를 들어
// 백테스트 구간(최근 ~3년) 자체가 전반적 상승장이었다면, BUY는 아무 신호 없이 "그냥 아무 날에나
// 사서 20일 들고 있기"만 해도 승률이 높게 나오고, SELL은 반대로 "실제 하락 예측 능력"과 무관하게
// 그 상승 드리프트 때문에 불리해 보일 수 있음. 그래서 신호 유무와 무관하게 "이 구간 아무 날에나
// 진입해서 20일 뒤 어떻게 됐는지"를 기준선(baseline)으로 같이 재서, 신호가 기준선 대비 진짜
// 초과 성과(알파)가 있는지로 해석해야 함 — 순수 승률/수익률 숫자만 보고 SELL을 폐기하거나 BUY를
// 과신하면 안 됨.
function newBaseline() {
  return { n: 0, upDays: 0, returnSum: 0 };
}

// 2026-08-12 추가(사용자 피드백): SELL의 방향 정확도가 기준선과 비슷하다는 결과에 "손절이 아니라
// 익절 구간에서 나온 SELL이면 정확도가 낮아도 괜찮지 않냐"는 정확한 지적을 받음 — RAVEN의 SELL은
// 숏 진입 예측이 아니라 기존 롱 포지션의 청산 신호라, "그 뒤 가격이 내렸는가"만으로 품질을 매기면
// 안 되고 "그 시점에 이미 수익 구간이었는가(그럼 손절 여부와 무관하게 저위험)"를 나눠서 봐야 함.
// 완전한 포지션 추적 시뮬레이터는 과한 스코프라, 근사치로 "그 종목에서 가장 최근에 뜬 BUY류 신호의
// 가격"을 진입가로 간주해 SELL 시점 현재가와 비교 — 실제 포트폴리오 상태 추적이 아니라 근사임을
// 감안할 것(예: 그 BUY 신호 자체를 실제로 매매하지 않았을 수도 있음).
function newZoneStat() {
  return { PROFIT: newStat(), LOSS: newStat(), NO_REF: newStat() };
}

async function backtestSymbol(symbol, stats) {
  const { highs, lows, closes, opens, volumes } = await fetchExtendedHistory(symbol);
  const n = closes.length;
  if (n < START_IDX + LOOKAHEAD_DAYS + 1) {
    console.log(`  ⚠️ ${symbol}: 이력 부족(${n}봉) — 스킵`);
    return;
  }

  const lastEvalIdx = n - 1 - LOOKAHEAD_DAYS; // 이 이후로는 미래 데이터가 부족해 평가 불가
  let signalCount = 0;
  let lastBuyEntryPrice = null; // 이 종목에서 가장 최근에 뜬 BUY류 신호의 진입가 근사치(위 newZoneStat 주석 참고)

  const classifyZone = (currentPrice) => {
    if (lastBuyEntryPrice == null) return "NO_REF";
    return currentPrice > lastBuyEntryPrice ? "PROFIT" : "LOSS";
  };

  for (let i = START_IDX; i <= lastEvalIdx; i++) {
    const h = highs.slice(0, i + 1);
    const l = lows.slice(0, i + 1);
    const c = closes.slice(0, i + 1);
    const o = opens.slice(0, i + 1);
    const v = volumes.slice(0, i + 1);
    const entryPrice = c[c.length - 1];
    const fromIdx = i + 1;

    // 기준선: 신호 발생 여부와 무관하게 모든 날에 대해 20일 뒤 수익률을 그대로 기록
    const baseEndIdx = Math.min(fromIdx + LOOKAHEAD_DAYS - 1, closes.length - 1);
    const baseReturnPct = ((closes[baseEndIdx] - entryPrice) / entryPrice) * 100;
    stats.baseline.n++;
    stats.baseline.returnSum += baseReturnPct;
    if (baseReturnPct > 0) stats.baseline.upDays++;

    // 오늘 BUY류 신호가 하나라도 뜨면 lastBuyEntryPrice를 갱신하는데, 오늘 SELL의 구간 분류는
    // "오늘 갱신되기 전" 기준(그동안 들고 있었다고 가정한 진입가)으로 해야 하므로 zone 분류를
    // 먼저 다 마치고 맨 마지막에 한 번만 갱신함.
    let firedBuyToday = false;

    // ── MA20/60 골든/데드크로스 (ADX 게이트 적용 전/후 둘 다 측정 — 게이트 자체가 실제로
    //    도움되는지 검증하는 게 이 백테스트의 핵심 동기 중 하나)
    const maCross = detectMACross(c);
    if (maCross !== "NONE") {
      const adx = calcADX(h, l, c, 14);
      const direction = maCross === "GOLDEN" ? "BUY" : "SELL";
      const { target1, stop } = calcTargetStop(h, l, c);
      const result = evaluateOutcome(direction, entryPrice, target1, stop, highs, lows, closes, fromIdx);

      recordOutcome(stats.maCrossRaw[direction], result);
      const adxOk = typeof adx === "number" && adx >= ADX_TREND_THRESHOLD;
      if (adxOk) recordOutcome(stats.maCrossAdxGated[direction], result);
      if (direction === "SELL") recordOutcome(stats.sellZone.maCross[classifyZone(entryPrice)], result);
      else firedBuyToday = true;
      signalCount++;
    }

    // ── MACD(12,26,9) 크로스오버
    const macdCross = detectMacdCross(c);
    if (macdCross !== "NONE") {
      const direction = macdCross === "GOLDEN" ? "BUY" : "SELL";
      const { target1, stop } = calcTargetStop(h, l, c);
      const result = evaluateOutcome(direction, entryPrice, target1, stop, highs, lows, closes, fromIdx);
      recordOutcome(stats.macdCross[direction], result);
      if (direction === "SELL") recordOutcome(stats.sellZone.macdCross[classifyZone(entryPrice)], result);
      else firedBuyToday = true;
      signalCount++;
    }

    // ── 거래량 급증 + 방향
    const volSurge = detectVolumeSurge(o, c, v);
    if (volSurge !== "NONE") {
      const { target1, stop } = calcTargetStop(h, l, c);
      const result = evaluateOutcome(volSurge, entryPrice, target1, stop, highs, lows, closes, fromIdx);
      recordOutcome(stats.volumeSurge[volSurge], result);
      if (volSurge === "SELL") recordOutcome(stats.sellZone.volumeSurge[classifyZone(entryPrice)], result);
      else firedBuyToday = true;
      signalCount++;
    }

    if (firedBuyToday) lastBuyEntryPrice = entryPrice;
  }

  console.log(`  ✓ ${symbol}: ${n}봉 확보, 신호 ${signalCount}건 평가`);
}

async function main() {
  console.log("[RAVEN 백테스트] 시작 —", new Date().toISOString());
  console.log(`설정: 최대 ${EXTENDED_HISTORY_DAYS}거래일 이력, lookahead ${LOOKAHEAD_DAYS}거래일\n`);

  const watchlist = await getWatchlist();
  if (!watchlist.length) {
    console.log("관심종목이 비어있어 백테스트할 종목이 없습니다.");
    return;
  }

  const stats = {
    maCrossRaw: { BUY: newStat(), SELL: newStat() },
    maCrossAdxGated: { BUY: newStat(), SELL: newStat() },
    macdCross: { BUY: newStat(), SELL: newStat() },
    volumeSurge: { BUY: newStat(), SELL: newStat() },
    baseline: newBaseline(),
    sellZone: {
      maCross: newZoneStat(),
      macdCross: newZoneStat(),
      volumeSurge: newZoneStat(),
    },
  };

  console.log(`대상 종목 ${watchlist.length}개:\n`);
  for (const { symbol } of watchlist) {
    try {
      await backtestSymbol(symbol, stats);
    } catch (e) {
      console.log(`  ✗ ${symbol}: 실패 — ${e.message}`);
    }
    await sleep(600);
  }

  const baseUpRate = ((stats.baseline.upDays / stats.baseline.n) * 100).toFixed(1);
  const baseAvgReturn = (stats.baseline.returnSum / stats.baseline.n).toFixed(2);

  console.log("\n===== 기준선(신호 유무 무관, 아무 날에나 진입했을 때) =====\n");
  console.log(
    `이 구간 전체: N=${stats.baseline.n}  20일 뒤 상승 비율=${baseUpRate}%  평균 20일 수익률=${baseAvgReturn}%`
  );
  console.log(
    "→ BUY 신호는 이 상승비율/평균수익률보다 높아야, SELL 신호는 하락비율((100-상승비율)%)보다\n" +
      "  높은 적중률을 보여야 각각 '신호 자체의 알파'가 있다고 볼 수 있음(단순 시장 드리프트가 아니라)."
  );

  console.log("\n===== 결과 요약 =====\n");
  console.log("[MA20/60 크로스 — ADX 게이트 적용 전(원본)]");
  console.log(formatStat("골든크로스(BUY)", stats.maCrossRaw.BUY));
  console.log(formatStat("데드크로스(SELL)", stats.maCrossRaw.SELL));
  console.log("\n[MA20/60 크로스 — ADX≥" + ADX_TREND_THRESHOLD + " 게이트 적용 후(현재 알림엔진 실제 로직)]");
  console.log(formatStat("골든크로스(BUY)", stats.maCrossAdxGated.BUY));
  console.log(formatStat("데드크로스(SELL)", stats.maCrossAdxGated.SELL));
  console.log("\n[MACD 크로스오버]");
  console.log(formatStat("골든크로스(BUY)", stats.macdCross.BUY));
  console.log(formatStat("데드크로스(SELL)", stats.macdCross.SELL));
  console.log("\n[거래량 급증 + 방향]");
  console.log(formatStat("BUY", stats.volumeSurge.BUY));
  console.log(formatStat("SELL", stats.volumeSurge.SELL));

  console.log("\n(승률은 target1/stop 중 하나를 실제로 친 신호만 대상 — 미결은 별도 표기)");
  console.log(`(기준선: 상승비율 ${baseUpRate}%, 평균수익률 ${baseAvgReturn}% — 위 신호별 수치와 비교해서 해석할 것)`);

  console.log("\n===== SELL 신호 — 익절 구간 vs 손실 구간 분리 =====");
  console.log(
    "(사용자 피드백: 이미 수익 구간에서 뜬 SELL은 방향이 틀려도 저위험 — 손실/미실현 구간에서\n" +
      " 뜬 SELL의 정확도가 진짜 중요함. '진입가'는 그 종목의 가장 최근 BUY류 신호 가격으로 근사함)\n"
  );
  for (const [key, label] of [
    ["maCross", "MA20/60 데드크로스"],
    ["macdCross", "MACD 데드크로스"],
    ["volumeSurge", "거래량급증 SELL"],
  ]) {
    const z = stats.sellZone[key];
    console.log(`[${label}]`);
    console.log(formatStat("  익절 구간(이미 진입가 위)", z.PROFIT));
    console.log(formatStat("  손실/미실현 구간(진입가 이하)", z.LOSS));
    console.log(formatStat("  기준 없음(직전 BUY 신호 없음)", z.NO_REF));
    console.log("");
  }

  console.log("[RAVEN 백테스트] 종료 —", new Date().toISOString());
}

main().catch((e) => {
  console.error("[RAVEN 백테스트] 실패:", e);
  process.exit(1);
});
