const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pool, GPS_INGEST_KEY, GPS_ALLOWED_IDS } = require("../config");
const { authMiddleware, locationLimiter } = require("../middleware");

function createGpsRouter(io) {
  const router = express.Router();

  let positionsMemory = {};
  let historyMemory = {};

  let dirtyPositions = false;
  let dirtyHistory = false;

  function loadMemoryFromDisk() {
    const locationsFilePath = path.join(__dirname, "../latest_positions.json");
    const historyFilePath = path.join(__dirname, "../location_history.json");
    positionsMemory = readJsonFileSafe(locationsFilePath, {});
    historyMemory = readJsonFileSafe(historyFilePath, {});
    console.log("[GPS] Mémoire chargée depuis disque");
  }

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

  function startDiskPersistence() {
    setInterval(() => {
      if (dirtyPositions) {
        const locationsFilePath = path.join(
          __dirname,
          "../latest_positions.json",
        );
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
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        for (const deviceId of Object.keys(historyMemory)) {
          historyMemory[deviceId] = (historyMemory[deviceId] || []).filter(
            (p) => {
              const t = new Date(p.timestamp).getTime();
              return Number.isFinite(t) && t >= cutoff;
            },
          );
        }
        const historyFilePath = path.join(
          __dirname,
          "../location_history.json",
        );
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

  router.post("/api/location", locationLimiter, (req, res) => {
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
          .json({
            success: false,
            message: "GPS_INGEST_KEY is not configured",
          });
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

  router.get("/api/latest-positions", authMiddleware, (req, res) => {
    res.status(200).json({ success: true, positions: positionsMemory });
  });

  router.get("/api/positions-history", authMiddleware, (req, res) => {
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

  return router;
}

module.exports = createGpsRouter;
