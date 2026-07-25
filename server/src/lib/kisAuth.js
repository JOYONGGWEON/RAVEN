const { supabase } = require("./supabaseClient");

const TOKEN_URL = "https://openapi.koreainvestment.com:9443/oauth2/tokenP";
const TOKEN_ROW_ID = 1; // 토큰은 계정당 1개만 쓰므로 고정 행 하나만 사용

let cachedToken = null; // { accessToken, expiresAt } — 프로세스 내 캐시(DB 왕복 줄이기용)
let inFlightFetch = null; // 토큰 발급이 진행 중이면 그 Promise를 공유(동시 요청이 각자 새로 발급받으려다 1분당1회 제한에 걸리는 것 방지)

async function loadTokenFromDb() {
  const { data, error } = await supabase
    .from("kis_oauth_token")
    .select("access_token, expires_at")
    .eq("id", TOKEN_ROW_ID)
    .maybeSingle();
  if (error || !data) return null;
  return { accessToken: data.access_token, expiresAt: new Date(data.expires_at).getTime() };
}

async function saveTokenToDb(token) {
  const { error } = await supabase.from("kis_oauth_token").upsert({
    id: TOKEN_ROW_ID,
    access_token: token.accessToken,
    expires_at: new Date(token.expiresAt).toISOString(),
  });
  if (error) console.error("[RAVEN] KIS 토큰 DB 저장 실패:", error.message);
}

// KIS 접근토큰은 24시간 유효, "1일 1회 발급 원칙"이라 Render 무료 요금제가 비활성 시 재시작돼도
// 메모리 캐시만 믿으면 안 됨 — DB에도 저장해두고 재시작 후에는 거기서 먼저 재사용을 시도함.
//
// ⚠️ 시세/차트를 KIS로 옮기면서 한 번의 종목 검색에서 본종목+벤치마크(RS용) 캔들을 동시에
// 요청하게 됐는데, 토큰이 없는 상태에서 두 요청이 동시에 들어오면 둘 다 "새로 발급" 분기를
// 타면서 KIS의 "1분당1회" 제한에 걸려 하나는 실패했음(실측으로 재현). inFlightFetch로
// 발급이 진행 중이면 그 Promise를 공유해서 실제 발급 요청은 항상 1개만 나가게 함.
async function getKisAccessToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 5 * 60 * 1000) {
    return cachedToken.accessToken;
  }

  if (inFlightFetch) return inFlightFetch;

  inFlightFetch = (async () => {
    try {
      const dbToken = await loadTokenFromDb();
      if (dbToken && dbToken.expiresAt > Date.now() + 5 * 60 * 1000) {
        cachedToken = dbToken;
        return cachedToken.accessToken;
      }

      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          appkey: process.env.KIS_APP_KEY,
          appsecret: process.env.KIS_APP_SECRET,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(`KIS token request failed: ${res.status} ${JSON.stringify(json)}`);
      }

      cachedToken = {
        accessToken: json.access_token,
        expiresAt: Date.now() + (json.expires_in || 86400) * 1000,
      };
      await saveTokenToDb(cachedToken);
      return cachedToken.accessToken;
    } finally {
      inFlightFetch = null;
    }
  })();

  return inFlightFetch;
}

module.exports = { getKisAccessToken };
