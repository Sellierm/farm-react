const fs = require("fs");
const path = require("path");

/*
 * Store partagé des positions GPS (mémoire + persistance disque périodique).
 *
 * Extrait de routes/gps.js pour être utilisable à la fois par la route HTTP
 * POST /api/location (conservée pour compatibilité/tests) et par le handler
 * Socket.IO "location" (canal utilisé par la tablette RTK depuis le passage
 * du tracker Android au transport Socket.IO persistant).
 *
 * Module singleton : une seule instance de store par processus, ce qui
 * correspond à l'usage réel (un seul serveur Node par déploiement).
 */

let positionsMemory = {};
let historyMemory = {};

let dirtyPositions = false;
let dirtyHistory = false;

const LOCATIONS_FILE = path.join(__dirname, "latest_positions.json");
const HISTORY_FILE = path.join(__dirname, "location_history.json");

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

function loadMemoryFromDisk() {
  positionsMemory = readJsonFileSafe(LOCATIONS_FILE, {});
  historyMemory = readJsonFileSafe(HISTORY_FILE, {});
  console.log("[GPS] Mémoire chargée depuis disque");
}

let persistenceStarted = false;
function startDiskPersistence() {
  if (persistenceStarted) return; // idempotent : evite un double setInterval
  persistenceStarted = true; // si le module est require() depuis plusieurs fichiers

  setInterval(() => {
    if (dirtyPositions) {
      fs.writeFile(
        LOCATIONS_FILE,
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
      fs.writeFile(
        HISTORY_FILE,
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

/**
 * Construit et valide un point de position a partir d'un payload brut.
 * Retourne { error } ou { point }. Utilise a la fois par la route HTTP
 * historique et par le handler Socket.IO "location".
 */
function buildLocationPoint(deviceId, body) {
  const {
    latitude,
    longitude,
    timestamp,
    source,
    altitude,
    accuracy,
    speed,
    heading,
  } = body || {};

  if (latitude === undefined || longitude === undefined || !timestamp) {
    return { error: "Missing required fields" };
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return { error: "Invalid coordinates" };
  }

  return {
    point: {
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
    },
  };
}

/**
 * Enregistre un point de position deja valide en memoire (positions
 * courantes + historique 24h) et diffuse la mise a jour aux clients web
 * via Socket.IO. `io` est passe en parametre plutot qu'importe directement
 * pour eviter une dependance circulaire avec socket.js.
 */
function ingestLocationPoint(io, newPoint) {
  const deviceId = newPoint.device_id;

  io.emit("location_update", newPoint);

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
}

function getPositions() {
  return positionsMemory;
}

function getHistory() {
  return historyMemory;
}

// Chargement au premier require() du module (comportement identique a
// l'ancien code qui le faisait a la creation du router).
loadMemoryFromDisk();
startDiskPersistence();

module.exports = {
  buildLocationPoint,
  ingestLocationPoint,
  getPositions,
  getHistory,
};
