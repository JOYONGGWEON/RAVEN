const TOKEN_URL = "https://openapi.koreainvestment.com:9443/oauth2/tokenP";

let cachedToken = null; // { accessToken, expiresAt }

// KIS 접근토큰은 24시간 유효, 6시간 이내 재요청 시 동일 토큰 반환 원칙이라
// 만료 5분 전까지는 캐시된 토큰을 재사용함.
async function getKisAccessToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 5 * 60 * 1000) {
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
    expiresAt: now + (json.expires_in || 86400) * 1000,
  };
  return cachedToken.accessToken;
}

module.exports = { getKisAccessToken };
