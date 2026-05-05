require("dotenv").config({ path: `${__dirname}/.env` });

const bcrypt = require("bcrypt");
const mysql = require("mysql2/promise"); // ✅ promise API
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

const IS_PROD = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT || 4200);
const HOST = process.env.IP || process.env.HOST || "0.0.0.0";
const ALLOWED_ORIGINS = (
  process.env.CORS_ORIGINS || "http://localhost:5173,http://localhost:4200"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const CORS_ALLOWED_SUFFIX = (
  process.env.CORS_ALLOWED_SUFFIX || ".alwaysdata.net"
).trim();

const GPS_INGEST_KEY = process.env.GPS_INGEST_KEY;
const GPS_ALLOWED_IDS = (process.env.GPS_ALLOWED_IDS || "6290,7724")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const sessionSecret =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET) {
  console.warn("[WARN] SESSION_SECRET manquant. Secret temporaire généré.");
}

const pool = mysql.createPool({
  host: bd.host,
  user: bd.user,
  password: bd.password,
  database: bd.database,
  waitForConnections: true,
  connectionLimit: 10,
});

// ─────────────────────────────────────────────
// GPS — store en mémoire (évite les I/O disque à chaque position)
// ─────────────────────────────────────────────

let positionsMemory = {};
let historyMemory = {};

function loadMemoryFromDisk() {
  const locationsFilePath = path.join(__dirname, "latest_positions.json");
  const historyFilePath = path.join(__dirname, "location_history.json");
  positionsMemory = readJsonFileSafe(locationsFilePath, {});
  historyMemory = readJsonFileSafe(historyFilePath, {});
  console.log("[GPS] Mémoire chargée depuis disque");
}

let dirtyPositions = false;
let dirtyHistory = false;

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
      // Nettoyage 24h avant écriture
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const deviceId of Object.keys(historyMemory)) {
        historyMemory[deviceId] = (historyMemory[deviceId] || []).filter(
          (p) => {
            const t = new Date(p.timestamp).getTime();
            return Number.isFinite(t) && t >= cutoff;
          },
        );
      }
      const historyFilePath = path.join(__dirname, "location_history.json");
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
  }, 10_000);
}

loadMemoryFromDisk();
startDiskPersistence();

// ─────────────────────────────────────────────
// Session, CORS, CSRF
// ─────────────────────────────────────────────

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
    if (CORS_ALLOWED_SUFFIX && originUrl.hostname.endsWith(CORS_ALLOWED_SUFFIX))
      return true;
  } catch {
    return false;
  }
  return false;
}

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
    return originUrl.hostname === host.split(":")[0];
  } catch {
    return false;
  }
}

function csrfProtection(req, res, next) {
  const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  if (!unsafeMethods.has(req.method)) return next();
  if (req.path === "/api/location") return next();
  if (!req.session?.username) return next();

  const requestToken =
    req.get("x-csrf-token") ||
    req.get("x-xsrf-token") ||
    req.get("csrf-token") ||
    req.body?._csrf ||
    req.body?.csrfToken;
  const sessionToken = req.session?.csrfToken;

  if (!safeTokenEquals(requestToken, sessionToken)) {
    if (isSameOriginRequest(req)) return next();
    return res.status(403).json({
      success: false,
      message: "Invalid CSRF token",
      code: "CSRF_INVALID",
    });
  }
  return next();
}

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
  if (req.session.username) return next();
  res.status(401).json({ success: false, message: "Unauthorized" });
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

if (IS_PROD) app.set("trust proxy", 1);

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
    origin: (origin, callback) =>
      callback(null, isOriginAllowed(origin, requestHost)),
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
  app.use(express.static(distPath));
}

// ─────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────

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

app.post("/api/auth", authLimiter, async (req, res) => {
  const { username, password } = req.body;
  const clientIp = req.ip || req.socket?.remoteAddress || "unknown";

  if (!username || !password) {
    authLog(clientIp, "FAIL", "Tentative de connexion sans identifiants");
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

  try {
    const [results] = await pool.execute(
      "SELECT password FROM user WHERE name = ?",
      [username],
    );

    if (results.length !== 1) {
      authLog(clientIp, "FAIL", `Utilisateur inconnu : "${username}"`);
      return res
        .status(401)
        .json({ success: false, message: "Wrong credentials" });
    }

    let passwordValid = false;
    const storedHash = results[0].password;
    const isBcrypt =
      typeof storedHash === "string" && storedHash.startsWith("$2");

    if (isBcrypt) {
      passwordValid = await bcrypt.compare(password, storedHash);
    } else {
      const legacyHash = crypto
        .createHash("sha512")
        .update(password)
        .digest("hex");
      if (legacyHash === storedHash) {
        passwordValid = true;
        // Migration silencieuse vers bcrypt
        try {
          const newHash = await bcrypt.hash(password, 12);
          await pool.execute("UPDATE user SET password=? WHERE name=?", [
            newHash,
            username,
          ]);
          authLog(
            clientIp,
            "INFO",
            `Mot de passe migré bcrypt : "${username}"`,
          );
        } catch (hashErr) {
          console.error("bcrypt hash error:", hashErr);
        }
      }
    }

    if (!passwordValid) {
      authLog(clientIp, "FAIL", `Mot de passe incorrect pour : "${username}"`);
      return res
        .status(401)
        .json({ success: false, message: "Wrong credentials" });
    }

    await new Promise((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve())),
    );

    req.session.username = username;
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
    authLog(clientIp, "OK", `Connexion réussie : "${username}"`);

    // Auth Sencrop
    try {
      const crypt = Buffer.from(
        sencrop.applicationId + ":" + sencrop.applicationSecret,
      ).toString("base64");
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

    return res
      .status(200)
      .json({ success: true, csrfToken: req.session.csrfToken });
  } catch (error) {
    console.error("Auth error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
});

app.post("/api/logout", (req, res) => {
  if (!req.session) return res.json({ success: true });
  const logoutUser = req.session.username || "inconnu";
  const clientIp = req.ip || req.socket?.remoteAddress || "unknown";
  req.session.destroy(() => {
    authLog(clientIp, "INFO", `Déconnexion : "${logoutUser}"`);
    res.clearCookie("sid");
    res.json({ success: true });
  });
});

app.get("/api/config", authMiddleware, (req, res) => {
  res.json({ googleMapsApiKey: map.key });
});

app.get("/api/forecast", authMiddleware, async (req, res) => {
  try {
    const result = await fetchForecastData();
    res.json(result);
  } catch (error) {
    console.error("Error fetching forecast data:", error);
    res.status(500).json({ error: "Error fetching forecast data" });
  }
});

// ─────────────────────────────────────────────
// GPS — Location ingest (mémoire + WebSocket immédiat)
// ─────────────────────────────────────────────

function readJsonFileSafe(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const content = fs.readFileSync(filePath, "utf8");
    if (!content || !content.trim()) return fallback;
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

app.post("/api/location", locationLimiter, (req, res) => {
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

    if (!GPS_INGEST_KEY) {
      return res
        .status(500)
        .json({ success: false, message: "GPS_INGEST_KEY is not configured" });
    }

    const keyStr = typeof key === "string" ? key : "";
    const keyBuf = Buffer.from(keyStr, "utf8");
    const expectedBuf = Buffer.from(GPS_INGEST_KEY, "utf8");
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
  } catch (error) {
    console.error("[LOCATION] Erreur interne:", error);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ success: false, message: "Internal server error" });
    }
  }
});

app.get("/api/latest-positions", authMiddleware, (req, res) => {
  res.status(200).json({ success: true, positions: positionsMemory });
});

app.get("/api/positions-history", authMiddleware, (req, res) => {
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

// ─────────────────────────────────────────────
// Sencrop / Forecast helpers
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// Socket.IO
// ─────────────────────────────────────────────

io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, () => {
    if (socket.request.session?.username) return next();
    return next(new Error("Unauthorized"));
  });
});

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
      `Socket déconnecté : "${socketUser}" (raison: ${reason})`,
    );
  });

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
      if (result?.measures)
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
      if (result?.measures)
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
      if (result?.measures) {
        let sum = 0;
        for (const i in result.measures.data)
          sum += result.measures.data[i].RAIN_FALL;
        socket.emit("getRain", sum);
      }
    });
  });

  socket.on("forceDisconnect", () => socket.disconnect(true));
});

// ─────────────────────────────────────────────
// Phyto — Produits
// ─────────────────────────────────────────────

app.get("/api/phyto/products", authMiddleware, async (req, res) => {
  try {
    const [results] = await pool.execute(
      "SELECT * FROM phyto_products ORDER BY name ASC",
    );
    res.json(results || []);
  } catch (err) {
    console.error("Error fetching products:", err);
    res
      .status(500)
      .json({ success: false, message: "Error fetching products" });
  }
});

app.post("/api/phyto/products", authMiddleware, async (req, res) => {
  const { name, category, stock, unit, notes } = req.body;
  if (!name) {
    return res
      .status(400)
      .json({ success: false, message: "Product name is required" });
  }
  try {
    const [result] = await pool.execute(
      "INSERT INTO phyto_products (name, category, stock, unit, notes) VALUES (?, ?, ?, ?, ?)",
      [name, category || "Autre", stock || 0, unit || "L", notes || ""],
    );
    res
      .status(201)
      .json({ success: true, id: result.insertId, message: "Product created" });
  } catch (err) {
    console.error("Error creating product:", err);
    res.status(500).json({ success: false, message: "Error creating product" });
  }
});

app.put("/api/phyto/products/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { name, category, stock, unit, notes } = req.body;
  if (!name) {
    return res
      .status(400)
      .json({ success: false, message: "Product name is required" });
  }
  try {
    await pool.execute(
      "UPDATE phyto_products SET name = ?, category = ?, stock = ?, unit = ?, notes = ? WHERE id = ?",
      [name, category || "Autre", stock || 0, unit || "L", notes || "", id],
    );
    res.json({ success: true, message: "Product updated" });
  } catch (err) {
    console.error("Error updating product:", err);
    res.status(500).json({ success: false, message: "Error updating product" });
  }
});

app.delete("/api/phyto/products/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.execute("DELETE FROM phyto_products WHERE id = ?", [id]);
    res.json({ success: true, message: "Product deleted" });
  } catch (err) {
    console.error("Error deleting product:", err);
    res.status(500).json({ success: false, message: "Error deleting product" });
  }
});

// ─────────────────────────────────────────────
// Phyto — Applications
// ─────────────────────────────────────────────

app.get("/api/phyto/applications", authMiddleware, async (req, res) => {
  try {
    const [results] = await pool.execute(
      `SELECT
        a.id, a.date, a.notes, a.created_at, a.updated_at,
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
    );
    res.json(results || []);
  } catch (err) {
    console.error("Error fetching applications:", err);
    res
      .status(500)
      .json({ success: false, message: "Error fetching applications" });
  }
});

app.post("/api/phyto/applications", authMiddleware, async (req, res) => {
  const { date, notes, products } = req.body;

  if (!date || !Array.isArray(products) || products.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Date and at least one product are required",
    });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Vérification stock pour les produits avec quantité
    const productsWithQty = products.filter(
      (p) => p.quantity_used && Number(p.quantity_used) > 0,
    );
    if (productsWithQty.length > 0) {
      const productIds = productsWithQty.map((p) => p.product_id);
      const [existingProducts] = await conn.query(
        "SELECT id, name, stock, unit FROM phyto_products WHERE id IN (?)",
        [productIds],
      );

      for (const p of productsWithQty) {
        const existing = existingProducts.find((ep) => ep.id === p.product_id);
        if (!existing) {
          await conn.rollback();
          return res.status(400).json({
            success: false,
            message: `Produit ID ${p.product_id} introuvable`,
          });
        }
        if (Number(p.quantity_used) > Number(existing.stock || 0)) {
          await conn.rollback();
          return res.status(400).json({
            success: false,
            message: `Stock insuffisant pour ${existing.name}. Disponible : ${existing.stock} ${existing.unit}`,
          });
        }
      }
    }

    // Insert application
    const [appResult] = await conn.execute(
      "INSERT INTO phyto_applications (date, notes) VALUES (?, ?)",
      [date, notes || ""],
    );
    const applicationId = appResult.insertId;

    // Insert produits liés
    if (products.length > 0) {
      const productInserts = products.map((p) => [
        applicationId,
        p.product_id,
        p.quantity_used || null,
      ]);
      await conn.query(
        "INSERT INTO phyto_application_products (application_id, product_id, quantity_used) VALUES ?",
        [productInserts],
      );
    }

    // Décrémentation stock
    for (const p of productsWithQty) {
      await conn.execute(
        "UPDATE phyto_products SET stock = stock - ? WHERE id = ?",
        [Number(p.quantity_used), p.product_id],
      );
    }

    await conn.commit();
    res.status(201).json({
      success: true,
      id: applicationId,
      message: "Application created",
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error creating application:", err);
    res
      .status(500)
      .json({ success: false, message: "Error creating application" });
  } finally {
    conn.release();
  }
});

app.put("/api/phyto/applications/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { date, notes, products } = req.body;

  if (!date || !Array.isArray(products) || products.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Date and at least one product are required",
    });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Récupérer les anciens produits pour restaurer le stock
    const [oldProducts] = await conn.execute(
      "SELECT product_id, quantity_used FROM phyto_application_products WHERE application_id = ?",
      [id],
    );

    // Restaurer le stock des anciens produits
    for (const p of oldProducts.filter((p) => p.quantity_used)) {
      await conn.execute(
        "UPDATE phyto_products SET stock = stock + ? WHERE id = ?",
        [p.quantity_used, p.product_id],
      );
    }

    // Mise à jour de l'application
    await conn.execute(
      "UPDATE phyto_applications SET date = ?, notes = ? WHERE id = ?",
      [date, notes || "", id],
    );

    // Supprimer les anciens produits liés
    await conn.execute(
      "DELETE FROM phyto_application_products WHERE application_id = ?",
      [id],
    );

    // Insérer les nouveaux produits
    if (products.length > 0) {
      const productInserts = products.map((p) => [
        id,
        p.product_id,
        p.quantity_used || null,
      ]);
      await conn.query(
        "INSERT INTO phyto_application_products (application_id, product_id, quantity_used) VALUES ?",
        [productInserts],
      );
    }

    // Décrémenter le stock des nouveaux produits
    for (const p of products.filter((p) => p.quantity_used)) {
      await conn.execute(
        "UPDATE phyto_products SET stock = stock - ? WHERE id = ?",
        [Number(p.quantity_used), p.product_id],
      );
    }

    await conn.commit();
    res.json({ success: true, message: "Application updated" });
  } catch (err) {
    await conn.rollback();
    console.error("Error updating application:", err);
    res
      .status(500)
      .json({ success: false, message: "Error updating application" });
  } finally {
    conn.release();
  }
});

app.delete("/api/phyto/applications/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const restoreStock = req.query.restoreStock === "true";

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (restoreStock) {
      const [products] = await conn.execute(
        "SELECT product_id, quantity_used FROM phyto_application_products WHERE application_id = ?",
        [id],
      );
      for (const p of products.filter((p) => p.quantity_used)) {
        await conn.execute(
          "UPDATE phyto_products SET stock = stock + ? WHERE id = ?",
          [p.quantity_used, p.product_id],
        );
      }
    }

    await conn.execute("DELETE FROM phyto_applications WHERE id = ?", [id]);

    await conn.commit();
    res.json({ success: true, message: "Application deleted" });
  } catch (err) {
    await conn.rollback();
    console.error("Error deleting application:", err);
    res
      .status(500)
      .json({ success: false, message: "Error deleting application" });
  } finally {
    conn.release();
  }
});

// ─────────────────────────────────────────────
// SPA fallback
// ─────────────────────────────────────────────

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

server.listen(PORT, HOST, () => {
  console.log(
    `Server running on ${HOST}:${PORT} (${IS_PROD ? "prod" : "dev"})`,
  );
});

server.on("error", (error) => {
  console.error("Server failed to start:", error);
});
