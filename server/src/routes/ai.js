const express = require("express");
const router = express.Router();
const { getAnthropicClient } = require("../lib/anthropicClient");

const MODEL = "claude-sonnet-5";

const SYSTEM_PROMPT = `당신은 월가 스타일의 전문 퀀트 트레이더 관점에서 국내/해외 주식을 해석하는 애널리스트입니다.
아래 규칙을 반드시 지키세요:
- 입력으로 주어지는 지표는 이미 계산이 끝난 값입니다. 새로운 숫자를 지어내지 말고, 주어진 값만 근거로 서술하세요.
- 뉴스나 심리적 낙관/비관이 아니라 거래량, 수급, 추세/모멘텀 지표, 캔들 패턴 등 데이터 기반으로 해석하세요.
- 반드시 한국어로, 2~4개 문단 정도의 자연스러운 서술형으로 답하세요. 불필요한 서론/인사말 없이 바로 분석 내용으로 시작하세요.
- 마지막 문단에는 이 데이터가 가리키는 시나리오(강세/약세/중립)와 유의할 리스크를 짧게 정리하세요.
- 투자 조언이나 매수/매도 지시가 아니라 데이터 해석이라는 어조를 유지하세요 (예: "~할 수 있습니다", "~로 보입니다").`;

function fmt(v, digits = 2) {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "N/A";
}

function buildPrompt(payload) {
  const {
    displayName,
    ticker,
    isDomestic,
    price,
    currency,
    score,
    rank,
    verdict,
    indicators,
    levels,
    patterns,
    supplyDemandText
  } = payload;

  const lines = [];
  lines.push(`종목: ${displayName || ticker} (${isDomestic ? "국내" : "해외"})`);
  lines.push(`현재가: ${fmt(price, 0)} ${currency || ""}`);
  lines.push(`RAVEN SCORE: ${score ?? "N/A"} / RANK: ${rank ?? "N/A"}`);
  lines.push(
    `판정(verdict): ${verdict?.tier || "N/A"} (R:R ${fmt(verdict?.rrRaw)}, 기대수익 ${fmt(
      verdict?.upPctRaw
    )}%, 손실위험 ${fmt(verdict?.downPctRaw)}%)`
  );
  lines.push("");
  lines.push("[추세/모멘텀 지표]");
  lines.push(`RSI(14): ${fmt(indicators?.rsi, 1)} (${indicators?.rsiCross || "NONE"})`);
  lines.push(
    `MACD: ${fmt(indicators?.macd)} / Signal: ${fmt(indicators?.macdSignal)} / Histogram: ${fmt(
      indicators?.macdHistogram
    )} (${indicators?.macdCrossover || "NONE"})`
  );
  lines.push(
    `ADX(14): ${fmt(indicators?.adx, 1)} (+DI ${fmt(indicators?.plusDI, 1)} / -DI ${fmt(
      indicators?.minusDI,
      1
    )})`
  );
  lines.push(`ATR(14): ${fmt(indicators?.atr)} (${fmt(indicators?.atrPct, 1)}%)`);
  lines.push(`20일 변동성: ${fmt(indicators?.volatility, 1)}%`);
  lines.push(`전일 대비 등락률: ${fmt(indicators?.dailyChangePct, 1)}%`);
  lines.push(`거래량 비율(20일 평균 대비): ${fmt(indicators?.volumeRatio, 2)}x`);
  if (indicators?.rsInfo) {
    lines.push(
      `지수 대비 상대강도(RS): 20일 ${fmt(indicators.rsInfo.rs20, 1)}%p / 60일 ${fmt(
        indicators.rsInfo.rs60,
        1
      )}%p`
    );
  }
  lines.push("");
  lines.push("[지지/저항 및 목표가·손절가]");
  lines.push(`지지선: ${fmt(levels?.support1, 0)} / ${fmt(levels?.support2, 0)}`);
  lines.push(`저항선: ${fmt(levels?.resistance1, 0)} / ${fmt(levels?.resistance2, 0)}`);
  lines.push(`목표가: ${fmt(levels?.target1, 0)} / ${fmt(levels?.target2, 0)}`);
  lines.push(`손절가: ${fmt(levels?.stop, 0)}`);

  if (Array.isArray(patterns) && patterns.length > 0) {
    lines.push("");
    lines.push("[캔들 패턴]");
    patterns.forEach((p) => {
      lines.push(`- ${p.name} (강도 ${p.strength}/5): ${p.comment}`);
    });
  }

  if (supplyDemandText) {
    lines.push("");
    lines.push("[수급 해석 (전일 데이터 기반)]");
    lines.push(supplyDemandText);
  }

  return lines.join("\n");
}

router.post("/analyze", async (req, res) => {
  const payload = req.body || {};
  if (!payload.ticker && !payload.displayName) {
    return res.status(400).json({ error: "ticker or displayName required" });
  }

  try {
    const client = getAnthropicClient();
    const userPrompt = buildPrompt(payload);

    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }]
    });

    const textBlock = message.content.find((b) => b.type === "text");
    res.json({ narrative: textBlock ? textBlock.text : "" });
  } catch (e) {
    console.error("[RAVEN] /api/ai/analyze error:", e);
    if (e.message === "ANTHROPIC_API_KEY not set") {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다" });
    }
    res.status(502).json({ error: "AI 분석 호출 오류" });
  }
});

module.exports = router;
