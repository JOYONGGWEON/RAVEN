const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const express = require("express");
const cors = require("cors");

const yahooRoutes = require("./routes/yahoo");
const authRoutes = require("./routes/auth");
const tossRoutes = require("./routes/toss");
const stocksRoutes = require("./routes/stocks");
const kisRoutes = require("./routes/kis");
const watchlistRoutes = require("./routes/watchlist");
const aiRoutes = require("./routes/ai");
const { startScheduler } = require("./scheduler");

const app = express();
const PORT = process.env.PORT || 3001;

// FRONTEND_ORIGIN은 콤마로 여러 origin을 받을 수 있음 (로컬 개발용 localhost:5500 +
// 실제 배포된 GitHub Pages 주소를 동시에 허용하기 위함)
const allowedOrigins = (process.env.FRONTEND_ORIGIN || "*")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin:
      allowedOrigins.includes("*")
        ? "*"
        : (origin, callback) => {
            if (!origin || allowedOrigins.includes(origin)) callback(null, true);
            else callback(new Error("Not allowed by CORS"));
          },
  })
);
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/yahoo", yahooRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/toss", tossRoutes);
app.use("/api/stocks", stocksRoutes);
app.use("/api/kis", kisRoutes);
app.use("/api/watchlist", watchlistRoutes);
app.use("/api/ai", aiRoutes);

app.listen(PORT, () => {
  console.log(`[RAVEN] server listening on port ${PORT}`);
  startScheduler();
});
