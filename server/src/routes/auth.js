const express = require("express");
const router = express.Router();

// 4자리 PIN은 경우의 수가 10000개뿐이라 무차별 대입에 취약함.
// IP별로 실패 횟수를 세어 짧게 잠그는 최소한의 방어 장치.
const MAX_ATTEMPTS = 5;
const LOCK_MS = 60 * 1000;
const attempts = new Map(); // ip -> { count, lockedUntil }

router.post("/verify-pin", (req, res) => {
  const ip = req.ip;
  const now = Date.now();
  const entry = attempts.get(ip) || { count: 0, lockedUntil: 0 };

  if (entry.lockedUntil > now) {
    const waitSec = Math.ceil((entry.lockedUntil - now) / 1000);
    return res.status(429).json({ ok: false, error: `too many attempts, wait ${waitSec}s` });
  }

  const { pin } = req.body || {};
  const correct = typeof pin === "string" && pin === process.env.RAVEN_PIN;

  if (correct) {
    attempts.delete(ip);
    return res.json({ ok: true });
  }

  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOCK_MS;
    entry.count = 0;
  }
  attempts.set(ip, entry);

  res.status(401).json({ ok: false });
});

module.exports = router;
