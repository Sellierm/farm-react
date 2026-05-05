require("dotenv").config({ path: `${__dirname}/.env` });

const bcrypt = require("bcrypt");
const mysql = require("mysql2");
const express = require("express");
const path = require("path");
const fetch = require("node-fetch");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const http = require("http");
const crypto = require("crypto");
const validator = require("validator");
const cors = require("cors");
const fs = require("fs");
const helmet = require("helmet");
const session = require("express-session");

const sencrop = require("./modules/sencropModule");
const bd = require("./modules/bdModule");
const map = require("./modules/mapModule");
const forecast = require("./modules/forecastModule");

const app = express();
const server = http.Server(app);

// Runtime settings: works locally and on alwaysdata.
const IS_PROD = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT || 4200);
const HOST = process.env.IP || process.env.HOST || "0.0.0.0";
const ALLOWED_ORIGINS = (
  process.env.CORS_ORIGINS || "http://localhost:5173,http://localhost:4200"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const CORS_ALLOWED_SUFFIX = (
  process.env.CORS_ALLOWED_SUFFIX || ".alwaysdata.net"
).trim();

const GPS_INGEST_KEY = process.env.GPS_INGEST_KEY;
const GPS_ALLOWED_IDS = (process.env.GPS_ALLOWED_IDS || "6290,7724")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

// Keep server booting even if env is incomplete, but warn clearly.
const sessionSecret =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET) {
  console.warn(
    "[WARN] SESSION_SECRET is missing. Generated temporary secret for this process.",
  );
}

const connection = mysql.createPool({
  host: bd.host,
  user: bd.user,
  password: bd.password,
  database: bd.database,
});

// Session cookie used by both REST API and Socket.IO auth.
const sessionMiddleware = session({
  name: "sid",
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: 2 * 60 * 60 * 1000,
    secure: IS_PROD,
    sameSite: IS_PROD ? "strict" : "lax",
    httpOnly: true,
  },
});

function isOriginAllowed(origin, requestHost = "") {
  if (!origin) return true;

  if (ALLOWED_ORIGINS.includes(origin)) return true;

  try {
    const originUrl = new URL(origin);
    if (requestHost) {
      const normalizedHost = requestHost.split(":")[0];
      if (originUrl.hostname === normalizedHost) return true;
    }
    if (
      CORS_ALLOWED_SUFFIX &&
      originUrl.hostname.endsWith(CORS_ALLOWED_SUFFIX)
    ) {
      return true;
    }
  } catch (error) {
    return false;
  }

  return false;
}

// Socket server shares the same HTTP server and CORS policy as Express.
const io = require("socket.io")(server, {
  cors: {
    origin: (origin, callback) => callback(null, isOriginAllowed(origin)),
    methods: ["GET", "POST"],
    credentials: true,
  },
});

function ensureCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }
  return req.session.csrfToken;
}

function safeTokenEquals(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function isSameOriginRequest(req) {
  const origin = req.get("origin");
  const host = req.get("x-forwarded-host") || req.get("host") || "";
  if (!origin || !host) return false;

  try {
    const originUrl = new URL(origin);
    const normalizedHost = host.split(":")[0];
    return originUrl.hostname === normalizedHost;
  } catch (error) {
    return false;
  }
}

function csrfProtection(req, res, next) {
  // Only protect state-changing routes.
  const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  if (!unsafeMethods.has(req.method)) {
    return next();
  }

  // GPS ingest endpoint is authenticated with a dedicated device key.
  if (req.path === "/api/location") {
    return next();
  }

  // If user is not authenticated, let authMiddleware return 401 on protected routes.
  // This avoids returning a misleading CSRF 403 when session is missing/expired.
  if (!req.session?.username) {
    return next();
  }

  const requestToken =
    req.get("x-csrf-token") ||
    req.get("x-xsrf-token") ||
    req.get("csrf-token") ||
    req.body?._csrf ||
    req.body?.csrfToken;
  const sessionToken = req.session?.csrfToken;

  if (!safeTokenEquals(requestToken, sessionToken)) {
    if (isSameOriginRequest(req)) {
      return next();
    }
    return res.status(403).json({
      success: false,
      message: "Invalid CSRF token",
      code: "CSRF_INVALID",
    });
  }
  return next();
}

// Formate et affiche un log d'accès avec horodatage, IP et action.
function authLog(ip, level, message) {
  const ts = new Date().toISOString();
  const tag =
    level === "OK"
      ? "\x1b[32m[OK]\x1b[0m"
      : level === "FAIL"
        ? "\x1b[31m[FAIL]\x1b[0m"
        : "\x1b[33m[INFO]\x1b[0m";
  console.log(`${ts} ${tag} [${ip}] ${message}`);
}

const authMiddleware = (req, res, next) => {
  if (req.session.username) {
    next();
  } else {
    res.status(401).json({ success: false, message: "Unauthorized" });
  }
};

const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again later.",
});

const locationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many location updates from this IP, please slow down.",
});

if (IS_PROD) {
  app.set("trust proxy", 1);
}

// Security headers with content security policy.
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "maps.googleapis.com", "maps.gstatic.com"],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://fonts.googleapis.com",
          "https://use.fontawesome.com",
          "https://www.google.com/maps/d",
          "https://api.sencrop.com/v1",
        ],
        imgSrc: [
          "'self'",
          "data:",
          "blob:",
          "*.googleapis.com",
          "*.gstatic.com",
          "*.google.com",
          "https://openweathermap.org",
        ],
        connectSrc: [
          "'self'",
          "*.googleapis.com",
          "wss:",
          "ws:",
          "https://www.google.com",
          "https://api.sencrop.com",
        ],
        fontSrc: ["'self'", "fonts.gstatic.com", "https://use.fontawesome.com"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        workerSrc: ["blob:"],
      },
    },
  }),
);

app.use((req, res, next) => {
  const requestHost = req.get("x-forwarded-host") || req.get("host") || "";
  return cors({
    origin: (origin, callback) => {
      const allowed = isOriginAllowed(origin, requestHost);
      return callback(null, allowed);
    },
    credentials: true,
  })(req, res, next);
});

app.use((req, res, next) => {
  res.set("Cache-Control", "no-cache, private, no-store, must-revalidate");
  next();
});

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
app.use(csrfProtection);

const distPath = path.join(__dirname, "../client/dist");
if (fs.existsSync(distPath)) {
  // In production, Express serves the built React app.
  app.use(express.static(distPath));
}

app.get("/api/csrf-token", (req, res) => {
  res.json({ csrfToken: ensureCsrfToken(req) });
});

app.get("/api/check-auth", (req, res) => {
  if (req.session.username) {
    return res.json({
      authenticated: true,
      username: req.session.username,
      csrfToken: ensureCsrfToken(req),
    });
  }
  return res.json({ authenticated: false, csrfToken: ensureCsrfToken(req) });
});

app.post("/api/auth", authLimiter, function (req, res) {
  const username = req.body.username;
  const password = req.body.password;
  const clientIp = req.ip || req.socket?.remoteAddress || "unknown";

  if (!username || !password) {
    authLog(clientIp, "FAIL", `Tentative de connexion sans identifiants`);
    return res
      .status(400)
      .json({ success: false, message: "Missing credentials" });
  }

  if (
    !validator.isAlphanumeric(username) ||
    !validator.isLength(username, { min: 3, max: 10 })
  ) {
    authLog(clientIp, "FAIL", `Nom d'utilisateur invalide : "${username}"`);
    return res
      .status(401)
      .json({ success: false, message: "Invalid username" });
  }

  authLog(clientIp, "INFO", `Tentative de connexion : "${username}"`);

  connection.query(
    "SELECT password FROM user WHERE name = ?",
    [username],
    async function (error, results) {
      if (error) {
        console.error("Database query error:", error);
        return res
          .status(500)
          .json({ success: false, message: "Internal server error" });
      }
      if (results.length !== 1) {
        authLog(clientIp, "FAIL", `Utilisateur inconnu : "${username}"`);
        return res
          .status(401)
          .json({ success: false, message: "Wrong credentials" });
      }

      // Support bcrypt hashes (new) and SHA-512 hashes (legacy migration).
      let passwordValid = false;
      const storedHash = results[0].password;
      const isBcrypt =
        typeof storedHash === "string" && storedHash.startsWith("$2");

      if (isBcrypt) {
        try {
          passwordValid = await bcrypt.compare(password, storedHash);
        } catch (bcryptErr) {
          console.error("bcrypt compare error:", bcryptErr);
        }
      } else {
        // Legacy SHA-512 path: compare, then silently rehash with bcrypt.
        const legacyHash = crypto
          .createHash("sha512")
          .update(password)
          .digest("hex");
        if (legacyHash === storedHash) {
          passwordValid = true;
          try {
            const newHash = await bcrypt.hash(password, 12);
            connection.query(
              "UPDATE user SET password=? WHERE name=?",
              [newHash, username],
              (upgradeErr) => {
                if (upgradeErr)
                  console.error("Password upgrade error:", upgradeErr);
                else
                  authLog(
                    clientIp,
                    "INFO",
                    `Mot de passe migré bcrypt : "${username}"`,
                  );
              },
            );
          } catch (hashErr) {
            console.error("bcrypt hash error:", hashErr);
          }
        }
      }

      if (!passwordValid) {
        authLog(
          clientIp,
          "FAIL",
          `Mot de passe incorrect pour : "${username}"`,
        );
        return res
          .status(401)
          .json({ success: false, message: "Wrong credentials" });
      }

      req.session.regenerate(async (regenError) => {
        if (regenError) {
          console.error("Session regeneration error:", regenError);
          return res
            .status(500)
            .json({ success: false, message: "Internal server error" });
        }

        req.session.username = username;
        req.session.csrfToken = crypto.randomBytes(32).toString("hex");
        authLog(clientIp, "OK", `Connexion réussie : "${username}"`);

        const crypt = Buffer.from(
          sencrop.applicationId + ":" + sencrop.applicationSecret,
        ).toString("base64");

        try {
          const response = await fetch(`${sencrop.endPoint}/oauth2/token`, {
            method: "POST",
            body: JSON.stringify({
              grant_type: "client_credentials",
              scope: "user",
            }),
            headers: {
              Authorization: `Basic ${crypt}`,
              "Content-Type": "application/json",
            },
          });
          const data = await response.json();
          sencrop.accessToken = data.access_token;
        } catch (err) {
          console.error("Sencrop auth error:", err);
        }

        return res.status(200).json({
          success: true,
          csrfToken: req.session.csrfToken,
        });
      });
    },
  );
});

app.post("/api/logout", function (req, res) {
  if (!req.session) {
    return res.json({ success: true });
  }

  const logoutUser = req.session.username || "inconnu";
  const clientIp = req.ip || req.socket?.remoteAddress || "unknown";

  req.session.destroy(() => {
    authLog(clientIp, "INFO", `Déconnexion : "${logoutUser}"`);
    res.clearCookie("sid");
    res.json({ success: true });
  });
});

app.get("/api/config", authMiddleware, function (req, res) {
  res.json({ googleMapsApiKey: map.key });
});

app.get("/api/forecast", authMiddleware, async function (req, res) {
  try {
    const result = await fetchForecastData();
    res.json(result);
  } catch (error) {
    console.error("Error fetching forecast data:", error);
    res.status(500).json({ error: "Error fetching forecast data" });
  }
});

function readJsonFileSafe(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const content = fs.readFileSync(filePath, "utf8");
    if (!content || !content.trim()) return fallback;
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch (error) {
    return fallback;
  }
}

function writeJsonFileSafe(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

// ── In-memory store (remplace les lectures disque à chaque requête) ──────────
let positionsMemory = {}; // latest positions
let historyMemory = {}; // 24h history
let memoryLoaded = false;
let dirtyPositions = false;
let dirtyHistory = false;

// Charger une fois au démarrage
function loadMemoryFromDisk() {
  const locationsFilePath = path.join(__dirname, "latest_positions.json");
  const historyFilePath = path.join(__dirname, "location_history.json");
  positionsMemory = readJsonFileSafe(locationsFilePath, {});
  historyMemory = readJsonFileSafe(historyFilePath, {});
  memoryLoaded = true;
  console.log("[GPS] Mémoire chargée depuis disque");
}

function startDiskPersistence() {
  setInterval(() => {
    if (dirtyPositions) {
      const locationsFilePath = path.join(__dirname, "latest_positions.json");
      fs.writeFile(
        locationsFilePath,
        JSON.stringify(positionsMemory, null, 2),
        "utf8",
        (err) => {
          if (err)
            console.error("[GPS] Erreur écriture positions:", err.message);
        },
      );
      dirtyPositions = false;
    }

    if (dirtyHistory) {
      const historyFilePath = path.join(__dirname, "location_history.json");
      // Nettoyage 24h avant d'écrire
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const deviceId of Object.keys(historyMemory)) {
        historyMemory[deviceId] = (historyMemory[deviceId] || []).filter(
          (point) => {
            const t = new Date(point.timestamp).getTime();
            return Number.isFinite(t) && t >= cutoff;
          },
        );
      }
      fs.writeFile(
        historyFilePath,
        JSON.stringify(historyMemory, null, 2),
        "utf8",
        (err) => {
          if (err)
            console.error("[GPS] Erreur écriture historique:", err.message);
        },
      );
      dirtyHistory = false;
    }
  }, 10_000); // écriture disque toutes les 10s seulement
}

loadMemoryFromDisk();
startDiskPersistence();
app.post("/api/location", locationLimiter, function (req, res) {
  try {
    const {
      latitude,
      longitude,
      id,
      timestamp,
      key,
      source,
      altitude,
      accuracy,
      speed,
      heading,
    } = req.body;

    // Validation clé
    if (!GPS_INGEST_KEY) {
      return res
        .status(500)
        .json({ success: false, message: "GPS_INGEST_KEY is not configured" });
    }

    const keyStr = typeof key === "string" ? key : "";
    const expectedKey = GPS_INGEST_KEY || "";
    const keyBuf = Buffer.from(keyStr, "utf8");
    const expectedBuf = Buffer.from(expectedKey, "utf8");
    const keyValid =
      keyBuf.length === expectedBuf.length &&
      keyBuf.length > 0 &&
      crypto.timingSafeEqual(keyBuf, expectedBuf);

    if (!keyValid || !GPS_ALLOWED_IDS.includes(String(id))) {
      return res
        .status(401)
        .json({ success: false, message: "Unauthorized: invalid payload" });
    }

    if (latitude === undefined || longitude === undefined || !timestamp) {
      return res
        .status(400)
        .json({ success: false, message: "Missing required fields" });
    }

    if (
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid coordinates" });
    }

    const deviceId = String(id || "0");

    const newPoint = {
      latitude,
      longitude,
      timestamp,
      device_id: deviceId,
      updated_at: new Date().toISOString(),
      source: source || "unknown",
      altitude: altitude !== undefined ? altitude : null,
      accuracy: accuracy !== undefined ? accuracy : null,
      speed: speed !== undefined ? speed : null,
      heading: heading !== undefined ? heading : null,
    };

    io.emit("location_update", newPoint);
    res.status(200).json({ success: true });

    positionsMemory[deviceId] = newPoint;
    dirtyPositions = true;

    if (!Array.isArray(historyMemory[deviceId])) historyMemory[deviceId] = [];
    const history = historyMemory[deviceId];
    const last = history.length ? history[history.length - 1] : null;
    const isDuplicate =
      last &&
      String(last.timestamp) === String(newPoint.timestamp) &&
      Number(last.latitude) === Number(newPoint.latitude) &&
      Number(last.longitude) === Number(newPoint.longitude);

    if (!isDuplicate) {
      history.push(newPoint);
      dirtyHistory = true;
    }

    console.log(
      `[LOCATION] device:${deviceId} | source:${source} | lat:${latitude} | lon:${longitude}`,
    );
  } catch (error) {
    console.error("[LOCATION] Erreur interne:", error);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ success: false, message: "Internal server error" });
    }
  }
});

app.get("/api/latest-positions", authMiddleware, function (req, res) {
  return res.status(200).json({ success: true, positions: positionsMemory });
});

app.get("/api/positions-history", authMiddleware, function (req, res) {
  const requestedHours = Number(req.query.hours);
  const hours =
    Number.isFinite(requestedHours) && requestedHours > 0
      ? Math.min(requestedHours, 168)
      : 24;

  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const filtered = {};
  for (const deviceId of Object.keys(historyMemory)) {
    filtered[deviceId] = (historyMemory[deviceId] || []).filter((point) => {
      const t = new Date(point.timestamp).getTime();
      return Number.isFinite(t) && t >= cutoff;
    });
  }
  return res.status(200).json({ success: true, positions: filtered, hours });
});

const fetchSencropData = async (url) => {
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${sencrop.accessToken}` },
    });
    return await r.json();
  } catch (err) {
    console.error(err);
    return { success: false };
  }
};

// Forecast data consumed by the React forecast page.
const fetchForecastData = async () => {
  try {
    const r = await fetch(
      `https://api.openweathermap.org/data/3.0/onecall?lat=${forecast.latitude}&lon=${forecast.longitude}&exclude=current,minutely,alerts&appid=${forecast.key}&units=metric`,
    );
    return await r.json();
  } catch (error) {
    console.error("Error fetching weather data:", error.message);
    return {};
  }
};

// Reject Socket.IO clients without an authenticated session.
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, () => {
    if (socket.request.session?.username) {
      return next();
    }
    return next(new Error("Unauthorized"));
  });
});

// Real-time endpoints used by Sencrop/Fields pages.
io.on("connection", (socket) => {
  const socketUser = socket.request.session?.username || "inconnu";
  const socketIp = socket.handshake.address || "unknown";
  authLog(
    socketIp,
    "INFO",
    `Socket connecté : "${socketUser}" (id: ${socket.id})`,
  );

  socket.on("disconnect", (reason) => {
    authLog(
      socketIp,
      "INFO",
      `Socket déconnecté : "${socketUser}" (id: ${socket.id}, raison: ${reason})`,
    );
  });

  // Allowed Sencrop measure names — whitelist to prevent API parameter injection.
  const VALID_MEASURES = new Set([
    "TEMPERATURE",
    "TEMPERATURE_MIN",
    "TEMPERATURE_MAX",
    "RAIN_FALL",
    "RELATIVE_HUMIDITY",
    "WET_TEMPERATURE",
    "WIND_SPEED",
    "WIND_GUST",
    "WIND_DIRECTION",
  ]);

  // ISO-8601 date-time pattern accepted by the Sencrop API.
  const VALID_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  function sanitizeDate(value) {
    return typeof value === "string" && VALID_DATE_RE.test(value)
      ? value
      : null;
  }

  function sanitizeMeasures(value) {
    if (typeof value !== "string") return null;
    const parts = value.split(",").map((p) => p.trim());
    return parts.every((p) => VALID_MEASURES.has(p)) ? parts.join(",") : null;
  }

  socket.on("askPlan", (value) => {
    const year = Number(value);
    const idx = Math.max(0, Math.min(map.table.length - 1, year - 2022));
    socket.emit("getPlan", map.table[idx]);
  });

  socket.on("askDataR1", (startDate, measures) => {
    const date = sanitizeDate(startDate);
    const meas = sanitizeMeasures(measures);
    if (!date || !meas) return;
    const url = `${sencrop.endPoint}/users/${sencrop.userId}/devices/${sencrop.raincropEarlId}/data/hourly?beforeDate=${date}&days=1&measures=${meas}`;
    fetchSencropData(url).then((result) => {
      if (result && result.measures)
        socket.emit("getDataR1", result.measures.data, meas);
    });
  });

  socket.on("askDataR2", (startDate, measures) => {
    const date = sanitizeDate(startDate);
    const meas = sanitizeMeasures(measures);
    if (!date || !meas) return;
    const url = `${sencrop.endPoint}/users/${sencrop.userId}/devices/${sencrop.raincropEarlId}/data/raw?size=100&beforeDate=${date}&days=1&measures=${meas}`;
    fetchSencropData(url).then((result) => {
      if (result) socket.emit("getDataR2", result, meas);
    });
  });

  socket.on("askDataW1", (startDate, measures) => {
    const date = sanitizeDate(startDate);
    const meas = sanitizeMeasures(measures);
    if (!date || !meas) return;
    const url = `${sencrop.endPoint}/users/${sencrop.userId}/devices/${sencrop.windcropEarlId}/data/hourly?beforeDate=${date}&days=1&measures=${meas}&patched=true`;
    fetchSencropData(url).then((result) => {
      if (result && result.measures)
        socket.emit("getDataW1", result.measures.data, meas);
    });
  });

  socket.on("askDataW2", (startDate, measures) => {
    const date = sanitizeDate(startDate);
    const meas = sanitizeMeasures(measures);
    if (!date || !meas) return;
    const url = `${sencrop.endPoint}/users/${sencrop.userId}/devices/${sencrop.windcropEarlId}/data/raw?size=500&beforeDate=${date}&days=1&measures=${meas}`;
    fetchSencropData(url).then((result) => {
      if (result) socket.emit("getDataW2", result, meas);
    });
  });

  socket.on("askRain", (startDate, duration) => {
    const date = sanitizeDate(startDate);
    const days = Math.max(1, Math.min(365, Number(duration)));
    if (!date || !Number.isFinite(days)) return;
    const url = `${sencrop.endPoint}/users/${sencrop.userId}/devices/${sencrop.raincropEarlId}/data/daily?beforeDate=${date}&days=${days}&measures=RAIN_FALL&patched=true`;
    fetchSencropData(url).then((result) => {
      if (result && result.measures) {
        let sum = 0;
        for (const i in result.measures.data)
          sum += result.measures.data[i].RAIN_FALL;
        socket.emit("getRain", sum);
      }
    });
  });

  socket.on("forceDisconnect", () => socket.disconnect(true));
});

// ── Phyto Management ───────────────────────────────────────────────────────

// GET all phyto products
app.get("/api/phyto/products", authMiddleware, (req, res) => {
  connection.query(
    "SELECT * FROM phyto_products ORDER BY name ASC",
    (err, results) => {
      if (err) {
        console.error("Error fetching products:", err);
        return res
          .status(500)
          .json({ success: false, message: "Error fetching products" });
      }
      res.json(results || []);
    },
  );
});

// POST create phyto product
app.post("/api/phyto/products", authMiddleware, (req, res) => {
  const { name, category, stock, unit, notes } = req.body;

  if (!name) {
    return res
      .status(400)
      .json({ success: false, message: "Product name is required" });
  }

  connection.query(
    "INSERT INTO phyto_products (name, category, stock, unit, notes) VALUES (?, ?, ?, ?, ?)",
    [name, category || "Autre", stock || 0, unit || "L", notes || ""],
    (err, results) => {
      if (err) {
        console.error("Error creating product:", err);
        return res
          .status(500)
          .json({ success: false, message: "Error creating product" });
      }
      res.status(201).json({
        success: true,
        id: results.insertId,
        message: "Product created",
      });
    },
  );
});

// PUT update phyto product
app.put("/api/phyto/products/:id", authMiddleware, (req, res) => {
  const { id } = req.params;
  const { name, category, stock, unit, notes } = req.body;

  if (!name) {
    return res
      .status(400)
      .json({ success: false, message: "Product name is required" });
  }

  connection.query(
    "UPDATE phyto_products SET name = ?, category = ?, stock = ?, unit = ?, notes = ? WHERE id = ?",
    [name, category || "Autre", stock || 0, unit || "L", notes || "", id],
    (err) => {
      if (err) {
        console.error("Error updating product:", err);
        return res
          .status(500)
          .json({ success: false, message: "Error updating product" });
      }
      res.json({ success: true, message: "Product updated" });
    },
  );
});

// DELETE phyto product
app.delete("/api/phyto/products/:id", authMiddleware, (req, res) => {
  const { id } = req.params;

  connection.query("DELETE FROM phyto_products WHERE id = ?", [id], (err) => {
    if (err) {
      console.error("Error deleting product:", err);
      return res
        .status(500)
        .json({ success: false, message: "Error deleting product" });
    }
    res.json({ success: true, message: "Product deleted" });
  });
});

// GET all phyto applications (with associated products)
app.get("/api/phyto/applications", authMiddleware, (req, res) => {
  connection.query(
    `SELECT 
      a.id,
      a.date,
      a.notes,
      a.created_at,
      a.updated_at,
      COALESCE(JSON_ARRAYAGG(
        CASE WHEN ap.id IS NOT NULL THEN JSON_OBJECT(
          'id', ap.id,
          'product_id', ap.product_id,
          'product_name', p.name,
          'quantity_used', ap.quantity_used
        ) END
      ), JSON_ARRAY()) as products
    FROM phyto_applications a
    LEFT JOIN phyto_application_products ap ON a.id = ap.application_id
    LEFT JOIN phyto_products p ON ap.product_id = p.id
    GROUP BY a.id
    ORDER BY a.date DESC`,
    (err, results) => {
      if (err) {
        console.error("Error fetching applications:", err);
        return res
          .status(500)
          .json({ success: false, message: "Error fetching applications" });
      }
      res.json(results || []);
    },
  );
});

// POST create phyto application with multiple products
app.post("/api/phyto/applications", authMiddleware, (req, res) => {
  const { date, products } = req.body;

  if (!date || !Array.isArray(products) || products.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Date and at least one product are required",
    });
  }

  // Vérifier que le stock est suffisant pour chaque produit
  const productIds = products
    .filter((p) => p.quantity_used && Number(p.quantity_used) > 0)
    .map((p) => p.product_id);

  if (productIds.length === 0) {
    // Pas de produit avec quantité, continuer directement
    connection.query(
      "INSERT INTO phyto_applications (date, notes) VALUES (?, ?)",
      [date, req.body.notes || ""],
      (err, applicationResult) => {
        if (err) {
          console.error("Error creating application:", err);
          return res
            .status(500)
            .json({ success: false, message: "Error creating application" });
        }

        const applicationId = applicationResult.insertId;
        const productInserts = products.map((p) => [
          applicationId,
          p.product_id,
          p.quantity_used || null,
        ]);

        connection.query(
          "INSERT INTO phyto_application_products (application_id, product_id, quantity_used) VALUES ?",
          [productInserts],
          (err) => {
            if (err) {
              console.error("Error adding products to application:", err);
              return res.status(500).json({
                success: false,
                message: "Error adding products to application",
              });
            }
            res.status(201).json({
              success: true,
              message: "Application created successfully",
            });
          },
        );
      },
    );
    return;
  }

  connection.query(
    "SELECT id, name, stock, unit FROM phyto_products WHERE id IN (?)",
    [productIds],
    (err, existingProducts) => {
      if (err) {
        console.error("Error fetching products:", err);
        return res.status(500).json({
          success: false,
          message: "Error verifying stock",
        });
      }

      // Vérifier chaque produit
      for (const p of products) {
        if (!p.quantity_used || Number(p.quantity_used) <= 0) continue;

        const existingProduct = existingProducts.find(
          (ep) => ep.id === p.product_id,
        );
        if (!existingProduct) {
          return res.status(400).json({
            success: false,
            message: `Product with ID ${p.product_id} not found`,
          });
        }

        const availableStock = Number(existingProduct.stock || 0);
        const requestedQuantity = Number(p.quantity_used);

        if (requestedQuantity > availableStock) {
          return res.status(400).json({
            success: false,
            message: `Insufficient stock for ${existingProduct.name}. Available: ${availableStock} ${existingProduct.unit}`,
            product: existingProduct.name,
            available: availableStock,
            requested: requestedQuantity,
          });
        }
      }

      // Stock vérifié, créer l'application
      connection.query(
        "INSERT INTO phyto_applications (date, notes) VALUES (?, ?)",
        [date, req.body.notes || ""],
        (err, applicationResult) => {
          if (err) {
            console.error("Error creating application:", err);
            return res
              .status(500)
              .json({ success: false, message: "Error creating application" });
          }

          const applicationId = applicationResult.insertId;
          const productInserts = products.map((p) => [
            applicationId,
            p.product_id,
            p.quantity_used || null,
          ]);

          connection.query(
            "INSERT INTO phyto_application_products (application_id, product_id, quantity_used) VALUES ?",
            [productInserts],
            (err) => {
              if (err) {
                console.error("Error adding products to application:", err);
                return res.status(500).json({
                  success: false,
                  message: "Error adding products to application",
                });
              }

              // Décrémenter le stock pour chaque produit utilisé
              const updateStockQueries = products
                .filter((p) => p.quantity_used)
                .map((p) => ({
                  sql: "UPDATE phyto_products SET stock = stock - ? WHERE id = ?",
                  values: [Number(p.quantity_used), p.product_id],
                }));

              if (updateStockQueries.length === 0) {
                return res.status(201).json({
                  success: true,
                  id: applicationId,
                  message: "Application created",
                });
              }

              let completed = 0;
              updateStockQueries.forEach((query) => {
                connection.query(query.sql, query.values, (err) => {
                  if (err) console.error("Error updating stock:", err);
                  completed++;
                  if (completed === updateStockQueries.length) {
                    res.status(201).json({
                      success: true,
                      id: applicationId,
                      message: "Application created",
                    });
                  }
                });
              });
            },
          );
        },
      );
    },
  );
});

// PUT update phyto application
app.put("/api/phyto/applications/:id", authMiddleware, (req, res) => {
  const { id } = req.params;
  const { date, notes, products } = req.body;

  if (!date || !Array.isArray(products) || products.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Date and at least one product are required",
    });
  }

  // Récupérer les anciens produits pour augmenter leurs stocks
  connection.query(
    "SELECT product_id, quantity_used FROM phyto_application_products WHERE application_id = ?",
    [id],
    (err, oldProducts) => {
      if (err) {
        console.error("Error fetching old products:", err);
        return res.status(500).json({
          success: false,
          message: "Error updating application",
        });
      }

      // Augmenter le stock des anciens produits
      const restoreStockQueries = (oldProducts || [])
        .filter((p) => p.quantity_used)
        .map((p) => ({
          sql: "UPDATE phyto_products SET stock = stock + ? WHERE id = ?",
          values: [p.quantity_used, p.product_id],
        }));

      // Mettre à jour l'application
      connection.query(
        "UPDATE phyto_applications SET date = ?, notes = ? WHERE id = ?",
        [date, notes || "", id],
        (err) => {
          if (err) {
            console.error("Error updating application:", err);
            return res
              .status(500)
              .json({ success: false, message: "Error updating application" });
          }

          // Supprimer les anciens produits
          connection.query(
            "DELETE FROM phyto_application_products WHERE application_id = ?",
            [id],
            (err) => {
              if (err) {
                console.error("Error deleting old products:", err);
                return res.status(500).json({
                  success: false,
                  message: "Error updating application products",
                });
              }

              // Insérer les nouveaux produits
              const productInserts = products.map((p) => [
                id,
                p.product_id,
                p.quantity_used || null,
              ]);

              connection.query(
                "INSERT INTO phyto_application_products (application_id, product_id, quantity_used) VALUES ?",
                [productInserts],
                (err) => {
                  if (err) {
                    console.error("Error adding products:", err);
                    return res.status(500).json({
                      success: false,
                      message: "Error updating application products",
                    });
                  }

                  // Exécuter les restaurations de stock
                  if (restoreStockQueries.length === 0) {
                    // Décrémenter les nouveaux produits
                    const newDecrementQueries = products
                      .filter((p) => p.quantity_used)
                      .map((p) => ({
                        sql: "UPDATE phyto_products SET stock = stock - ? WHERE id = ?",
                        values: [Number(p.quantity_used), p.product_id],
                      }));

                    if (newDecrementQueries.length === 0) {
                      return res.json({
                        success: true,
                        message: "Application updated",
                      });
                    }

                    let completed = 0;
                    newDecrementQueries.forEach((query) => {
                      connection.query(query.sql, query.values, (err) => {
                        if (err) console.error("Error updating stock:", err);
                        completed++;
                        if (completed === newDecrementQueries.length) {
                          res.json({
                            success: true,
                            message: "Application updated",
                          });
                        }
                      });
                    });
                  } else {
                    let restoreCompleted = 0;
                    restoreStockQueries.forEach((query) => {
                      connection.query(query.sql, query.values, (err) => {
                        if (err) console.error("Error restoring stock:", err);
                        restoreCompleted++;
                        if (restoreCompleted === restoreStockQueries.length) {
                          // Décrémenter les nouveaux produits
                          const newDecrementQueries = products
                            .filter((p) => p.quantity_used)
                            .map((p) => ({
                              sql: "UPDATE phyto_products SET stock = stock - ? WHERE id = ?",
                              values: [Number(p.quantity_used), p.product_id],
                            }));

                          if (newDecrementQueries.length === 0) {
                            return res.json({
                              success: true,
                              message: "Application updated",
                            });
                          }

                          let decrementCompleted = 0;
                          newDecrementQueries.forEach((query) => {
                            connection.query(query.sql, query.values, (err) => {
                              if (err)
                                console.error("Error updating stock:", err);
                              decrementCompleted++;
                              if (
                                decrementCompleted ===
                                newDecrementQueries.length
                              ) {
                                res.json({
                                  success: true,
                                  message: "Application updated",
                                });
                              }
                            });
                          });
                        }
                      });
                    });
                  }
                },
              );
            },
          );
        },
      );
    },
  );
});

// DELETE phyto application
app.delete("/api/phyto/applications/:id", authMiddleware, (req, res) => {
  const { id } = req.params;
  const restoreStock = req.query.restoreStock === "true";

  // Récupérer les produits de l'application pour augmenter leurs stocks
  connection.query(
    "SELECT product_id, quantity_used FROM phyto_application_products WHERE application_id = ?",
    [id],
    (err, products) => {
      if (err) {
        console.error("Error fetching products:", err);
        return res.status(500).json({
          success: false,
          message: "Error deleting application",
        });
      }

      // Supprimer l'application (les produits seront aussi supprimés via cascade)
      connection.query(
        "DELETE FROM phyto_applications WHERE id = ?",
        [id],
        (err) => {
          if (err) {
            console.error("Error deleting application:", err);
            return res
              .status(500)
              .json({ success: false, message: "Error deleting application" });
          }

          // Si restoreStock est false, ne pas augmenter le stock
          if (!restoreStock) {
            return res.json({ success: true, message: "Application deleted" });
          }

          // Augmenter le stock pour chaque produit utilisé
          const increaseStockQueries = (products || [])
            .filter((p) => p.quantity_used)
            .map((p) => ({
              sql: "UPDATE phyto_products SET stock = stock + ? WHERE id = ?",
              values: [p.quantity_used, p.product_id],
            }));

          if (increaseStockQueries.length === 0) {
            return res.json({ success: true, message: "Application deleted" });
          }

          let completed = 0;
          increaseStockQueries.forEach((query) => {
            connection.query(query.sql, query.values, (err) => {
              if (err) console.error("Error updating stock:", err);
              completed++;
              if (completed === increaseStockQueries.length) {
                res.json({ success: true, message: "Application deleted" });
              }
            });
          });
        },
      );
    },
  );
});

// SPA fallback: any unknown route returns React index.html.
app.get("*", (req, res) => {
  const indexPath = path.join(__dirname, "../client/dist", "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res
      .status(404)
      .send("Build the React client first: cd client && npm run build");
  }
});

// Bind to host/port provided by the platform (alwaysdata) or local defaults.
server.listen(PORT, HOST, () => {
  console.log(
    `Server running on ${HOST}:${PORT} (${IS_PROD ? "prod" : "dev"})`,
  );
});

server.on("error", (error) => {
  console.error("Server failed to start:", error);
});
