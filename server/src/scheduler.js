const cron = require("node-cron");
const { collectSupplyDemandForSymbol } = require("./lib/supplyDemandCollector");

// 관심종목 기능이 생기기 전까지 임시 고정 목록 (Phase 3에서 DB 기반으로 교체 예정)
const WATCHLIST = ["005930"];

function startScheduler() {
  // 매일 새벽 6시(KST) — KIS 수급데이터는 전일자 기준으로 새벽에 확정됨
  cron.schedule(
    "0 6 * * *",
    async () => {
      console.log(`[RAVEN] 수급데이터 자동 수집 시작 ${new Date().toISOString()}`);
      for (const symbol of WATCHLIST) {
        const result = await collectSupplyDemandForSymbol(symbol);
        console.log(`[RAVEN] 수집 결과 ${JSON.stringify(result)}`);
      }
    },
    { timezone: "Asia/Seoul" }
  );

  console.log("[RAVEN] 수급데이터 스케줄러 등록 완료 (매일 06:00 KST)");
}

module.exports = { startScheduler, WATCHLIST };
