const { supabase } = require("./supabaseClient");
const { collectSupplyDemandForSymbol } = require("./supplyDemandCollector");

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

async function getLatestRows(symbol) {
  const [program_trade, short_sale, credit_balance, loan_trans] = await Promise.all([
    getLatestRow(symbol, "program_trade"),
    getLatestRow(symbol, "short_sale"),
    getLatestRow(symbol, "credit_balance"),
    getLatestRow(symbol, "loan_trans"),
  ]);
  return { program_trade, short_sale, credit_balance, loan_trans };
}

// tone: 1=우호적, -1=부담, 0=중립 (전체 어조 판단에 합산)
function interpretProgramTrade(row) {
  if (!row) return { text: "프로그램매매 데이터가 없습니다.", tone: 0 };
  const r = row.raw_data;
  const netQty = Number(r.whol_smtn_ntby_qty);
  const netAmt = Number(r.whol_smtn_ntby_tr_pbmn);
  const trendIcdc = Number(r.whol_ntby_vol_icdc);

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

function interpretShortSale(row) {
  if (!row) return { text: "공매도 데이터가 없습니다.", tone: 0 };
  const ratio = Number(row.raw_data.ssts_vol_rlim); // 당일 거래량 대비 공매도 비중(%)

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
  const newStcn = Number(r.whol_loan_new_stcn);
  const rdmpStcn = Number(r.whol_loan_rdmp_stcn);
  const rate = Number(r.whol_loan_rmnd_rate);

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
  const change = Number(row.raw_data.prdy_rmnd_vrss);

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

// 종목의 전일 수급 4종을 오늘 해석 + 내일 예상 코멘트로 변환
// 캐시된 데이터가 없으면 그 자리에서 KIS로 즉시 수집(+캐싱)한 뒤 해석함
async function interpretSupplyDemand(symbol) {
  let rows = await getLatestRows(symbol);

  const hasAnyData = Object.values(rows).some((r) => r !== null);
  if (!hasAnyData) {
    await collectSupplyDemandForSymbol(symbol);
    rows = await getLatestRows(symbol);
  }

  const parts = [
    interpretProgramTrade(rows.program_trade),
    interpretShortSale(rows.short_sale),
    interpretCreditBalance(rows.credit_balance),
    interpretLoanTrans(rows.loan_trans),
  ];

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
    null;

  return {
    date: latestDate,
    lines: parts.map((p) => p.text),
    outlook,
  };
}

module.exports = { interpretSupplyDemand };
