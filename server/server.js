const http = require("http");
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const https = require("https");
const { URL } = require("url");

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.ALPHA_VANTAGE_KEY;
const PUBLIC = path.join(__dirname, "..", "public");

function getJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            "User-Agent": "SahmakAI/1.0",
          },
        },
        (res) => {
          let body = "";

          res.on("data", (c) => {
            body += c;
          });

          res.on("end", () => {
            try {
              resolve(JSON.parse(body));
            } catch {
              reject(new Error("Invalid provider response"));
            }
          });
        }
      )
      .on("error", reject);
  });
}

function sma(v, p) {
  if (v.length < p) return null;

  const a = v.slice(-p);

  return a.reduce((x, y) => x + y, 0) / p;
}

function rsi(v, p = 14) {
  if (v.length <= p) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = v.length - p; i < v.length; i++) {
    const d = v[i] - v[i - 1];

    if (d >= 0) {
      gains += d;
    } else {
      losses -= d;
    }
  }

  if (losses === 0) return 100;

  const rs = (gains / p) / (losses / p);

  return 100 - 100 / (1 + rs);
}

function analyze(closes) {
  const last = closes.at(-1);
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const r = rsi(closes);

  let score = 0;
  const reasons = [];

  if (last > s20) {
    score += 25;
    reasons.push(
      "السعر الحالي أعلى من متوسط 20 جلسة."
    );
  } else {
    score -= 25;
    reasons.push(
      "السعر الحالي أسفل متوسط 20 جلسة."
    );
  }

  if (s20 > s50) {
    score += 25;
    reasons.push(
      "متوسط 20 جلسة أعلى من متوسط 50 جلسة."
    );
  } else {
    score -= 25;
    reasons.push(
      "متوسط 20 جلسة أسفل متوسط 50 جلسة."
    );
  }

  if (r >= 55 && r <= 70) {
    score += 20;
    reasons.push(
      `RSI عند ${r.toFixed(
        1
      )} ويدعم الزخم الإيجابي دون تشبع شراء شديد.`
    );
  } else if (r <= 45 && r >= 30) {
    score -= 20;
    reasons.push(
      `RSI عند ${r.toFixed(
        1
      )} ويشير إلى ضعف نسبي في الزخم.`
    );
  } else if (r > 70) {
    score += 5;
    reasons.push(
      `RSI عند ${r.toFixed(
        1
      )} مرتفع؛ تم تخفيف قوة إشارة الصعود.`
    );
  } else if (r < 30) {
    score -= 5;
    reasons.push(
      `RSI عند ${r.toFixed(
        1
      )} منخفض؛ تم تخفيف قوة إشارة الهبوط.`
    );
  } else {
    reasons.push(
      `RSI عند ${r.toFixed(
        1
      )} ولا يعطي أفضلية قوية.`
    );
  }

  const direction =
    score > 12
      ? "صعود"
      : score < -12
      ? "هبوط"
      : "غير واضح";

  const strength = Math.min(
    95,
    50 + Math.abs(score) * 0.8
  );

  return {
    direction,
    strength,
    reasons,
  };
}

async function predict(symbol) {
  if (!API_KEY) {
    throw new Error(
      "الخادم غير مهيأ: أضف ALPHA_VANTAGE_KEY."
    );
  }

  const u = new URL(
    "https://www.alphavantage.co/query"
  );

  u.searchParams.set(
    "function",
    "TIME_SERIES_DAILY"
  );

  u.searchParams.set("symbol", symbol);
  u.searchParams.set("outputsize", "compact");
  u.searchParams.set("apikey", API_KEY);

  const data = await getJson(u);

  if (data["Error Message"]) {
    throw new Error(
      "رمز السهم غير معروف."
    );
  }

  if (data["Note"]) {
    throw new Error(
      "تم تجاوز حد طلبات مزود البيانات. حاول لاحقاً."
    );
  }

  if (data["Information"]) {
    throw new Error(
      data["Information"]
    );
  }

  const series =
    data["Time Series (Daily)"];

  if (!series) {
    console.log(
      "Alpha Vantage response:",
      JSON.stringify(data)
    );

    throw new Error(
      "مزود البيانات لم يرجع بيانات يومية لهذا السهم."
    );
  }

  const dates =
    Object.keys(series).sort();

  const closes = dates
    .map((d) =>
      Number(
        series[d]["4. close"]
      )
    )
    .filter(Number.isFinite);

  if (closes.length < 55) {
    throw new Error(
      `وصلت بيانات ${closes.length} جلسة فقط، ولا توجد بيانات تاريخية كافية للتحليل.`
    );
  }

  const a = analyze(closes);

  const last = closes.at(-1);
  const prev = closes.at(-2);

  return {
    symbol,
    name: symbol,
    direction: a.direction,
    strength: Number(
      a.strength.toFixed(1)
    ),
    price: last,
    change: Number(
      (
        ((last - prev) / prev) *
        100
      ).toFixed(2)
    ),
    reasons: a.reasons,
    horizon: "الأيام القادمة",
    dataDate: dates.at(-1),
  };
}

function serveStatic(req, res) {
  let p = new URL(
    req.url,
    `http://${req.headers.host}`
  ).pathname;

  if (p === "/") {
    p = "/index.html";
  }

  if (p.includes("..")) {
    res.statusCode = 400;
    return res.end("Bad request");
  }

  const file = path.join(
    PUBLIC,
    p
  );

  fs.readFile(
    file,
    (err, data) => {
      if (err) {
        if (!res.headersSent) {
          res.writeHead(404);
          res.end("Not found");
        }

        return;
      }

      const ext =
        path.extname(file);

      const types = {
        ".html":
          "text/html; charset=utf-8",
        ".css":
          "text/css; charset=utf-8",
        ".js":
          "text/javascript; charset=utf-8",
      };

      if (!res.headersSent) {
        res.writeHead(200, {
          "Content-Type":
            types[ext] ||
            "application/octet-stream",
        });

        res.end(data);
      }
    }
  );
}

const server =
  http.createServer(
    async (req, res) => {
      const u = new URL(
        req.url,
        `http://${req.headers.host}`
      );

      if (
        u.pathname ===
        "/api/health"
      ) {
        if (res.headersSent) return;

        res.writeHead(200, {
          "Content-Type":
            "application/json; charset=utf-8",
        });

        return res.end(
          JSON.stringify({
            ok: true,
          })
        );
      }

      if (
        u.pathname ===
        "/api/predict"
      ) {
        res.setHeader(
          "Content-Type",
          "application/json; charset=utf-8"
        );

        try {
          const symbol = (
            u.searchParams.get(
              "symbol"
            ) || ""
          )
            .trim()
            .toUpperCase();

          if (
            !/^[A-Z0-9.-]{1,15}$/.test(
              symbol
            )
          ) {
            throw new Error(
              "اكتب رمز سهم صحيح مثل TSLA أو AAPL."
            );
          }

          const result =
            await predict(symbol);

          if (res.headersSent)
            return;

          res.statusCode = 200;

          return res.end(
            JSON.stringify(
              result
            )
          );
        } catch (e) {
          if (res.headersSent)
            return;

          res.statusCode = 400;

          return res.end(
            JSON.stringify({
              error:
                e &&
                e.message
                  ? e.message
                  : "حدث خطأ غير معروف.",
            })
          );
        }
      }

      return serveStatic(
        req,
        res
      );
    }
  );

server.listen(
  PORT,
  () => {
    console.log(
      `Sahmak AI web server on port ${PORT}`
    );
  }
);