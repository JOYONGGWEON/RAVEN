const TOKEN_URL = "https://openapi.tossinvest.com/oauth2/token";

let cachedToken = null; // { accessToken, expiresAt }

// OAuth2 Client Credentials 토큰은 만료 시간이 있어서 매번 새로 받지 않고
// 만료 5초 전까지는 캐시된 토큰을 재사용함.
async function getTossAccessToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 5000) {
    return cachedToken.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.TOSS_CLIENT_ID,
    client_secret: process.env.TOSS_CLIENT_SECRET,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Toss token request failed: ${res.status} ${JSON.stringify(json)}`);
  }

  cachedToken = {
    accessToken: json.access_token,
    expiresAt: now + (json.expires_in || 3600) * 1000,
  };
  return cachedToken.accessToken;
}

module.exports = { getTossAccessToken };
