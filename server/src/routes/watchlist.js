const express = require("express");
const router = express.Router();
const { supabase } = require("../lib/supabaseClient");
const { checkSignal } = require("../lib/signalDetector");
const { checkWatchlistAndAlert } = require("../scheduler");

router.get("/", async (req, res) => {
  try {
    let { data, error } = await supabase
      .from("watchlist")
      .select("symbol, name, domestic, added_at, group_name")
      .order("added_at", { ascending: false });

    // 42703 = undefined_column — group_name 마이그레이션(schema.sql의 alter문)을 아직 Supabase에서
    // 안 돌린 상태일 수 있음. 그룹핑 기능 자체를 못 쓰는 것만 빼고 관심종목 목록 전체가 깨지면 안 되니,
    // 이 컬럼만 빼고 한 번 더 시도해서 마이그레이션 전에도 기존 기능은 그대로 동작하게 함.
    if (error && error.code === "42703") {
      const fallback = await supabase
        .from("watchlist")
        .select("symbol, name, domestic, added_at")
        .order("added_at", { ascending: false });
      data = (fallback.data || []).map((row) => ({ ...row, group_name: null }));
      error = fallback.error;
    }

    if (error) throw error;
    res.json({ result: data });
  } catch (e) {
    console.error("[RAVEN] /api/watchlist GET error:", e);
    res.status(502).json({ error: "watchlist fetch error" });
  }
});

router.post("/", async (req, res) => {
  const { symbol, domestic, name } = req.body || {};
  if (!symbol || typeof domestic !== "boolean") {
    return res.status(400).json({ error: "symbol(string), domestic(boolean) required" });
  }

  try {
    const { error } = await supabase
      .from("watchlist")
      .upsert({ symbol, domestic, name: name || null }, { onConflict: "symbol" });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    console.error("[RAVEN] /api/watchlist POST error:", e);
    res.status(502).json({ error: "watchlist add error" });
  }
});

// 그룹명만 변경 — POST(upsert)를 재사용하지 않고 별도 라우트로 분리한 이유: upsert에 symbol/domestic
// 없이 group_name만 보내면 신규 insert 시도 시 NOT NULL 제약(domestic)에 걸릴 수 있어서, 항상 update만
// 하는 게 더 안전함(그룹 지정은 이미 목록에 있는 종목에만 적용되는 동작이라 update 전용으로 충분함).
router.patch("/:symbol/group", async (req, res) => {
  const { symbol } = req.params;
  const { group_name } = req.body || {};

  try {
    const { error } = await supabase
      .from("watchlist")
      .update({ group_name: group_name || null })
      .eq("symbol", symbol);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    console.error("[RAVEN] /api/watchlist/:symbol/group PATCH error:", e);
    res.status(502).json({ error: "watchlist group update error" });
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
