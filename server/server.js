const http = require("http");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { URL } = require("url");

const PORT = process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, "..", "public");

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36",
          Accept: "application/json",
        },
      },
      (res) => {
        let body = "";

        res.on("data", (chunk) => {
          body += chunk;
        });

        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(
              new Error(
                `مزود البيانات أعاد الخطأ ${res.statusCode}.`
              )
            );
            return;
          }

          try {
            resolve(JSON.parse(body));
          } catch {
            reject(
              new Error("تعذر قراءة بيانات مزود الأسهم.")
            );
          }
        });
      }
    );

    request.on("error", reject);

    request.setTimeout(15000, () => {
      request.destroy();
      reject(
        new Error("انتهت مهلة الاتصال بمزود البيانات.")
      );
    });
  });
}

function sma(values, period) {
  if (values.length < period) {
    return null;
  }

  const recent = values.slice(-period);

  return (
    recent.reduce((sum, value) => sum + value, 0) /
    period
  );
}

function rsi(values, period = 14) {
  if (values.length <= period) {
    return 50;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = values.length - period;
    i < values.length;
    i++
  ) {
    const difference =
      values[i] - values[i - 1];

    if (difference >= 0) {
      gains += difference;
    } else {
      losses -= difference;
    }
  }

  if (losses === 0) {
    return 100;
  }

  const averageGain = gains / period;
  const averageLoss = losses / period;

  const relativeStrength =
    averageGain / averageLoss;

  return (
    100 -
    100 / (1 + relativeStrength)
  );
}

function analyze(closes) {
  const last = closes.at(-1);

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const currentRsi = rsi(closes);

  let score = 0;

  const reasons = [];

  // السعر مقابل SMA20
  if (last > sma20) {
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

  // SMA20 مقابل SMA50
  if (sma20 > sma50) {
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

  // RSI
  if (
    currentRsi >= 55 &&
    currentRsi <= 70
  ) {
    score += 20;

    reasons.push(
      `RSI عند ${currentRsi.toFixed(
        1
      )} ويدعم الزخم الإيجابي.`
    );
  } else if (
    currentRsi <= 45 &&
    currentRsi >= 30
  ) {
    score -= 20;

    reasons.push(
      `RSI عند ${currentRsi.toFixed(
        1
      )} ويشير إلى ضعف نسبي في الزخم.`
    );
  } else if (currentRsi > 70) {
    score += 5;

    reasons.push(
      `RSI عند ${currentRsi.toFixed(
        1
      )} مرتفع، لذلك تم تخفيف قوة إشارة الصعود.`
    );
  } else if (currentRsi < 30) {
    score -= 5;

    reasons.push(
      `RSI عند ${currentRsi.toFixed(
        1
      )} منخفض، لذلك تم تخفيف قوة إشارة الهبوط.`
    );
  } else {
    reasons.push(
      `RSI عند ${currentRsi.toFixed(
        1
      )} ولا يعطي أفضلية قوية.`
    );
  }

  let direction;

  if (score > 12) {
    direction = "صعود";
  } else if (score < -12) {
    direction = "هبوط";
  } else {
    direction = "غير واضح";
  }

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
  const yahooUrl = new URL(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}`
  );

  yahooUrl.searchParams.set(
    "range",
    "1y"
  );

  yahooUrl.searchParams.set(
    "interval",
    "1d"
  );

  yahooUrl.searchParams.set(
    "events",
    "div,splits"
  );

  const data = await getJson(
    yahooUrl.toString()
  );

  if (
    !data.chart ||
    !data.chart.result ||
    !data.chart.result[0]
  ) {
    throw new Error(
      "لم يتم العثور على بيانات لهذا السهم."
    );
  }

  const result =
    data.chart.result[0];

  const timestamps =
    result.timestamp || [];

  const quote =
    result.indicators &&
    result.indicators.quote &&
    result.indicators.quote[0];

  if (!quote || !quote.close) {
    throw new Error(
      "لم تصل بيانات أسعار كافية لهذا السهم."
    );
  }

  const closes = [];

  const dates = [];

  for (
    let i = 0;
    i < timestamps.length;
    i++
  ) {
    const close = quote.close[i];

    if (
      Number.isFinite(close)
    ) {
      closes.push(Number(close));

      dates.push(
        new Date(
          timestamps[i] * 1000
        )
      );
    }
  }

  if (closes.length < 55) {
    throw new Error(
      `وصلت بيانات ${closes.length} جلسة فقط، ولا توجد بيانات تاريخية كافية للتحليل.`
    );
  }

  const analysis =
    analyze(closes);

  const last =
    closes.at(-1);

  const previous =
    closes.at(-2);

  const change =
    ((last - previous) /
      previous) *
    100;

  const lastDate =
    dates.at(-1);

  return {
    symbol: symbol.toUpperCase(),

    name:
      result.meta &&
      result.meta.longName
        ? result.meta.longName
        : symbol.toUpperCase(),

    direction:
      analysis.direction,

    strength:
      Number(
        analysis.strength.toFixed(1)
      ),

    price:
      Number(last.toFixed(2)),

    change:
      Number(change.toFixed(2)),

    reasons:
      analysis.reasons,

    horizon:
      "الأيام القادمة",

    dataDate:
      lastDate
        .toISOString()
        .slice(0, 10),
  };
}

function serveStatic(req, res) {
  let pathname = new URL(
    req.url,
    `http://${req.headers.host}`
  ).pathname;

  if (pathname === "/") {
    pathname = "/index.html";
  }

  if (pathname.includes("..")) {
    res.statusCode = 400;
    res.end("Bad request");
    return;
  }

  const filePath =
    path.join(
      PUBLIC,
      pathname
    );

  fs.readFile(
    filePath,
    (error, data) => {
      if (error) {
        if (!res.headersSent) {
          res.writeHead(404);
          res.end("Not found");
        }

        return;
      }

      const extension =
        path.extname(filePath);

      const contentTypes = {
        ".html":
          "text/html; charset=utf-8",

        ".css":
          "text/css; charset=utf-8",

        ".js":
          "text/javascript; charset=utf-8",

        ".png":
          "image/png",

        ".jpg":
          "image/jpeg",

        ".jpeg":
          "image/jpeg",

        ".svg":
          "image/svg+xml",

        ".ico":
          "image/x-icon",
      };

      if (!res.headersSent) {
        res.writeHead(200, {
          "Content-Type":
            contentTypes[
              extension
            ] ||
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
      const url =
        new URL(
          req.url,
          `http://${req.headers.host}`
        );

      // فحص السيرفر
      if (
        url.pathname ===
        "/api/health"
      ) {
        res.writeHead(200, {
          "Content-Type":
            "application/json; charset=utf-8",
        });

        res.end(
          JSON.stringify({
            ok: true,
            provider:
              "Yahoo Finance",
          })
        );

        return;
      }

      // توقع السهم
      if (
        url.pathname ===
        "/api/predict"
      ) {
        res.setHeader(
          "Content-Type",
          "application/json; charset=utf-8"
        );

        try {
          const symbol =
            (
              url.searchParams.get(
                "symbol"
              ) || ""
            )
              .trim()
              .toUpperCase();

          if (
            !/^[A-Z0-9.^=-]{1,20}$/.test(
              symbol
            )
          ) {
            throw new Error(
              "اكتب رمز سهم صحيح مثل AAPL أو TSLA."
            );
          }

          const result =
            await predict(symbol);

          res.statusCode = 200;

          res.end(
            JSON.stringify(
              result
            )
          );
        } catch (error) {
          console.error(
            "Prediction error:",
            error.message
          );

          res.statusCode = 400;

          res.end(
            JSON.stringify({
              error:
                error.message ||
                "حدث خطأ غير معروف.",
            })
          );
        }

        return;
      }

      serveStatic(
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