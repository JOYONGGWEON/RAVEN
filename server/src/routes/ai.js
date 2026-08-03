const express = require("express");
const router = express.Router();
const { getAnthropicClient } = require("../lib/anthropicClient");

const MODEL = "claude-sonnet-5";

const SYSTEM_PROMPT = `당신은 월가 스타일의 전문 퀀트 트레이더 관점에서 국내/해외 주식을 해석하는 애널리스트입니다.
아래 규칙을 반드시 지키세요:
- 입력으로 주어지는 지표는 이미 계산이 끝난 값입니다. 새로운 숫자를 지어내지 말고, 주어진 값만 근거로 서술하세요.
- 뉴스나 심리적 낙관/비관이 아니라 거래량, 수급, 추세/모멘텀 지표, 캔들 패턴 등 데이터 기반으로 해석하세요.
- 반드시 한국어로, 2~4개 문단 정도의 자연스러운 서술형으로 답하세요. 마크다운 제목(#)이나 헤더, 굵게(**) 같은 서식 없이 순수 문단 텍스트로만 답하고, 불릿(-, •, ▶ 등)이나 번호 매기기로 나열하지 말고 자연스러운 문장으로 이어서 쓰세요. 불필요한 서론/인사말 없이 바로 분석 내용으로 시작하세요(문단이나 문장 맨 앞에 기호를 붙이지 마세요).
- 마지막 문단에는 이 데이터가 가리키는 시나리오(강세/약세/중립)와 유의할 리스크를 짧게 정리하세요.
- 투자 조언이나 매수/매도 지시가 아니라 데이터 해석이라는 어조를 유지하세요 (예: "~할 수 있습니다", "~로 보입니다").

가장 중요한 규칙 — 이 분석은 화면에 이미 나열된 개별 지표(RSI/MACD/ADX 등)를 문장으로 그대로
바꿔 말하는 게 아닙니다. 그건 이미 화면에 다 표시돼 있어서 사용자가 다시 읽을 필요가 없습니다.
아래 두 가지를 반드시 실제로 통합해서, 화면만 봐서는 알 수 없는 "해석"을 만들어내세요:
1) [시장 전반 배경] — 이 종목의 오늘 움직임이 코스피/코스닥(국내) 또는 나스닥/S&P500/필라델피아
   반도체/다우존스(해외)와 같은 방향인지 다른 방향인지 반드시 비교해서 언급하세요. 시장 전체가
   상승하는데 이 종목만 부진하다면(혹은 그 반대라면) 그 괴리 자체가 중요한 해석 포인트입니다.
   VIX 수준으로 현재 시장의 위험선호 분위기도 짧게 짚으세요.
2) [최근 뉴스 헤드라인] — 제공된 헤드라인 "제목 그대로만" 참고해서, 최근 가격/거래량 움직임과
   시점이 맞아떨어지는지(예: 실적 발표 이후 거래량이 급증했는지) 연결해서 서술하세요. 헤드라인에
   없는 구체적 수치·날짜·발언·후속 전망을 지어내지 마세요 — 헤드라인 제목 자체가 근거의 전부입니다.
   헤드라인이 아예 제공되지 않으면 이 부분은 언급하지 말고 넘어가세요(없는 뉴스를 지어내지 말 것).
이 두 가지가 없으면(market/news가 비어있으면) 해당 부분은 자연스럽게 생략하고 기존 지표
해석만 하되, 있으면 반드시 위 통합 관점으로 녹여서 쓰세요.`;

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
    flow,
    supplyDemandText,
    supplyDemandLines,
    market,
    news
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

  // 시장 전반 배경 — 화면 헤더의 지수 대시보드 스냅샷을 그대로 받아옴(같은 값을 재계산하지 않고
  // 프론트가 이미 계산해둔 걸 그대로 서술에만 씀, 다른 지표들과 동일한 원칙).
  const MARKET_LABELS = {
    kospi: "코스피",
    kosdaq: "코스닥",
    nasdaq: "나스닥",
    sp500: "S&P500",
    sox: "필라델피아반도체",
    dow: "다우존스",
    vix: "VIX"
  };
  // vix는 2026-08-01부터 다른 지수와 동일한 칩(값+등락률) 형태로 통일돼서, 여기서도 특별취급 없이
  // 값 자체를 같이 보여줌(수준 자체가 의미 있는 지표라 등락률만으론 부족 — 예: "VIX 16.5(+2.1%)").
  const marketParts = Object.entries(market || {})
    .filter(([, v]) => v && Number.isFinite(v.value))
    .map(([key, v]) => {
      const label = MARKET_LABELS[key] || key;
      if (key === "vix") return `VIX ${fmt(v.value, 1)}(${fmt(v.changePct, 1)}%)`;
      return `${label} ${fmt(v.changePct, 2)}%`;
    });
  if (marketParts.length > 0) {
    lines.push("");
    lines.push("[오늘 시장 전반 배경]");
    lines.push(marketParts.join(", "));
  }

  if (Array.isArray(news) && news.length > 0) {
    lines.push("");
    lines.push("[최근 뉴스 헤드라인 — 제목 그대로만 참고, 세부내용 지어내지 말 것]");
    news.forEach((title) => lines.push(`- ${title}`));
  }

  lines.push("");
  lines.push("[추세/모멘텀 지표]");
  lines.push(`RSI(14): ${fmt(indicators?.rsi, 1)} (${indicators?.rsiCross || "NONE"})`);
  lines.push(
    `MACD: ${fmt(indicators?.macd)} / Signal: ${fmt(indicators?.macdSignal)} / Histogram: ${fmt(
      indicators?.macdHistogram
    )} (${indicators?.macdCrossover || "NONE"})`
  );
  if (indicators?.macdDivergence && indicators.macdDivergence.divergence !== "NONE") {
    const d = indicators.macdDivergence;
    lines.push(
      `MACD 다이버전스: ${d.divergence}(최근 ${d.lookback}일 기준, 가격 변화 ${fmt(
        d.priceChangePct,
        1
      )}%)`
    );
  }
  lines.push(
    `ADX(14): ${fmt(indicators?.adx, 1)} (+DI ${fmt(indicators?.plusDI, 1)} / -DI ${fmt(
      indicators?.minusDI,
      1
    )})${indicators?.adxTrend && indicators.adxTrend !== "FLAT" ? ` — 추세 강도 ${indicators.adxTrend === "RISING" ? "강화 중" : "약화 중"}` : ""}`
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

  if (flow) {
    lines.push("");
    lines.push("[당일 수급 (거래량·캔들 기반)]");
    if (flow.flowLabel) lines.push(`상태: ${flow.flowLabel}`);
    if (flow.flowNote) lines.push(flow.flowNote);
    if (flow.obvInfo && flow.obvInfo.divergence && flow.obvInfo.divergence !== "NONE") {
      lines.push(
        `OBV 다이버전스: ${flow.obvInfo.divergence}(최근 ${flow.obvInfo.lookback}일 기준, 가격 변화 ${fmt(
          flow.obvInfo.priceChangePct,
          1
        )}%)`
      );
    }
  }

  // 전일 수급 5종(프로그램매매/공매도/신용/대차/투자자별)의 개별 수치 라인 — 결론(supplyDemandText)만
  // 주면 AI가 "외국인 N일 연속 순매도" 같은 구체적 근거를 못 쓰고 뭉뚱그리게 되던 걸 개선.
  if (Array.isArray(supplyDemandLines) && supplyDemandLines.length > 0) {
    lines.push("");
    lines.push("[전일 수급 상세 (프로그램매매/공매도/신용/대차/투자자별)]");
    supplyDemandLines.forEach((l) => lines.push(`- ${l}`));
  }

  if (supplyDemandText) {
    lines.push("");
    lines.push("[전일 수급 종합 해석]");
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
