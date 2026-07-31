// Yahoo Finance의 quoteSummary/fundamentals-timeseries류 엔드포인트(회사프로필·재무제표 등)는
// 2024년경부터 "크럼(crumb) + 쿠키" 인증을 요구하도록 바뀜(무인증 호출 시 "Invalid Crumb" 401) —
// [[project_raven_trading_app]]에 이미 기록된 quoteSummary 401 이슈와 같은 원인. chart 엔드포인트는
// 이 인증이 필요 없어서 그동안 문제가 없었음.
//
// 실측으로 확인한 발급 절차: ①https://fc.yahoo.com 에 접속하면 쿠키(A3 등)가 내려옴 ②그 쿠키를 들고
// https://query1.finance.yahoo.com/v1/test/getcrumb 를 호출하면 크럼 문자열을 줌 ③이후 실제 데이터
// 요청 시 쿠키 헤더 + crumb 쿼리파라미터를 같이 보내야 통과됨.
//
// KIS 토큰(kisAuth.js)과 같은 패턴 — 메모리 캐시 + 동시 요청 시 진행 중인 발급 Promise 공유.
// 다만 이 크럼은 KIS처럼 "1분당1회" 같은 엄격한 발급 제한은 없는 것으로 보여 DB 영속화는 생략함
// (Render 재시작 시 한 번 더 발급받는 정도의 비용만 있음).

let cached = null; // { cookie, crumb }
let inFlightFetch = null;

async function fetchCookieAndCrumb() {
  const cookieRes = await fetch("https://fc.yahoo.com", {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  const setCookie = cookieRes.headers.get("set-cookie") || "";
  // set-cookie 헤더에서 "이름=값" 부분만 뽑아 Cookie 헤더로 재사용 (Domain/Path/Expires 등 속성 제외)
  const cookie = setCookie.split(";")[0];
  if (!cookie) throw new Error("Yahoo 쿠키 발급 실패 (set-cookie 없음)");

  const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      cookie,
    },
  });
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.includes("<")) throw new Error(`Yahoo 크럼 발급 실패: ${crumb.slice(0, 100)}`);

  return { cookie, crumb };
}

async function getYahooCookieCrumb(forceRefresh = false) {
  if (cached && !forceRefresh) return cached;
  if (inFlightFetch) return inFlightFetch;

  inFlightFetch = (async () => {
    try {
      cached = await fetchCookieAndCrumb();
      return cached;
    } finally {
      inFlightFetch = null;
    }
  })();

  return inFlightFetch;
}

module.exports = { getYahooCookieCrumb };
