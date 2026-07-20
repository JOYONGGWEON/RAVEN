const TELEGRAM_API_BASE = "https://api.telegram.org";

async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn("[RAVEN] 텔레그램 미설정(TELEGRAM_BOT_TOKEN/CHAT_ID) — 알림 스킵");
    return { ok: false, skipped: true };
  }

  const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  const json = await res.json();
  if (!res.ok || !json.ok) {
    throw new Error(`Telegram sendMessage failed: ${JSON.stringify(json)}`);
  }
  return { ok: true };
}

module.exports = { sendTelegramMessage };
