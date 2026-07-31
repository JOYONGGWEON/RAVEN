const { supabase } = require("./supabaseClient");
const { collectSupplyDemandForSymbol } = require("./supplyDemandCollector");

// KIS 응답 필드가 빈 문자열("")로 오는 경우가 실제로 있음(장중 당일 데이터가 아직 집계되기 전 —
// investor_trend가 일중 누적치라 장 시작 직후엔 당일 행 자체는 있는데 값만 비어있는 걸 실측 확인함).
// Number("")는 NaN이 아니라 0이라 그냥 Number()를 쓰면 "0주 순매수"처럼 없는 데이터를 있는 것처럼
// 잘못 표시하는 버그가 생김 — 빈 문자열/null/undefined는 명시적으로 NaN 처리.
function parseKisNum(v) {
  if (v === "" || v === null || v === undefined) return NaN;
  return Number(v);
}

async function getLatestRow(symbol, dataType) {
  const { data, error } = await supabase
    .from("supply_demand_daily")
    .select("trade_date, raw_data")
    .eq("symbol", symbol)
    .eq("data_type", dataType)
    .order("trade_date", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

async function getRecentRows(symbol, dataType, limit = 5) {
  const { data, error } = await supabase
    .from("supply_demand_daily")
    .select("trade_date, raw_data")
    .eq("symbol", symbol)
    .eq("data_type", dataType)
    .order("trade_date", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// program_trade/investor_trend는 일중 누적치라 "가장 최신 날짜 행"이 오늘인데 값만 비어있을 수 있음.
// 그 경우 그냥 "데이터 없음"으로 포기하지 않고, 최근 며칠 중 값이 채워진 가장 최신 행으로 폴백해서
// 보여줌(예: 오늘 데이터가 아직 집계 전이면 어제 데이터를 계속 보여줌). rawLatest는 "오늘 것이 실제로
// 왔는지"를 판단해 재수집 여부를 결정하는 데 별도로 씀.
async function getLatestUsableRow(symbol, dataType, isUsable) {
  const rows = await getRecentRows(symbol, dataType);
  const usable = rows.find((row) => isUsable(row));
  return { display: usable || rows[0] || null, rawLatest: rows[0] || null };
}

async function getLatestRows(symbol) {
  const [credit_balance, loan_trans, programResult, shortResult, investorResult] = await Promise.all([
    getLatestRow(symbol, "credit_balance"),
    getLatestRow(symbol, "loan_trans"),
    getLatestUsableRow(symbol, "program_trade", isProgramTradeRowUsable),
    getLatestUsableRow(symbol, "short_sale", isShortSaleRowUsable),
    getLatestUsableRow(symbol, "investor_trend", isInvestorRowUsable),
  ]);
  return {
    program_trade: programResult.display,
    short_sale: shortResult.display,
    credit_balance,
    loan_trans,
    investor_trend: investorResult.display,
    programRawLatest: programResult.rawLatest,
    shortRawLatest: shortResult.rawLatest,
    investorRawLatest: investorResult.rawLatest,
  };
}

// tone: 1=우호적, -1=부담, 0=중립 (전체 어조 판단에 합산)
// program_trade도 investor_trend와 같은 이유(일중 누적치)로 당일 행이 비어있을 수 있어 동일하게 체크.
function isProgramTradeRowUsable(row) {
  if (!row) return false;
  return Number.isFinite(parseKisNum(row.raw_data.whol_smtn_ntby_qty));
}

function interpretProgramTrade(row) {
  if (!row) return { text: "프로그램매매 데이터가 없습니다.", tone: 0 };
  const r = row.raw_data;
  const netQty = parseKisNum(r.whol_smtn_ntby_qty);
  const netAmt = parseKisNum(r.whol_smtn_ntby_tr_pbmn);
  const trendIcdc = parseKisNum(r.whol_ntby_vol_icdc);

  // ⚠️ 예전엔 이 가드가 없어서 필드가 비어있어도(NaN) netQty>0/<0 둘 다 거짓이라 조용히
  // "균형" 문구로 빠지며 데이터 없음을 숨기고 있었음 — 다른 4개 해석 함수는 이미 이 가드가 있었는데
  // 이 함수만 빠져있던 것.
  if (!Number.isFinite(netQty)) {
    return { text: "프로그램매매 데이터가 없습니다.", tone: 0 };
  }

  let text;
  let tone = 0;
  if (netQty > 0) {
    text = `프로그램매매는 ${Math.abs(netQty).toLocaleString()}주 순매수(약 ${Math.round(
      netAmt / 1e8
    ).toLocaleString()}억원)로 매수 우위였습니다.`;
    tone = 1;
  } else if (netQty < 0) {
    text = `프로그램매매는 ${Math.abs(netQty).toLocaleString()}주 순매도(약 ${Math.round(
      Math.abs(netAmt) / 1e8
    ).toLocaleString()}억원)로 매도 우위였습니다.`;
    tone = -1;
  } else {
    text = "프로그램매매는 순매수·순매도가 거의 균형을 이뤘습니다.";
  }

  if (Number.isFinite(trendIcdc) && trendIcdc !== 0) {
    text += trendIcdc > 0 ? " 전일보다 매수세가 강해지는 흐름입니다." : " 전일보다 매수세가 약해지는 흐름입니다.";
  }

  return { text, tone };
}

// short_sale도 program_trade/investor_trend와 마찬가지로 "당일 거래량 대비 비중"을 실시간
// 누적으로 주는 방식이라 장중엔 오늘 행이 비어있을 수 있음(실측으로 확인 — 장마감 직후엔 채워져 있었음).
function isShortSaleRowUsable(row) {
  if (!row) return false;
  return Number.isFinite(parseKisNum(row.raw_data.ssts_vol_rlim));
}

function interpretShortSale(row) {
  if (!row) return { text: "공매도 데이터가 없습니다.", tone: 0 };
  const ratio = parseKisNum(row.raw_data.ssts_vol_rlim); // 당일 거래량 대비 공매도 비중(%)

  if (!Number.isFinite(ratio)) return { text: "공매도 데이터가 없습니다.", tone: 0 };

  if (ratio >= 8) {
    return {
      text: `당일 거래량 대비 공매도 비중이 ${ratio.toFixed(2)}%로 높은 편입니다. 하방 압력에 유의할 구간입니다.`,
      tone: -1,
    };
  }
  if (ratio >= 4) {
    return { text: `공매도 비중은 ${ratio.toFixed(2)}%로 보통 수준입니다.`, tone: 0 };
  }
  return {
    text: `공매도 비중은 ${ratio.toFixed(2)}%로 낮은 편이라, 공매도발 하방 압력은 제한적입니다.`,
    tone: 1,
  };
}

function interpretCreditBalance(row) {
  if (!row) return { text: "신용잔고 데이터가 없습니다.", tone: 0 };
  const r = row.raw_data;
  const newStcn = parseKisNum(r.whol_loan_new_stcn);
  const rdmpStcn = parseKisNum(r.whol_loan_rdmp_stcn);
  const rate = parseKisNum(r.whol_loan_rmnd_rate);

  if (!Number.isFinite(newStcn) || !Number.isFinite(rdmpStcn)) {
    return { text: "신용잔고 데이터가 없습니다.", tone: 0 };
  }

  if (newStcn > rdmpStcn) {
    return {
      text: `신용융자 신규 유입이 상환보다 많아 신용잔고가 늘었습니다(잔고율 ${rate.toFixed(
        2
      )}%). 상승 기대 심리가 반영된 것일 수 있지만, 급락 시 반대매매 리스크도 함께 커진 상태입니다.`,
      tone: 0,
    };
  }
  return {
    text: `신용융자 상환이 신규보다 많아 신용잔고가 줄었습니다(잔고율 ${rate.toFixed(
      2
    )}%). 레버리지 매수 부담이 완화되는 흐름입니다.`,
    tone: 1,
  };
}

function interpretLoanTrans(row) {
  if (!row) return { text: "대차거래 데이터가 없습니다.", tone: 0 };
  const change = parseKisNum(row.raw_data.prdy_rmnd_vrss);

  if (!Number.isFinite(change)) return { text: "대차거래 데이터가 없습니다.", tone: 0 };

  if (change > 0) {
    return {
      text: `대차잔고(공매도 대기 물량)가 전일 대비 ${change.toLocaleString()}주 늘었습니다. 향후 공매도 압력이 커질 수 있는 신호입니다.`,
      tone: -1,
    };
  }
  if (change < 0) {
    return {
      text: `대차잔고가 전일 대비 ${Math.abs(change).toLocaleString()}주 줄었습니다. 공매도 대기 물량이 축소되는 흐름입니다.`,
      tone: 1,
    };
  }
  return { text: "대차잔고는 전일과 큰 변화가 없습니다.", tone: 0 };
}

function interpretInvestorTrend(row) {
  if (!row) return { text: "투자자별(개인/외국인/기관) 매매동향 데이터가 없습니다.", tone: 0 };
  const r = row.raw_data;
  const prsn = parseKisNum(r.prsn_ntby_qty);
  const frgn = parseKisNum(r.frgn_ntby_qty);
  const orgn = parseKisNum(r.orgn_ntby_qty);

  if ([prsn, frgn, orgn].some((n) => Number.isNaN(n))) {
    return { text: "투자자별(개인/외국인/기관) 매매동향 데이터가 없습니다.", tone: 0 };
  }

  const fmt = (n) => `${Math.abs(n).toLocaleString()}주 ${n >= 0 ? "순매수" : "순매도"}`;
  let text = `투자자별로는 개인 ${fmt(prsn)}, 외국인 ${fmt(frgn)}, 기관 ${fmt(orgn)}입니다.`;

  // 외국인·기관("스마트머니")과 개인의 방향이 엇갈리는지를 우선 보고, 아니면 외국인+기관 합산 방향으로 판단
  let tone = 0;
  if (frgn > 0 && orgn > 0) {
    tone = 1;
    text += " 외국인·기관이 동반 순매수하는 우호적인 수급 구조입니다.";
  } else if (frgn < 0 && orgn < 0 && prsn > 0) {
    tone = -1;
    text += " 외국인·기관이 동반 순매도한 물량을 개인이 받아내는 구조로, 수급 주체 측면에서는 부담 요인입니다.";
  } else {
    const smartMoney = frgn + orgn;
    if (smartMoney > 0) {
      tone = 1;
      text += " 외국인·기관 합산으로는 순매수 우위입니다.";
    } else if (smartMoney < 0) {
      tone = -1;
      text += " 외국인·기관 합산으로는 순매도 우위입니다.";
    }
  }

  return { text, tone };
}

// investor_trend는 일중 누적치라 당일 행이 존재해도 장 시작 직후엔 값이 비어있을 수 있음(위 참고).
// 그런 "존재하지만 비어있는" 행은 데이터가 있다고 착각하면 안 되므로 별도로 유효성 체크.
function isInvestorRowUsable(row) {
  if (!row) return false;
  const r = row.raw_data;
  return [r.prsn_ntby_qty, r.frgn_ntby_qty, r.orgn_ntby_qty].every((v) => Number.isFinite(parseKisNum(v)));
}

// 최근 N영업일치 investor_trend 히스토리(최신순) — 연속 순매수/매도 감지용
async function getInvestorTrendHistory(symbol, limit = 15) {
  const { data, error } = await supabase
    .from("supply_demand_daily")
    .select("trade_date, raw_data")
    .eq("symbol", symbol)
    .eq("data_type", "investor_trend")
    .order("trade_date", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// historyDesc(최신순) 중 한 필드(외국인/기관 순매수량)가 며칠 연속 같은 방향인지 계산.
// 맨 앞(오늘) 행이 아직 장중 미집계라 비어있으면(값이 NaN) 그 행만 건너뛰고 어제부터 셈 —
// 중간에 비어있는 날이 있으면(수집 실패 등) 거기서 연속 카운트를 끊음.
function computeStreak(historyDesc, field) {
  const values = [];
  for (const row of historyDesc) {
    const v = parseKisNum(row.raw_data[field]);
    if (Number.isFinite(v)) {
      values.push(v);
    } else if (values.length === 0) {
      continue;
    } else {
      break;
    }
  }
  if (!values.length) return null;

  const sign = values[0] > 0 ? 1 : values[0] < 0 ? -1 : 0;
  if (sign === 0) return null;

  let days = 0;
  let cumulative = 0;
  for (const v of values) {
    const s = v > 0 ? 1 : v < 0 ? -1 : 0;
    if (s !== sign) break;
    days += 1;
    cumulative += v;
  }
  return { direction: sign > 0 ? "BUY" : "SELL", days, cumulative };
}

// 외국인/기관 연속 순매수·순매도 — 실전에서 많이 보는 수급 투자포인트라 요청받아 추가함.
// 3일 미만은 "연속"이라 부르기 애매해서 문장 자체를 생략함(짧은 노이즈성 흐름까지 강조하지 않기 위함).
function interpretInvestorStreak(historyDesc) {
  const MIN_DAYS = 3;
  const frgnStreak = computeStreak(historyDesc, "frgn_ntby_qty");
  const orgnStreak = computeStreak(historyDesc, "orgn_ntby_qty");

  const bits = [];
  let tone = 0;

  if (frgnStreak && frgnStreak.days >= MIN_DAYS) {
    const verb = frgnStreak.direction === "BUY" ? "순매수" : "순매도";
    bits.push(`외국인 ${frgnStreak.days}일 연속 ${verb}(누적 ${Math.abs(frgnStreak.cumulative).toLocaleString()}주)`);
    tone += frgnStreak.direction === "BUY" ? 1 : -1;
  }
  if (orgnStreak && orgnStreak.days >= MIN_DAYS) {
    const verb = orgnStreak.direction === "BUY" ? "순매수" : "순매도";
    bits.push(`기관 ${orgnStreak.days}일 연속 ${verb}(누적 ${Math.abs(orgnStreak.cumulative).toLocaleString()}주)`);
    tone += orgnStreak.direction === "BUY" ? 1 : -1;
  }

  if (!bits.length) return null;
  return { text: `${bits.join(", ")} 흐름이 이어지고 있습니다.`, tone };
}

// 캐시된 데이터의 최신 날짜가 오늘로부터 며칠 지났는지(주말/연휴 감안해 4일까지는 정상 범위로 봄)
function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  const then = new Date(`${dateStr}T00:00:00Z`).getTime();
  const now = Date.now();
  return (now - then) / (1000 * 60 * 60 * 24);
}

// 한국 날짜(KST) 기준 오늘 날짜, YYYY-MM-DD
function todayKST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

// program_trade/short_sale/investor_trend는 "당일 실시간 누적" 데이터라, 캐시된 값이 완전해 보여도
// 그게 어제(혹은 그 이전) 날짜 것일 뿐 오늘 데이터를 아직 한 번도 안 가져와본 상태일 수 있음
// (실측으로 재현한 버그: 캐시가 유효한 "어제" 데이터라 hasAllData/isStale 둘 다 통과해서 재수집이
// 아예 트리거되지 않고, 장마감 후에도 하루 종일 어제 데이터만 계속 보여주고 있었음). "오늘 날짜의
// 값 채워진 행"이 아니면 무조건 재시도하도록 날짜까지 같이 비교함.
function isFreshForToday(row, isUsable, today) {
  return !!row && row.trade_date === today && isUsable(row);
}

// 종목의 전일 수급 5종(프로그램매매/공매도/신용/대차/투자자별)을 오늘 해석 + 내일 예상 코멘트로 변환
// 캐시된 데이터가 없으면 그 자리에서 KIS로 즉시 수집(+캐싱)한 뒤 해석함
async function interpretSupplyDemand(symbol) {
  let rows = await getLatestRows(symbol);

  // ⚠️ "하나라도 있으면 스킵"(hasAnyData)이었을 때 실제로 겪은 버그: investor_trend를 5번째
  // 타입으로 추가한 뒤, 이미 다른 4종 캐시가 있던 종목은 hasAnyData가 true라 재수집이 통째로
  // 스킵되면서 investor_trend만 영영 채워지지 않았음(실측으로 재현·확인함). 5종 전부 있는지로 바꿔서
  // 타입 하나라도 비어있으면(신규 타입 추가/일시적 수집 실패 등) 다시 채워지도록 함.
  const hasAllData =
    rows.program_trade !== null &&
    rows.short_sale !== null &&
    rows.credit_balance !== null &&
    rows.loan_trans !== null &&
    rows.investor_trend !== null;

  // program_trade/short_sale/investor_trend(당일 실시간 누적 3종)는 getLatestRows가 이미 "값 채워진
  // 최신 행"으로 폴백해서 보여주지만, 그 폴백 행이 오늘 날짜가 아니라면(=오늘 데이터를 아직 못 가져왔거나
  // 오늘 행이 비어있는 상태) 매 요청마다 계속 재시도해야 함 — rawLatest 기준으로 별도 체크.
  const today = todayKST();
  const needsRetryToday =
    !isFreshForToday(rows.programRawLatest, isProgramTradeRowUsable, today) ||
    !isFreshForToday(rows.shortRawLatest, isShortSaleRowUsable, today) ||
    !isFreshForToday(rows.investorRawLatest, isInvestorRowUsable, today);

  // ⚠️ 또 다른 실제 버그: hasAllData가 한 번 true가 되면(예: 예전 세션에 한 번 수집됨) 그 뒤로는
  // "5종 다 있으니 됐다"고 영원히 재수집을 안 해서, 캐시가 며칠 지나도 최신화가 안 되고 날짜가
  // 계속 예전 그대로 박혀있는 문제가 있었음(사용자가 7/24처럼 오래된 날짜를 보고받는 것으로 재현됨).
  // "다 있는지"뿐 아니라 "최신인지"도 같이 봐서, 가장 최근 캐시 날짜가 너무 오래됐으면 다시 수집함.
  const latestCachedDate = [
    rows.program_trade?.trade_date,
    rows.short_sale?.trade_date,
    rows.credit_balance?.trade_date,
    rows.loan_trans?.trade_date,
    rows.investor_trend?.trade_date,
  ]
    .filter(Boolean)
    .sort()
    .pop();
  const isStale = daysSince(latestCachedDate) > 4;

  if (!hasAllData || isStale || needsRetryToday) {
    await collectSupplyDemandForSymbol(symbol);
    rows = await getLatestRows(symbol);
  }

  const parts = [
    interpretProgramTrade(rows.program_trade),
    interpretShortSale(rows.short_sale),
    interpretCreditBalance(rows.credit_balance),
    interpretLoanTrans(rows.loan_trans),
    interpretInvestorTrend(rows.investor_trend),
  ];

  // 연속 순매수/매도는 하루 스냅샷이 아니라 최근 며칠 흐름을 봐야 해서 별도로 히스토리 조회.
  // 특이 연속매매가 없으면(3일 미만) null이라 문장 자체를 안 넣음 — 매번 뜨는 문구가 아님.
  const history = await getInvestorTrendHistory(symbol);
  const streakPart = interpretInvestorStreak(history);
  if (streakPart) parts.push(streakPart);

  const toneSum = parts.reduce((sum, p) => sum + p.tone, 0);
  let outlook;
  if (toneSum >= 2) {
    outlook =
      "전일 수급 지표는 전반적으로 우호적입니다. 다만 수급은 하루 단위로 바뀔 수 있으니 오늘 가격·거래량 흐름과 함께 확인하는 것을 권장합니다.";
  } else if (toneSum <= -2) {
    outlook =
      "전일 수급 지표는 부담스러운 신호가 많습니다. 신규 진입보다는 관망하며 지지선 반응을 지켜보는 편이 안전할 수 있습니다.";
  } else {
    outlook =
      "전일 수급 지표가 뚜렷한 한쪽 방향을 가리키지 않는 혼조 구간입니다. 가격·거래량 흐름을 함께 참고해 주세요.";
  }

  const latestDate =
    rows.program_trade?.trade_date ||
    rows.short_sale?.trade_date ||
    rows.credit_balance?.trade_date ||
    rows.loan_trans?.trade_date ||
    rows.investor_trend?.trade_date ||
    null;

  return {
    date: latestDate,
    lines: parts.map((p) => p.text),
    outlook,
  };
}

module.exports = { interpretSupplyDemand };
