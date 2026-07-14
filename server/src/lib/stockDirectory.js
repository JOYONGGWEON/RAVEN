const iconv = require("iconv-lite");

// 토스증권 API는 종목코드를 알아야만 조회 가능(이름 검색 불가)이라,
// 한국거래소 KIND(상장공시시스템)의 공개 상장법인 목록으로 이름↔코드 매핑을 자체 구축함.
const KIND_URL =
  "https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=13";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 상장 목록은 자주 안 바뀌므로 하루 캐시

let cache = null; // { list: [{name, code, market}], byCode: Map, fetchedAt }

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

    if (!/^\d{6}$/.test(code)) continue; // 헤더 행 등 데이터가 아닌 행 제외

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
}

async function searchStocksByName(query, limit = 20) {
  const q = (query || "").trim();
  if (!q) return [];
  const { list } = await loadDirectory();
  return list.filter((s) => s.name.includes(q)).slice(0, limit);
}

async function getStockNameByCode(code) {
  const { byCode } = await loadDirectory();
  return byCode.get(code)?.name || null;
}

module.exports = { searchStocksByName, getStockNameByCode };
