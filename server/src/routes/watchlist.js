const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabaseClient");
const { checkSignal } = require("../lib/signalDetector");
const { checkWatchlistAndAlert } = require("../scheduler");

router.get("/", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("watchlist")
      .select("symbol, domestic, added_at")
      .order("added_at", { ascending: false });
    if (error) throw error;
    res.json({ result: data });
  } catch (e) {
    console.error("[RAVEN] /api/watchlist GET error:", e);
    res.status(502).json({ error: "watchlist fetch error" });
  }
});

router.post("/", async (req, res) => {
  const { symbol, domestic } = req.body || {};
  if (!symbol || typeof domestic !== "boolean") {
    return res.status(400).json({ error: "symbol(string), domestic(boolean) required" });
  }

  try {
    const { error } = await supabase
      .from("watchlist")
      .upsert({ symbol, domestic }, { onConflict: "symbol" });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    console.error("[RAVEN] /api/watchlist POST error:", e);
    res.status(502).json({ error: "watchlist add error" });
  }
});

router.delete("/:symbol", async (req, res) => {
  const { symbol } = req.params;

  try {
    const { error } = await supabase.from("watchlist").delete().eq("symbol", symbol);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    console.error("[RAVEN] /api/watchlist DELETE error:", e);
    res.status(502).json({ error: "watchlist remove error" });
  }
});

// 스케줄러가 실제로 도는지 수동으로 즉시 트리거 (테스트/디버그용) — 실제 텔레그램 전송은 안 하고
// 신호 판정 결과만 반환함 (알림 전송 자체는 /api/watchlist/check-now-and-alert 참고)
router.get("/check-now/:symbol", async (req, res) => {
  const { symbol } = req.params;

  try {
    const result = await checkSignal(symbol);
    res.json(result);
  } catch (e) {
    console.error("[RAVEN] /api/watchlist/check-now error:", e);
    res.status(502).json({ error: "signal check error" });
  }
});

// 스케줄러의 전체 파이프라인(신호체크+텔레그램 전송)을 수동으로 즉시 트리거 (테스트/디버그용)
// ⚠️ 이건 실제로 텔레그램 메시지를 보낼 수 있음 — 신호가 없으면 조용히 넘어감
router.post("/check-now-and-alert", async (req, res) => {
  try {
    const results = await checkWatchlistAndAlert();
    res.json({ result: results });
  } catch (e) {
    console.error("[RAVEN] /api/watchlist/check-now-and-alert error:", e);
    res.status(502).json({ error: "check-now-and-alert error" });
  }
});

module.exports = router;
