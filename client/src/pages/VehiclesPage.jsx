import { useEffect, useState, useCallback } from "react";
import Nav from "../components/Nav.jsx";
import { useAuth } from "../contexts/AuthContext.jsx";
import usePageMeta from "../hooks/usePageMeta.js";
import "./VehiclesPage.css";

const VEHICLE_TYPES = [
  "Tracteur",
  "Moissonneuse",
  "Pulvérisateur",
  "Remorque",
  "Voiture",
  "Autre",
];
const MAINTENANCE_TYPES = [
  "Vidange",
  "Filtre à air",
  "Filtre à huile",
  "Filtres carburant",
  "Filtre hydraulique",
  "Courroies",
  "Pneus",
  "Freins",
  "Batterie",
  "Révision générale",
  "Contrôle technique",
  "Autre",
];

function statusClass(nextDate, nextHours, currentHours) {
  const now = new Date();
  const warningDays = 30;
  const warningHours = 50;
  let expired = false;
  let warning = false;

  if (nextDate) {
    const nd = new Date(nextDate);
    const diffDays = (nd - now) / (1000 * 60 * 60 * 24);
    if (diffDays < 0) expired = true;
    else if (diffDays <= warningDays) warning = true;
  }
  if (nextHours != null && currentHours != null) {
    const diffHours = nextHours - currentHours;
    if (diffHours < 0) expired = true;
    else if (diffHours <= warningHours) warning = true;
  }
  if (expired) return "status-expired";
  if (warning) return "status-warning";
  return "status-ok";
}

function statusLabel(nextDate, nextHours, currentHours) {
  const now = new Date();
  let parts = [];
  if (nextDate) {
    const nd = new Date(nextDate);
    const diffDays = Math.round((nd - now) / (1000 * 60 * 60 * 24));
    if (diffDays < 0) parts.push(`Expiré il y a ${Math.abs(diffDays)}j`);
    else parts.push(`Dans ${diffDays}j`);
  }
  if (nextHours != null && currentHours != null) {
    const diffHours = nextHours - currentHours;
    if (diffHours < 0) parts.push(`Dépassé de ${Math.abs(diffHours)}h`);
    else parts.push(`Dans ${diffHours}h`);
  }
  return parts.join(" / ") || "—";
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("fr-FR");
}

// ── Modal ──────────────────────────────────────────────────────────────────────
function Modal({ title, onClose, children }) {
  return (
    <div className="vm-overlay" onClick={onClose}>
      <div className="vm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="vm-modal-header">
          <span>{title}</span>
          <button className="vm-close-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="vm-modal-body">{children}</div>
      </div>
    </div>
  );
}

// ── Vehicle Form ───────────────────────────────────────────────────────────────
function VehicleForm({ initial, onSubmit, onCancel }) {
  const [form, setForm] = useState({
    name: initial?.name || "",
    type: initial?.type || VEHICLE_TYPES[0],
    brand: initial?.brand || "",
    model: initial?.model || "",
    year: initial?.year || new Date().getFullYear(),
    plate: initial?.plate || "",
    hours: initial?.hours || 0,
  });

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <form
      className="vm-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(form);
      }}
    >
      <div className="vm-form-row">
        <label>Nom *</label>
        <input
          required
          value={form.name}
          onChange={set("name")}
          placeholder="ex: John Deere 6130M"
        />
      </div>
      <div className="vm-form-row">
        <label>Type</label>
        <select value={form.type} onChange={set("type")}>
          {VEHICLE_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </div>
      <div className="vm-form-row2">
        <div className="vm-form-row">
          <label>Marque</label>
          <input
            value={form.brand}
            onChange={set("brand")}
            placeholder="John Deere"
          />
        </div>
        <div className="vm-form-row">
          <label>Modèle</label>
          <input
            value={form.model}
            onChange={set("model")}
            placeholder="6130M"
          />
        </div>
      </div>
      <div className="vm-form-row2">
        <div className="vm-form-row">
          <label>Année</label>
          <input
            type="number"
            value={form.year}
            onChange={set("year")}
            min={1950}
            max={2100}
          />
        </div>
        <div className="vm-form-row">
          <label>Immatriculation</label>
          <input
            value={form.plate}
            onChange={set("plate")}
            placeholder="AB-123-CD"
          />
        </div>
      </div>
      <div className="vm-form-row">
        <label>Heures actuelles</label>
        <input
          type="number"
          value={form.hours}
          onChange={set("hours")}
          min={0}
        />
      </div>
      <div className="vm-form-actions">
        <button
          type="button"
          className="vm-btn vm-btn-ghost"
          onClick={onCancel}
        >
          Annuler
        </button>
        <button type="submit" className="vm-btn vm-btn-primary">
          Enregistrer
        </button>
      </div>
    </form>
  );
}

// ── Maintenance Form ───────────────────────────────────────────────────────────
function MaintenanceForm({ initial, currentHours, onSubmit, onCancel }) {
  const [form, setForm] = useState({
    type: initial?.type || MAINTENANCE_TYPES[0],
    date: initial?.date
      ? initial.date.split("T")[0]
      : new Date().toISOString().split("T")[0],
    hours_at_service: initial?.hours_at_service ?? currentHours ?? "",
    next_date: initial?.next_date ? initial.next_date.split("T")[0] : "",
    next_hours: initial?.next_hours ?? "",
    notes: initial?.notes || "",
  });

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <form
      className="vm-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(form);
      }}
    >
      <div className="vm-form-row">
        <label>Type d'entretien *</label>
        <select value={form.type} onChange={set("type")}>
          {MAINTENANCE_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </div>
      <div className="vm-form-row2">
        <div className="vm-form-row">
          <label>Date réalisée *</label>
          <input
            required
            type="date"
            value={form.date}
            onChange={set("date")}
          />
        </div>
        <div className="vm-form-row">
          <label>Heures au compteur</label>
          <input
            type="number"
            value={form.hours_at_service}
            onChange={set("hours_at_service")}
            min={0}
          />
        </div>
      </div>
      <div className="vm-form-row2">
        <div className="vm-form-row">
          <label>Prochain entretien (date)</label>
          <input
            type="date"
            value={form.next_date}
            onChange={set("next_date")}
          />
        </div>
        <div className="vm-form-row">
          <label>Prochain entretien (heures)</label>
          <input
            type="number"
            value={form.next_hours}
            onChange={set("next_hours")}
            min={0}
            placeholder="Nombre d'heures"
          />
        </div>
      </div>
      <div className="vm-form-row">
        <label>Notes</label>
        <textarea
          value={form.notes}
          onChange={set("notes")}
          rows={3}
          placeholder="Observations, pièces remplacées..."
        />
      </div>
      <div className="vm-form-actions">
        <button
          type="button"
          className="vm-btn vm-btn-ghost"
          onClick={onCancel}
        >
          Annuler
        </button>
        <button type="submit" className="vm-btn vm-btn-primary">
          Enregistrer
        </button>
      </div>
    </form>
  );
}

// ── VehiclesPage ───────────────────────────────────────────────────────────────
export default function VehiclesPage() {
  const { csrfToken, refreshCsrfToken } = useAuth();

  const [vehicles, setVehicles] = useState([]);
  const [selectedVehicle, setSelectedVehicle] = useState(null);
  const [maintenance, setMaintenance] = useState([]);
  const [loadingVehicles, setLoadingVehicles] = useState(true);
  const [loadingMaintenance, setLoadingMaintenance] = useState(false);

  // Modal state
  const [modal, setModal] = useState(null); // null | "add-vehicle" | "edit-vehicle" | "add-maint" | "edit-maint"
  const [editTarget, setEditTarget] = useState(null);

  usePageMeta("Véhicules", "/assets/icons8-tractor-32.png");

  // ── API helpers ──────────────────────────────────────────────────────────────
  const apiFetch = useCallback(
    async (url, options = {}) => {
      const method = (options.method || "GET").toUpperCase();
      const isUnsafeMethod = ["POST", "PUT", "PATCH", "DELETE"].includes(
        method,
      );

      let tokenToUse = csrfToken;
      if (isUnsafeMethod && !tokenToUse) {
        tokenToUse = await refreshCsrfToken();
      }

      let bodyToUse = options.body;
      if (isUnsafeMethod && tokenToUse && typeof options.body === "string") {
        try {
          const parsed = JSON.parse(options.body);
          bodyToUse = JSON.stringify({ ...parsed, _csrf: tokenToUse });
        } catch (error) {
          bodyToUse = options.body;
        }
      }

      const res = await fetch(url, {
        ...options,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": tokenToUse || "",
          ...options.headers,
        },
        body: bodyToUse,
      });

      if (res.status === 403 && isUnsafeMethod) {
        const refreshedToken = await refreshCsrfToken();
        const retryRes = await fetch(url, {
          ...options,
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": refreshedToken || "",
            ...options.headers,
          },
          body:
            isUnsafeMethod && typeof options.body === "string"
              ? (() => {
                  try {
                    const parsed = JSON.parse(options.body);
                    return JSON.stringify({ ...parsed, _csrf: refreshedToken });
                  } catch (error) {
                    return options.body;
                  }
                })()
              : options.body,
        });
        if (!retryRes.ok) throw new Error(`HTTP ${retryRes.status}`);
        return retryRes.json();
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    [csrfToken, refreshCsrfToken],
  );

  const loadVehicles = useCallback(async () => {
    setLoadingVehicles(true);
    try {
      const data = await apiFetch("/api/vehicles");
      setVehicles(data);
    } catch (e) {
      console.error("Erreur chargement véhicules:", e);
    } finally {
      setLoadingVehicles(false);
    }
  }, [apiFetch]);

  const loadMaintenance = useCallback(
    async (vehicleId) => {
      setLoadingMaintenance(true);
      try {
        const data = await apiFetch(`/api/vehicles/${vehicleId}/maintenance`);
        setMaintenance(data);
      } catch (e) {
        console.error("Erreur chargement entretiens:", e);
      } finally {
        setLoadingMaintenance(false);
      }
    },
    [apiFetch],
  );

  useEffect(() => {
    loadVehicles();
  }, [loadVehicles]);

  useEffect(() => {
    if (selectedVehicle) loadMaintenance(selectedVehicle.id);
    else setMaintenance([]);
  }, [selectedVehicle, loadMaintenance]);

  // ── Vehicles CRUD ────────────────────────────────────────────────────────────
  const handleAddVehicle = async (form) => {
    try {
      await apiFetch("/api/vehicles", {
        method: "POST",
        body: JSON.stringify(form),
      });
      await loadVehicles();
      setModal(null);
    } catch (e) {
      console.error(e);
    }
  };

  const handleEditVehicle = async (form) => {
    try {
      const updated = await apiFetch(`/api/vehicles/${editTarget.id}`, {
        method: "PUT",
        body: JSON.stringify(form),
      });
      setVehicles((prev) =>
        prev.map((v) => (v.id === editTarget.id ? { ...v, ...form } : v)),
      );
      if (selectedVehicle?.id === editTarget.id)
        setSelectedVehicle((v) => ({ ...v, ...form }));
      setModal(null);
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteVehicle = async (vehicle) => {
    if (!confirm(`Supprimer "${vehicle.name}" et tous ses entretiens ?`))
      return;
    try {
      await apiFetch(`/api/vehicles/${vehicle.id}`, { method: "DELETE" });
      if (selectedVehicle?.id === vehicle.id) setSelectedVehicle(null);
      await loadVehicles();
    } catch (e) {
      console.error(e);
    }
  };

  // ── Maintenance CRUD ─────────────────────────────────────────────────────────
  const handleAddMaintenance = async (form) => {
    try {
      await apiFetch(`/api/vehicles/${selectedVehicle.id}/maintenance`, {
        method: "POST",
        body: JSON.stringify(form),
      });
      await loadMaintenance(selectedVehicle.id);
      setModal(null);
    } catch (e) {
      console.error(e);
    }
  };

  const handleEditMaintenance = async (form) => {
    try {
      await apiFetch(`/api/maintenance/${editTarget.id}`, {
        method: "PUT",
        body: JSON.stringify(form),
      });
      await loadMaintenance(selectedVehicle.id);
      setModal(null);
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteMaintenance = async (entry) => {
    if (
      !confirm(
        `Supprimer l'entretien "${entry.type}" du ${fmtDate(entry.date)} ?`,
      )
    )
      return;
    try {
      await apiFetch(`/api/maintenance/${entry.id}`, { method: "DELETE" });
      await loadMaintenance(selectedVehicle.id);
    } catch (e) {
      console.error(e);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────
  const nextAlerts = maintenance.filter((m) => {
    const sc = statusClass(
      m.next_date,
      m.next_hours != null ? m.next_hours : null,
      selectedVehicle?.hours,
    );
    return sc !== "status-ok";
  });

  return (
    <>
      <Nav />
      <div className="vm-page">
        {/* ── LEFT: vehicle list ── */}
        <div className="vm-panel vm-panel-left">
          <div className="vm-panel-header">
            <h2>Véhicules</h2>
            <button
              className="vm-btn vm-btn-primary"
              onClick={() => setModal("add-vehicle")}
            >
              + Ajouter
            </button>
          </div>

          {loadingVehicles ? (
            <div className="vm-loading">Chargement…</div>
          ) : vehicles.length === 0 ? (
            <div className="vm-empty">
              Aucun véhicule. Commencez par en ajouter un.
            </div>
          ) : (
            <ul className="vm-vehicle-list">
              {vehicles.map((v) => {
                const nextCount = maintenance.filter(() => false).length; // placeholder
                const isSelected = selectedVehicle?.id === v.id;
                return (
                  <li
                    key={v.id}
                    className={`vm-vehicle-card ${isSelected ? "vm-vehicle-card--active" : ""}`}
                    onClick={() => setSelectedVehicle(isSelected ? null : v)}
                  >
                    <div className="vm-vehicle-card-main">
                      <div className="vm-vehicle-icon">
                        {vehicleIcon(v.type)}
                      </div>
                      <div className="vm-vehicle-info">
                        <span className="vm-vehicle-name">{v.name}</span>
                        <span className="vm-vehicle-meta">
                          {v.type} · {v.year || "—"} · {v.hours ?? 0} h
                        </span>
                        {v.plate && (
                          <span className="vm-vehicle-plate">{v.plate}</span>
                        )}
                      </div>
                    </div>
                    <div
                      className="vm-vehicle-actions"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        className="vm-icon-btn"
                        title="Modifier"
                        onClick={() => {
                          setEditTarget(v);
                          setModal("edit-vehicle");
                        }}
                      >
                        ✏️
                      </button>
                      <button
                        className="vm-icon-btn vm-icon-btn--danger"
                        title="Supprimer"
                        onClick={() => handleDeleteVehicle(v)}
                      >
                        🗑️
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* ── RIGHT: maintenance panel ── */}
        <div className="vm-panel vm-panel-right">
          {!selectedVehicle ? (
            <div className="vm-empty vm-empty--centered">
              <span className="vm-empty-icon">🚜</span>
              <p>
                Sélectionnez un véhicule pour afficher son historique
                d'entretien.
              </p>
            </div>
          ) : (
            <>
              <div className="vm-panel-header">
                <div>
                  <h2>{selectedVehicle.name}</h2>
                  <span className="vm-vehicle-meta">
                    {selectedVehicle.brand} {selectedVehicle.model} ·{" "}
                    {selectedVehicle.hours ?? 0} h
                  </span>
                </div>
                <button
                  className="vm-btn vm-btn-primary"
                  onClick={() => setModal("add-maint")}
                >
                  + Entretien
                </button>
              </div>

              {/* Alerts banner */}
              {nextAlerts.length > 0 && (
                <div className="vm-alerts-banner">
                  ⚠️ {nextAlerts.length} entretien
                  {nextAlerts.length > 1 ? "s" : ""} à prévoir sur ce véhicule
                </div>
              )}

              {loadingMaintenance ? (
                <div className="vm-loading">Chargement…</div>
              ) : maintenance.length === 0 ? (
                <div className="vm-empty">
                  Aucun entretien enregistré pour ce véhicule.
                </div>
              ) : (
                <div className="vm-maintenance-list">
                  {maintenance.map((m) => {
                    const sc = statusClass(
                      m.next_date,
                      m.next_hours != null ? m.next_hours : null,
                      selectedVehicle.hours,
                    );
                    const sl = statusLabel(
                      m.next_date,
                      m.next_hours != null ? m.next_hours : null,
                      selectedVehicle.hours,
                    );
                    return (
                      <div key={m.id} className={`vm-maint-card ${sc}`}>
                        <div className="vm-maint-card-top">
                          <div className="vm-maint-type">{m.type}</div>
                          <div className="vm-maint-card-actions">
                            <button
                              className="vm-icon-btn"
                              title="Modifier"
                              onClick={() => {
                                setEditTarget(m);
                                setModal("edit-maint");
                              }}
                            >
                              ✏️
                            </button>
                            <button
                              className="vm-icon-btn vm-icon-btn--danger"
                              title="Supprimer"
                              onClick={() => handleDeleteMaintenance(m)}
                            >
                              🗑️
                            </button>
                          </div>
                        </div>
                        <div className="vm-maint-details">
                          <span>📅 Réalisé le {fmtDate(m.date)}</span>
                          {m.hours_at_service != null && (
                            <span>⏱ {m.hours_at_service} h</span>
                          )}
                        </div>
                        {(m.next_date || m.next_hours != null) && (
                          <div className={`vm-maint-next ${sc}`}>
                            Prochain : {sl}
                            {m.next_date && (
                              <span className="vm-maint-next-date">
                                {" "}
                                · {fmtDate(m.next_date)}
                              </span>
                            )}
                            {m.next_hours != null && (
                              <span className="vm-maint-next-date">
                                {" "}
                                · {m.next_hours} h
                              </span>
                            )}
                          </div>
                        )}
                        {m.notes && (
                          <div className="vm-maint-notes">💬 {m.notes}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Modals ── */}
      {modal === "add-vehicle" && (
        <Modal title="Ajouter un véhicule" onClose={() => setModal(null)}>
          <VehicleForm
            onSubmit={handleAddVehicle}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}
      {modal === "edit-vehicle" && editTarget && (
        <Modal title="Modifier le véhicule" onClose={() => setModal(null)}>
          <VehicleForm
            initial={editTarget}
            onSubmit={handleEditVehicle}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}
      {modal === "add-maint" && (
        <Modal title="Ajouter un entretien" onClose={() => setModal(null)}>
          <MaintenanceForm
            currentHours={selectedVehicle?.hours}
            onSubmit={handleAddMaintenance}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}
      {modal === "edit-maint" && editTarget && (
        <Modal title="Modifier l'entretien" onClose={() => setModal(null)}>
          <MaintenanceForm
            initial={editTarget}
            currentHours={selectedVehicle?.hours}
            onSubmit={handleEditMaintenance}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}
    </>
  );
}

function vehicleIcon(type) {
  const map = {
    Tracteur: "🚜",
    Moissonneuse: "🌾",
    Pulvérisateur: "💧",
    Remorque: "📦",
    Voiture: "🚗",
    Autre: "🔧",
  };
  return map[type] || "🔧";
}
