const iconv = require("iconv-lite");

// 토스증권 API는 종목코드를 알아야만 조회 가능(이름 검색 불가)이라,
// 한국거래소 KIND(상장공시시스템)의 공개 상장법인 목록으로 이름↔코드 매핑을 자체 구축함.
const KIND_URL =
  "https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=13";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 상장 목록은 자주 안 바뀌므로 하루 캐시

let cache = null; // { list: [{name, code, market}], byCode: Map, fetchedAt }
// 콜드캐시 상태에서 여러 요청이 동시에 들어오면(예: 관심종목 16개가 한 번에 시장구분 조회) KIND
// 다운로드가 중복 발생할 수 있어서, 진행중인 Promise를 공유함(kisAuth.js 토큰 발급과 동일한 패턴).
let inFlight = null;

function stripTags(html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function loadDirectory() {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await fetch(KIND_URL);
      if (!res.ok) throw new Error(`KIND corpList fetch failed: ${res.status}`);

      const buf = Buffer.from(await res.arrayBuffer());
      const html = iconv.decode(buf, "EUC-KR");

      const rows = html.match(/<tr>[\s\S]*?<\/tr>/g) || [];
      const list = [];

      for (const row of rows) {
        const cells = row.match(/<td[^>]*>[\s\S]*?<\/td>/g);
        if (!cells || cells.length < 3) continue;

        const name = stripTags(cells[0]);
        const marketRaw = stripTags(cells[1]);
        const code = stripTags(cells[2]);

        // ⚠️ 실제 버그: 순수 숫자만 걸렀는데, 스팩/최근 상장 종목 등 57개는 KRX가 알파벳 섞인 코드
        // (예: "0010F0", 보원케미칼)를 씀 — 헤더 행과 구분하기 위한 "숫자 하나 이상 포함" 조건을 유지한
        // 채로 알파벳도 허용(kisMarket.js의 isDomesticSymbol()과 동일한 정규식으로 통일).
        if (!/^(?=.*\d)[0-9A-Za-z]{6}$/.test(code)) continue; // 헤더 행 등 데이터가 아닌 행 제외

        list.push({
          name,
          code,
          market: marketRaw.includes("코스닥") ? "KOSDAQ" : "KOSPI",
        });
      }

      if (!list.length) throw new Error("KIND corpList parsed empty result");

      const byCode = new Map(list.map((s) => [s.code, s]));
      cache = { list, byCode, fetchedAt: now };
      return cache;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

async function searchStocksByName(query, limit = 20) {
  const q = (query || "").trim();
  if (!q) return [];
  const { list } = await loadDirectory();
  return list.filter((s) => s.name.includes(q)).slice(0, limit);
}

// 종목코드 → { name, market } — market은 관심종목 목록의 KOSPI/KOSDAQ 뱃지 표시용(2026-08-09 추가).
async function getStockInfoByCode(code) {
  const { byCode } = await loadDirectory();
  const entry = byCode.get(code);
  return entry ? { name: entry.name, market: entry.market } : null;
}

module.exports = { searchStocksByName, getStockInfoByCode };
