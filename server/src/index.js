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

app.use(cors({ origin: process.env.FRONTEND_ORIGIN || "*" }));
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
