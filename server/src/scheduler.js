const cron = require("node-cron");
const { supabase } = require("./lib/supabaseClient");
const { collectSupplyDemandForSymbol } = require("./lib/supplyDemandCollector");
const { checkSignal } = require("./lib/signalDetector");
const { sendTelegramMessage } = require("./lib/telegram");

async function getWatchlist() {
  const { data, error } = await supabase.from("watchlist").select("symbol, name, domestic");
  if (error) throw error;
  return data || [];
}

// 종목명이 있으면 "종목명 (코드)", 없으면(해외 종목 등 한글명 미조회) 코드만 표시
function formatSymbolLabel(symbol, name) {
  return name ? `${name} (${symbol})` : symbol;
}

// 신뢰도(confidence)는 몇 개의 독립 근거(골든/데드크로스, 거래량급증, 연속매매 5일+, 수급조합/3일+
// 참고근거)가 같은 방향을 가리키는지로 매겨짐(signalDetector.js의 rateConfidence 참고) — 근거가
// 하나뿐인 신호와 여러 개가 겹친 신호를 한눈에 구분할 수 있게 메시지에 노출.
function formatConfidenceLabel(confidence) {
  if (confidence === "매우 높음") return "🔥 신뢰도 매우 높음";
  if (confidence === "높음") return "⭐ 신뢰도 높음";
  return "신뢰도 보통";
}

function formatAlertPrice(price, domestic) {
  return domestic
    ? `₩ ${Math.round(price).toLocaleString("ko-KR")}`
    : `$${price.toFixed(2)}`;
}

// 현재가 대비 +/-% — 목표가/손절가 옆에 괄호로 병기(요청 반영)
function formatPctVsPrice(level, price) {
  const pct = ((level - price) / price) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

// 2026-08-10 피드백: "[RAVEN 알림]" 텍스트 대신 빨강/초록 아이콘+매수/매도 신호를 맨 앞에,
// 신뢰도·현재가 앞에도 근거 목록과 같은 "•" 기호, 목표가/손절가도 추가(현재가 대비 %도 병기).
function formatAlertMessage(result, domestic, name) {
  const icon = result.signal === "BUY" ? "🟢" : "🔴";
  const signalWord = result.signal === "BUY" ? "매수 신호" : "매도 신호";
  const priceTxt = formatAlertPrice(result.price, domestic);

  const lines = [
    `<b>${icon} ${signalWord} — ${formatSymbolLabel(result.symbol, name)}</b>`,
    `• ${formatConfidenceLabel(result.confidence)}`,
    `• 현재가: ${priceTxt}`,
  ];
  if (Number.isFinite(result.target1)) {
    lines.push(
      `• 목표가: ${formatAlertPrice(result.target1, domestic)} (${formatPctVsPrice(result.target1, result.price)})`
    );
  }
  if (Number.isFinite(result.stop)) {
    lines.push(
      `• 손절가: ${formatAlertPrice(result.stop, domestic)} (${formatPctVsPrice(result.stop, result.price)})`
    );
  }
  lines.push(...result.reasons.map((r) => `• ${r}`));

  return lines.join("\n");
}

// 관심종목 전체를 돌면서 골든/데드크로스·거래량 급증 신호를 체크하고, 신호가 있으면 텔레그램 전송
async function checkWatchlistAndAlert() {
  const watchlist = await getWatchlist();
  const results = [];

  for (const { symbol, name, domestic } of watchlist) {
    try {
      const result = await checkSignal(symbol);
      results.push(result);
      if (result.signal !== "NONE") {
        await sendTelegramMessage(formatAlertMessage(result, domestic, name));
      }
    } catch (e) {
      console.error(`[RAVEN] 신호 체크 실패 (${symbol}):`, e.message);
      results.push({ symbol, signal: "ERROR", error: e.message });
    }
  }

  return results;
}

// 매일 06:00 KST에 도는 전체 작업(수급데이터 수집 + 관심종목 신호체크·알림) — internal node-cron과
// 외부 트리거(routes/watchlist.js의 POST /api/watchlist/run-daily) 양쪽에서 재사용하려고 별도
// 함수로 분리함. 실제 외부 호출은 .github/workflows/daily-scheduler.yml(GitHub Actions, 매일
// 06:00 KST)이 담당 — 2026-08-10에 이 workflow 자체가 누락돼 있던 걸 발견하고 새로 추가함.
// ⚠️ 2026-08-04 발견: Render 무료 플랜은 15분간 요청이 없으면 프로세스 자체가 잠들고, 그 상태에서는
// node-cron도 같이 멈춰서 06:00에 아무도 안 깨워주면 이 코드가 통째로 실행이 안 됨(에러조차 안 남음,
// 그냥 조용히 스킵됨) — 사용자가 "테스트 알림 이후 며칠째 알림이 안 온다"고 보고해서 발견함. 외부에서
// (예: GitHub Actions cron) 이 라우트를 직접 호출하면 그 요청 자체가 프로세스를 깨우면서 작업도
// 실행되므로 근본적으로 해결됨 — internal cron은 그대로 두되(서버가 우연히 깨어있는 시간대엔 정상
// 작동하는 이중 안전장치), 안정적인 트리거는 외부 스케줄러에 맡기는 쪽으로 전환.
async function runDailyJob() {
  console.log(`[RAVEN] 일일 작업 시작 ${new Date().toISOString()}`);

  const watchlist = await getWatchlist().catch((e) => {
    console.error("[RAVEN] 관심종목 조회 실패:", e.message);
    return [];
  });

  const domesticSymbols = watchlist.filter((w) => w.domestic).map((w) => w.symbol);
  const collectResults = [];
  for (const symbol of domesticSymbols) {
    const result = await collectSupplyDemandForSymbol(symbol);
    console.log(`[RAVEN] 수급데이터 수집 결과 ${JSON.stringify(result)}`);
    collectResults.push(result);
  }

  const alertResults = await checkWatchlistAndAlert().catch((e) => {
    console.error("[RAVEN] 관심종목 신호 체크 실패:", e.message);
    return [];
  });
  console.log(`[RAVEN] 신호 체크 결과 ${JSON.stringify(alertResults)}`);

  return { collectResults, alertResults };
}

function startScheduler() {
  // 매일 새벽 6시(KST) — 국내 수급데이터(전일자 기준)와 관심종목 신호(전일 종가 기준 캔들)
  // 둘 다 이 시각이면 국내/해외 시장 모두 전일 거래가 확정돼 있어서 같은 슬롯에 묶음.
  // Render 무료 플랜에서 서버가 잠들어 있으면 이 cron 자체가 안 도는 한계가 있음(위 runDailyJob
  // 주석 참고) — 외부 트리거가 주 실행 경로이고, 이건 서버가 우연히 깨어있을 때를 위한 보조 장치.
  cron.schedule("0 6 * * *", runDailyJob, { timezone: "Asia/Seoul" });

  console.log("[RAVEN] 스케줄러 등록 완료 (매일 06:00 KST — 수급데이터 + 관심종목 신호)");
}

module.exports = { startScheduler, checkWatchlistAndAlert, getWatchlist, runDailyJob };
