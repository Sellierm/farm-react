import { useEffect, useRef, useState } from "react";
import Nav from "../components/Nav.jsx";
import { useSocket } from "../contexts/SocketContext.jsx";
import usePageMeta from "../hooks/usePageMeta.js";
import "./FieldsPage.css";

const CROP_COLORS = {
  Blé: "rgb(255, 234, 0)",
  Betteraves: "rgb(165, 39, 20)",
  Colza: "rgb(156, 39, 176)",
  Herbe: "rgb(124, 179, 66)",
  Maïs: "rgb(9, 113, 56)",
  Pdt: "rgb(2, 136, 209)",
  "Seigle/Maïs": "rgb(26, 35, 126)",
  "N/A": "rgb(66, 66, 66)",
};

const YEARS = [2022, 2023, 2024, 2025, 2026];

export default function FieldsPage() {
  const socket = useSocket();
  const mapRef = useRef(null);
  const [year, setYear] = useState(new Date().getFullYear());
  const [mapsKey, setMapsKey] = useState("");
  const [mapInfo, setMapInfo] = useState(["", ""]);
  const [totalHa, setTotalHa] = useState(null);
  const [gpsPositions, setGpsPositions] = useState({});
  const [showPdtInfo, setShowPdtInfo] = useState(false);

  const mapInstanceRef = useRef(null);
  const gpsMarkersRef = useRef([]);
  const markerPositionsRef = useRef({});
  const gpsPolylinesRef = useRef([]);
  const gpsSignaturesRef = useRef({});
  const gpsPollIntervalRef = useRef(null);
  const activeDeviceIdRef = useRef(null);
  const activeInfoWindowRef = useRef(null);
  const markerByDeviceRef = useRef({});
  const infoWindowByDeviceRef = useRef({});

  usePageMeta("Fields", "/assets/icons8-champ-32.png");

  // Load Google Maps API key
  useEffect(() => {
    fetch("/api/config", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setMapsKey(d.googleMapsApiKey));
  }, []);

  // Socket: receive KML plan URL
  useEffect(() => {
    if (!socket) return;
    socket.on("getPlan", (src) => initGoogleMap(src));
    return () => socket.off("getPlan");
  }, [socket, mapsKey]); // eslint-disable-line

  // Masquer le scroll du body sur cette page uniquement
  useEffect(() => {
    document.body.classList.add("body-overflow-hidden");
    return () => {
      document.body.classList.remove("body-overflow-hidden");
    };
  }, []);

  const changeYear = (y) => {
    setYear(y);
    if (socket) socket.emit("askPlan", y);
  };

  // Emit on first load (once key is ready)
  useEffect(() => {
    if (socket && mapsKey) socket.emit("askPlan", year);
  }, [socket, mapsKey]); // eslint-disable-line

  const getTrailColor = (deviceId) => {
    const palette = [
      "#ff6b00",
      "#1976d2",
      "#2e7d32",
      "#8e24aa",
      "#d81b60",
      "#00838f",
    ];
    const str = String(deviceId || "0");
    const hash = str.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    return palette[hash % palette.length];
  };

  const loadPositionHistory = async (map) => {
    try {
      const res = await fetch("/api/positions-history?hours=24", {
        credentials: "include",
      });
      const data = await res.json();
      if (!data.success || !map) return;

      gpsPolylinesRef.current.forEach((line) => line.setMap(null));
      gpsPolylinesRef.current = [];

      const historyByDevice = data.positions || {};
      for (const deviceId of Object.keys(historyByDevice)) {
        const rawSeries = Array.isArray(historyByDevice[deviceId])
          ? historyByDevice[deviceId]
          : [];

        const path = rawSeries
          .map((point) => ({
            lat: Number(point.latitude),
            lng: Number(point.longitude),
          }))
          .filter(
            (point) => Number.isFinite(point.lat) && Number.isFinite(point.lng),
          );

        if (path.length < 2) continue;

        const polyline = new window.google.maps.Polyline({
          path,
          geodesic: true,
          strokeColor: getTrailColor(deviceId),
          strokeOpacity: 0.85,
          strokeWeight: 3,
          map,
        });

        gpsPolylinesRef.current.push(polyline);
      }
    } catch (err) {
      console.error("Error loading GPS history:", err);
    }
  };

  const loadGPSPositions = async (map, forceRefresh = false) => {
    try {
      const res = await fetch("/api/latest-positions", {
        credentials: "include",
      });
      const data = await res.json();
      if (!data.success || !map) return false;

      const positions = data.positions || {};
      const nextSignatures = {};
      for (const deviceId in positions) {
        const pos = positions[deviceId] || {};
        nextSignatures[deviceId] =
          String(pos.timestamp || "") +
          "|" +
          String(pos.latitude || "") +
          "|" +
          String(pos.longitude || "");
      }

      const prevKeys = Object.keys(gpsSignaturesRef.current);
      const nextKeys = Object.keys(nextSignatures);
      const hasSameKeyCount = prevKeys.length === nextKeys.length;
      const hasChanges =
        !hasSameKeyCount ||
        nextKeys.some(
          (deviceId) =>
            gpsSignaturesRef.current[deviceId] !== nextSignatures[deviceId],
        );

      if (!hasChanges && !forceRefresh) {
        return false;
      }

      gpsSignaturesRef.current = nextSignatures;

      // Clear old markers
      gpsMarkersRef.current.forEach((m) => m.setMap(null));
      gpsMarkersRef.current = [];
      markerByDeviceRef.current = {};
      infoWindowByDeviceRef.current = {};

      const newGps = {};

      for (const deviceId in positions) {
        const pos = positions[deviceId];
        markerPositionsRef.current[deviceId] = {
          lat: parseFloat(pos.latitude),
          lng: parseFloat(pos.longitude),
        };
        newGps[deviceId] = pos;

        const tractorIcon = document.createElement("img");
        if (deviceId === "7724") tractorIcon.src = "/assets/tracteur_red.png";
        else if (deviceId === "6290") tractorIcon.src = "/assets/tracteur.png";
        tractorIcon.style.width = "40px";
        tractorIcon.style.height = "40px";
        tractorIcon.style.cursor = "pointer";

        const marker = new window.google.maps.marker.AdvancedMarkerElement({
          position: markerPositionsRef.current[deviceId],
          map,
          title: `Device: ${deviceId}`,
          content: tractorIcon,
        });

        const infoWindow = new window.google.maps.InfoWindow({
          content: `<div style="padding:5px"><strong>Device ID:</strong> ${deviceId}<br/>
            <strong>Position:</strong> ${parseFloat(pos.latitude).toFixed(6)}, ${parseFloat(pos.longitude).toFixed(6)}<br/>
            <strong>Last Update:</strong> ${new Date(pos.timestamp).toLocaleString("fr-FR")}</div>`,
        });
        marker.addListener("click", () => {
          if (activeInfoWindowRef.current) {
            activeInfoWindowRef.current.close();
          }
          infoWindow.open(map, marker);
          activeInfoWindowRef.current = infoWindow;
          activeDeviceIdRef.current = deviceId;
        });
        gpsMarkersRef.current.push(marker);
        markerByDeviceRef.current[deviceId] = marker;
        infoWindowByDeviceRef.current[deviceId] = infoWindow;
      }

      const activeId = activeDeviceIdRef.current;
      if (
        activeId &&
        markerByDeviceRef.current[activeId] &&
        infoWindowByDeviceRef.current[activeId]
      ) {
        const marker = markerByDeviceRef.current[activeId];
        const infoWindow = infoWindowByDeviceRef.current[activeId];
        if (
          activeInfoWindowRef.current &&
          activeInfoWindowRef.current !== infoWindow
        ) {
          activeInfoWindowRef.current.close();
        }
        infoWindow.open(map, marker);
        activeInfoWindowRef.current = infoWindow;
      } else if (activeInfoWindowRef.current) {
        activeInfoWindowRef.current.close();
        activeInfoWindowRef.current = null;
        activeDeviceIdRef.current = null;
      }

      setGpsPositions(newGps);
      return true;
    } catch (err) {
      console.error("Error loading GPS positions:", err);
      return false;
    }
  };

  const initGoogleMap = (src) => {
    if (!mapsKey) return;

    const loadMap = () => {
      const map = new window.google.maps.Map(mapRef.current, {
        center: new window.google.maps.LatLng(50.39977, 3.040901),
        zoom: 14,
        mapTypeId: "satellite",
        streetViewControl: false,
        mapId: "FARM_GPS_MAP",
        tilt: 0,
      });
      mapInstanceRef.current = map;

      const kmlLayer = new window.google.maps.KmlLayer(src, {
        suppressInfoWindows: true,
        preserveViewport: true,
        map,
      });

      kmlLayer.addListener("click", (event) => {
        const content = event.featureData.description || "";
        const dataTab = [];
        let j = 0;
        dataTab[0] = "";

        for (let i = 0; i < content.length; i++) {
          if (content[i] === "<") {
            j += 1;
            i += 3;
            dataTab[j] = "";
          } else {
            dataTab[j] += content[i];
          }
        }

        const infos = [];
        let inc = 0;
        for (let i in dataTab) {
          const idx = dataTab[i].indexOf(":");
          if (idx + 1 !== dataTab[i].length) {
            infos[inc++] =
              dataTab[i].slice(0, idx) + " " + dataTab[i].slice(idx);
          }
        }
        setMapInfo([infos[0] || "", infos[1] || ""]);
      });

      window.google.maps.event.addListenerOnce(
        kmlLayer,
        "defaultviewport_changed",
        () => {
          const parser = new DOMParser();
          fetch(src)
            .then((r) => r.text())
            .then((kmlText) => {
              const kmlDoc = parser.parseFromString(kmlText, "text/xml");
              const placemarks = kmlDoc.getElementsByTagName("Placemark");
              let total = 0;
              for (let i = 0; i < placemarks.length; i++) {
                const desc =
                  placemarks[i].getElementsByTagName("description")[0];
                if (desc) {
                  const m = desc.textContent.match(
                    /Surface\s*\(Ha\)\s*:\s*(\d+(\.\d+)?)/,
                  );
                  if (m) total += parseFloat(m[1]);
                }
              }
              setTotalHa(total.toFixed(2));
            });
        },
      );

      loadGPSPositions(map, true).then((changed) => {
        if (changed) loadPositionHistory(map);
      });

      if (gpsPollIntervalRef.current) {
        clearInterval(gpsPollIntervalRef.current);
      }

      gpsPollIntervalRef.current = setInterval(async () => {
        const changed = await loadGPSPositions(map);
        if (changed) {
          loadPositionHistory(map);
        }
      }, 2000);
    };

    if (window.google && window.google.maps) {
      loadMap();
    } else {
      const script = document.createElement("script");
      script.src = `https://maps.googleapis.com/maps/api/js?key=${mapsKey}&libraries=marker&callback=__farmMapsLoaded`;
      script.async = true;
      window.__farmMapsLoaded = () => loadMap();
      document.head.appendChild(script);
    }
  };

  useEffect(() => {
    return () => {
      if (gpsPollIntervalRef.current) {
        clearInterval(gpsPollIntervalRef.current);
      }
      gpsPolylinesRef.current.forEach((line) => line.setMap(null));
    };
  }, []);

  const centerOnDevice = (deviceId) => {
    if (mapInstanceRef.current && markerPositionsRef.current[deviceId]) {
      mapInstanceRef.current.setCenter(markerPositionsRef.current[deviceId]);
      //mapInstanceRef.current.setZoom(14);

      const marker = markerByDeviceRef.current[deviceId];
      const infoWindow = infoWindowByDeviceRef.current[deviceId];
      if (marker && infoWindow) {
        if (activeInfoWindowRef.current) {
          activeInfoWindowRef.current.close();
        }
        infoWindow.open(mapInstanceRef.current, marker);
        activeInfoWindowRef.current = infoWindow;
        activeDeviceIdRef.current = deviceId;
      }
    }
  };

  return (
    <div className="fields-page">
      <Nav />
      <div id="mapCap">
        {/* Legend */}
        <div id="legend">
          <h2>Légende</h2>
          {Object.entries(CROP_COLORS).map(([name, color]) => (
            <div
              className="lin"
              key={name}
              id={name === "Pdt" ? "pdt" : undefined}
              onMouseEnter={
                name === "Pdt" ? () => setShowPdtInfo(true) : undefined
              }
              onMouseLeave={
                name === "Pdt" ? () => setShowPdtInfo(false) : undefined
              }
            >
              <div style={{ backgroundColor: color }} />
              <p>{name === "Pdt" ? "Pdt*" : name}</p>
            </div>
          ))}
          {showPdtInfo && (
            <div className="lin">
              <p id="info" style={{ padding: 0, marginTop: "-2%" }}>
                *Pdt: Pomme de terre
              </p>
            </div>
          )}
        </div>

        {/* Map */}
        <div id="map" ref={mapRef} />

        {/* Info Panel */}
        <div id="infoPanel">
          <div id="capture">
            <h2>Info</h2>
            <div className="lin">
              <p>{mapInfo[0]}</p>
            </div>
            <div className="lin">
              <p>{mapInfo[1]}</p>
            </div>
          </div>
          <div id="newCapture">
            <h2>Données</h2>
            <div className="lin">
              <p>Total (Ha) : {totalHa !== null ? totalHa : ""}</p>
            </div>
          </div>
          <div id="gpsDevices">
            <h2>GPS</h2>
            <div id="deviceButtons">
              {Object.keys(gpsPositions).map((id) => (
                <button
                  key={id}
                  className="device-btn"
                  onClick={() => centerOnDevice(id)}
                >
                  📍 {id}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <select
        id="year"
        value={year}
        onChange={(e) => changeYear(parseInt(e.target.value))}
      >
        {YEARS.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
    </div>
  );
}
