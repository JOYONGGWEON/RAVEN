const { getKisAccessToken } = require("./kisAuth");
const { supabase } = require("./supabaseClient");

const KIS_API_BASE = "https://openapi.koreainvestment.com:9443";

async function kisGet(path, trId, query) {
  const token = await getKisAccessToken();
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`${KIS_API_BASE}${path}?${qs}`, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
      tr_id: trId,
      custtype: "P",
    },
  });
  const json = await res.json();

  // KIS는 HTTP 200이어도 본문의 rt_cd로 성공/실패를 알려줌 (0=성공) —
  // 이걸 확인 안 하면 레이트리밋/오류 응답이 "0건 수집"으로 조용히 묻힘
  if (!res.ok || (json && json.rt_cd !== undefined && json.rt_cd !== "0")) {
    throw new Error(
      `KIS API error (${trId}): HTTP ${res.status}, rt_cd=${json?.rt_cd}, msg=${json?.msg1}`
    );
  }

  return json;
}

function ymd(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function toIsoDate(yyyymmdd) {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function last20DaysRange() {
  const to = ymd(new Date());
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 20);
  return { from: ymd(fromDate), to };
}

// 데이터 종류별 조회 방법 (엔드포인트/TR ID/파라미터/응답 배열·날짜 필드가 전부 다름)
const DATA_TYPES = [
  {
    type: "program_trade",
    fetch: async (symbol) => {
      const json = await kisGet(
        "/uapi/domestic-stock/v1/quotations/program-trade-by-stock-daily",
        "FHPPG04650201",
        { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: symbol, FID_INPUT_DATE_1: "" }
      );
      return (json.output || []).map((row) => ({ date: row.stck_bsop_date, raw: row }));
    },
  },
  {
    type: "short_sale",
    fetch: async (symbol) => {
      const { from, to } = last20DaysRange();
      const json = await kisGet(
        "/uapi/domestic-stock/v1/quotations/daily-short-sale",
        "FHPST04830000",
        {
          FID_COND_MRKT_DIV_CODE: "J",
          FID_INPUT_ISCD: symbol,
          FID_INPUT_DATE_1: from,
          FID_INPUT_DATE_2: to,
        }
      );
      return (json.output2 || []).map((row) => ({ date: row.stck_bsop_date, raw: row }));
    },
  },
  {
    type: "credit_balance",
    fetch: async (symbol) => {
      const json = await kisGet(
        "/uapi/domestic-stock/v1/quotations/daily-credit-balance",
        "FHPST04760000",
        {
          fid_cond_mrkt_div_code: "J",
          fid_cond_scr_div_code: "20476",
          fid_input_iscd: symbol,
          fid_input_date_1: ymd(new Date()),
        }
      );
      return (json.output || []).map((row) => ({ date: row.deal_date, raw: row }));
    },
  },
  {
    type: "loan_trans",
    fetch: async (symbol) => {
      const { from, to } = last20DaysRange();
      const json = await kisGet(
        "/uapi/domestic-stock/v1/quotations/daily-loan-trans",
        "HHPST074500C0",
        {
          MRKT_DIV_CLS_CODE: "3",
          MKSC_SHRN_ISCD: symbol,
          START_DATE: from,
          END_DATE: to,
          CTS: "",
        }
      );
      return (json.output1 || []).map((row) => ({ date: row.bsop_date, raw: row }));
    },
  },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 종목 하나에 대해 4종 데이터를 전부 가져와 Supabase에 upsert
async function collectSupplyDemandForSymbol(symbol) {
  const result = { symbol, ok: [], failed: [] };

  for (const dataType of DATA_TYPES) {
    try {
      // KIS는 초당 거래건수 제한이 빡빡해서, 연속 호출 사이에 간격을 두고
      // 그래도 걸리면(레이트리밋) 잠깐 쉬었다 한 번 더 시도함
      await sleep(600);
      let rows;
      try {
        rows = await dataType.fetch(symbol);
      } catch (e) {
        if (!/초당 거래건수|rt_cd=1/.test(e.message)) throw e;
        await sleep(1200);
        rows = await dataType.fetch(symbol);
      }
      const records = rows
        .filter((r) => r.date)
        .map((r) => ({
          symbol,
          trade_date: toIsoDate(r.date),
          data_type: dataType.type,
          raw_data: r.raw,
        }));

      if (records.length) {
        const { error } = await supabase
          .from("supply_demand_daily")
          .upsert(records, { onConflict: "symbol,trade_date,data_type" });
        if (error) throw error;
      }
      result.ok.push({ type: dataType.type, count: records.length });
    } catch (e) {
      result.failed.push({ type: dataType.type, error: e.message });
    }
  }

  return result;
}

module.exports = { collectSupplyDemandForSymbol };
