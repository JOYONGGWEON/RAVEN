const { getYahooCookieCrumb } = require("./yahooAuth");

const TIMESERIES_BASE = "https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/";

// 분기 결산월(3/6/9/12월) → 분기 숫자 — kisFundamentals.js의 QUARTER_MONTH_MAP과 동일한 매핑을
// 여기서도 그대로 씀(해외는 회계연도가 다른 회사도 있지만, 이 프로젝트가 다루는 대형 미국 티커들은
// 대체로 12월 결산이라 우선 국내와 같은 매핑으로 처리 — 다른 회계연도 기업은 후속 개선 대상).
const QUARTER_MONTH_MAP = { "01": "1", "02": "1", "03": "1", "04": "2", "05": "2", "06": "2", "07": "3", "08": "3", "09": "3", "10": "4", "11": "4", "12": "4" };
function formatQuarterLabel(yyyymm) {
  const year = yyyymm.slice(0, 4);
  const month = yyyymm.slice(4, 6);
  const q = QUARTER_MONTH_MAP[month];
  return q ? `${year}년 ${q}분기` : `${year}.${month}`;
}

async function requestTimeseries(symbol, cookie, crumb) {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - 3 * 365 * 24 * 60 * 60; // 최근 3년치면 8분기 이상 확보됨(실측: AAPL 분기 간격 ~3개월)
  const types = "quarterlyTotalRevenue,quarterlyOperatingIncome";
  const url =
    `${TIMESERIES_BASE}${encodeURIComponent(symbol)}` +
    `?symbol=${encodeURIComponent(symbol)}&type=${types}&period1=${period1}&period2=${period2}&crumb=${encodeURIComponent(crumb)}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      cookie,
    },
  });
  const json = await res.json();
  if (!res.ok || json?.timeseries?.error) {
    const err = new Error(`Yahoo fundamentals-timeseries error: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// 해외 종목 분기별 매출액/영업이익 (Phase 5, 5단계). KIS는 해외 손익계산서를 제공하지 않아
// Yahoo Finance로 대체 — 다만 Yahoo의 quoteSummary류는 크럼 인증이 필요해서(yahooAuth.js 참고)
// 401을 만나면 크럼을 한 번 강제로 재발급받아 재시도함(만료/무효화 대응).
async function fetchOverseasIncomeStatement(symbol) {
  let { cookie, crumb } = await getYahooCookieCrumb();
  let json;
  try {
    json = await requestTimeseries(symbol, cookie, crumb);
  } catch (e) {
    if (e.status !== 401) throw e;
    ({ cookie, crumb } = await getYahooCookieCrumb(true));
    json = await requestTimeseries(symbol, cookie, crumb);
  }

  const results = json?.timeseries?.result || [];
  const revenueRows = results.find((r) => r.meta?.type?.[0] === "quarterlyTotalRevenue")?.quarterlyTotalRevenue || [];
  const profitRows = results.find((r) => r.meta?.type?.[0] === "quarterlyOperatingIncome")?.quarterlyOperatingIncome || [];

  const profitByDate = new Map();
  profitRows.forEach((r) => {
    if (r && r.asOfDate && typeof r.reportedValue?.raw === "number") {
      profitByDate.set(r.asOfDate, r.reportedValue.raw);
    }
  });

  const quarters = revenueRows
    .filter((r) => r && r.asOfDate && typeof r.reportedValue?.raw === "number" && profitByDate.has(r.asOfDate))
    .map((r) => {
      const yyyymm = r.asOfDate.slice(0, 4) + r.asOfDate.slice(5, 7);
      return {
        yyyymm,
        label: formatQuarterLabel(yyyymm),
        revenue: r.reportedValue.raw,
        operatingProfit: profitByDate.get(r.asOfDate),
      };
    })
    .sort((a, b) => a.yyyymm.localeCompare(b.yyyymm)); // 오래된 분기 → 최신 분기 순(국내와 동일 규약)

  return quarters;
}

module.exports = { fetchOverseasIncomeStatement };
