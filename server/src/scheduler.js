const cron = require("node-cron");
const { supabase } = require("./lib/supabaseClient");
const { collectSupplyDemandForSymbol } = require("./lib/supplyDemandCollector");
const { checkSignal } = require("./lib/signalDetector");
const { sendTelegramMessage } = require("./lib/telegram");

async function getWatchlist() {
  const { data, error } = await supabase.from("watchlist").select("symbol, domestic");
  if (error) throw error;
  return data || [];
}

function formatAlertMessage(result, domestic) {
  const label = result.signal === "BUY" ? "🟢 매수 신호" : "🔴 매도 신호";
  const priceTxt = domestic
    ? `₩${Math.round(result.price).toLocaleString("ko-KR")}`
    : `$${result.price.toFixed(2)}`;
  return (
    `<b>[RAVEN 알림] ${result.symbol} — ${label}</b>\n` +
    `현재가: ${priceTxt}\n` +
    result.reasons.map((r) => `• ${r}`).join("\n")
  );
}

// 관심종목 전체를 돌면서 골든/데드크로스·거래량 급증 신호를 체크하고, 신호가 있으면 텔레그램 전송
async function checkWatchlistAndAlert() {
  const watchlist = await getWatchlist();
  const results = [];

  for (const { symbol, domestic } of watchlist) {
    try {
      const result = await checkSignal(symbol);
      results.push(result);
      if (result.signal !== "NONE") {
        await sendTelegramMessage(formatAlertMessage(result, domestic));
      }
    } catch (e) {
      console.error(`[RAVEN] 신호 체크 실패 (${symbol}):`, e.message);
      results.push({ symbol, signal: "ERROR", error: e.message });
    }
  }

  return results;
}

function startScheduler() {
  // 매일 새벽 6시(KST) — 국내 수급데이터(전일자 기준)와 관심종목 신호(전일 종가 기준 캔들)
  // 둘 다 이 시각이면 국내/해외 시장 모두 전일 거래가 확정돼 있어서 같은 슬롯에 묶음
  cron.schedule(
    "0 6 * * *",
    async () => {
      console.log(`[RAVEN] 스케줄러 시작 ${new Date().toISOString()}`);

      const watchlist = await getWatchlist().catch((e) => {
        console.error("[RAVEN] 관심종목 조회 실패:", e.message);
        return [];
      });

      const domesticSymbols = watchlist.filter((w) => w.domestic).map((w) => w.symbol);
      for (const symbol of domesticSymbols) {
        const result = await collectSupplyDemandForSymbol(symbol);
        console.log(`[RAVEN] 수급데이터 수집 결과 ${JSON.stringify(result)}`);
      }

      const alertResults = await checkWatchlistAndAlert().catch((e) => {
        console.error("[RAVEN] 관심종목 신호 체크 실패:", e.message);
        return [];
      });
      console.log(`[RAVEN] 신호 체크 결과 ${JSON.stringify(alertResults)}`);
    },
    { timezone: "Asia/Seoul" }
  );

  console.log("[RAVEN] 스케줄러 등록 완료 (매일 06:00 KST — 수급데이터 + 관심종목 신호)");
}

module.exports = { startScheduler, checkWatchlistAndAlert, getWatchlist };
