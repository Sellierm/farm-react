const express = require("express");
const crypto = require("crypto");
const { GPS_INGEST_KEY, GPS_ALLOWED_IDS } = require("../config");
const { authMiddleware, locationLimiter } = require("../middleware");
const {
  buildLocationPoint,
  ingestLocationPoint,
  getPositions,
  getHistory,
} = require("../locationStore");

function createGpsRouter(io) {
  const router = express.Router();

  // Route HTTP historique — conservée pour compatibilité/tests, mais le
  // tracker Android envoie désormais ses positions via le canal Socket.IO
  // "location" (voir socket.js), qui évite le coût d'un handshake TCP/TLS
  // répété à chaque position et bénéficie de la reconnexion automatique.
  router.post("/api/location", locationLimiter, (req, res) => {
    try {
      const { id, key } = req.body;

      if (!GPS_INGEST_KEY) {
        return res.status(500).json({
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

      const deviceId = String(id || "0");
      const { error, point } = buildLocationPoint(deviceId, req.body);
      if (error) {
        return res.status(400).json({ success: false, message: error });
      }

      // Réponse HTTP immédiate — avant tout I/O disque
      res.status(200).json({ success: true });
      ingestLocationPoint(io, point);
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
    res.status(200).json({ success: true, positions: getPositions() });
  });

  router.get("/api/positions-history", authMiddleware, (req, res) => {
    const requestedHours = Number(req.query.hours);
    const hours =
      Number.isFinite(requestedHours) && requestedHours > 0
        ? Math.min(requestedHours, 168)
        : 24;

    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const historyMemory = getHistory();
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
