const { getKisAccessToken } = require("./kisAuth");

const KIS_API_BASE = "https://openapi.koreainvestment.com:9443";

// 다른 lib 파일들(kisMarket.js, supplyDemandCollector.js)과 같은 방식 — 파일마다 자체 kisGet을
// 두는 기존 컨벤션을 그대로 따름(공용 http 클라이언트 모듈로 묶는 리팩터는 이번 범위 밖).
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
  if (!res.ok || (json && json.rt_cd !== undefined && json.rt_cd !== "0")) {
    throw new Error(`KIS API error (${trId}): HTTP ${res.status}, rt_cd=${json?.rt_cd}, msg=${json?.msg1}`);
  }
  return json;
}

// stac_yymm(예: "202603")은 분기 결산월 — 국내 상장사는 3/6/9/12월 분기결산이 표준이라
// 월코드를 분기 숫자로 바로 매핑(실측 확인: 삼성전자 응답이 정확히 이 4개 월만 나옴).
const QUARTER_MONTH_MAP = { "03": "1", "06": "2", "09": "3", "12": "4" };
function formatQuarterLabel(yyyymm) {
  const year = yyyymm.slice(0, 4);
  const month = yyyymm.slice(4, 6);
  const q = QUARTER_MONTH_MAP[month];
  return q ? `${year}년 ${q}분기` : `${year}.${month}`;
}

// ⚠️ 실측으로 발견한 중요한 함정: 이 API가 주는 매출액/영업이익/당기순이익은 "해당 분기 단독" 값이
// 아니라 "연초 누적"(회계연도 1분기부터 해당 분기까지 합산) 값임 — 삼성전자 실측으로 확인:
// 2022년 Q1→Q4가 777,815 → 1,549,851 → 2,317,668 → 3,022,314로 계속 증가하다가 2023년 Q1에서
// 637,454로 뚝 떨어짐(매년 1분기에 리셋되는 누적치의 전형적 패턴). 이걸 그대로 "분기별 매출"로
// 그래프에 그리면 4분기로 갈수록 매출이 폭증하는 것처럼 완전히 잘못 보이므로, 같은 회계연도 안에서
// 이전 분기 누적치를 빼서 "분기 단독" 값으로 변환함(1분기는 누적=단독이라 그대로 둠, 매 1월(03월
// 결산코드)마다 누적 기준을 리셋).
function toStandaloneQuarters(cumulativeRows) {
  const result = [];
  let year = null;
  let prevRevenue = 0;
  let prevOperatingProfit = 0;
  let prevNetIncome = 0;

  for (const r of cumulativeRows) {
    const rowYear = r.yyyymm.slice(0, 4);
    if (rowYear !== year) {
      year = rowYear;
      prevRevenue = 0;
      prevOperatingProfit = 0;
      prevNetIncome = 0;
    }
    result.push({
      yyyymm: r.yyyymm,
      label: r.label,
      revenue: r.revenue - prevRevenue,
      operatingProfit: r.operatingProfit - prevOperatingProfit,
      netIncome: r.netIncome - prevNetIncome,
    });
    prevRevenue = r.revenue;
    prevOperatingProfit = r.operatingProfit;
    prevNetIncome = r.netIncome;
  }

  return result;
}

// 국내 종목 분기별 손익계산서(매출액/영업이익/당기순이익) — Phase 5(실적 그래프)용.
// 실측으로 확인한 필드 특성: 응답의 여러 필드(감가상각비/판관비/영업외손익/특별손익 등)가
// "99.99" 플레이스홀더로만 오고 실제 채워지는 값은 매출액(sale_account)/매출원가(sale_cost)/
// 매출총이익(sale_totl_prfi)/영업이익(op_prfi)/당기순이익(thtr_ntin) 정도라, 이 5개만 파싱함.
async function fetchIncomeStatement(symbol) {
  const json = await kisGet(
    "/uapi/domestic-stock/v1/finance/income-statement",
    "FHKST66430200",
    { FID_DIV_CLS_CODE: "1", fid_cond_mrkt_div_code: "J", fid_input_iscd: symbol }
  );

  const rows = json.output || [];
  const cumulative = rows
    .map((r) => ({
      yyyymm: r.stac_yymm,
      label: r.stac_yymm ? formatQuarterLabel(r.stac_yymm) : null,
      revenue: Number(r.sale_account),
      operatingProfit: Number(r.op_prfi),
      netIncome: Number(r.thtr_ntin),
    }))
    .filter((r) => r.yyyymm && Number.isFinite(r.revenue))
    .sort((a, b) => a.yyyymm.localeCompare(b.yyyymm)); // 오래된 분기 → 최신 분기 순(그래프 좌→우)

  return toStandaloneQuarters(cumulative);
}

module.exports = { fetchIncomeStatement };
