import { useCallback, useEffect, useMemo, useState } from "react";
import Nav from "../components/Nav.jsx";
import { useAuth } from "../contexts/AuthContext.jsx";
import usePageMeta from "../hooks/usePageMeta.js";
import "./PhytoPage.css";

const PRODUCT_CATEGORIES = [
  "Herbicide",
  "Fongicide",
  "Insecticide",
  "Adjuvant",
  "Biostimulant",
  "Engrais foliaire",
  "Autre",
];

const PRODUCT_UNITS = ["L", "kg", "g", "ml", "dose"];

function fmtDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("fr-FR");
}

function categoryClass(category) {
  return `pp-badge pp-badge-${String(category || "autre")
    .toLowerCase()
    .replaceAll(" ", "-")}`;
}

function Modal({ title, onClose, children }) {
  return (
    <div className="pp-overlay" onClick={onClose}>
      <div className="pp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pp-modal-header">
          <span>{title}</span>
          <button className="pp-close-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="pp-modal-body">{children}</div>
      </div>
    </div>
  );
}

function ProductForm({ initial, onSubmit, onCancel }) {
  const [form, setForm] = useState({
    name: initial?.name || "",
    category: initial?.category || PRODUCT_CATEGORIES[0],
    stock: initial?.stock ?? "",
    unit: initial?.unit || PRODUCT_UNITS[0],
    dose: initial?.dose || "",
    phi: initial?.phi ?? "",
    reentry_hours: initial?.reentry_hours ?? "",
    notes: initial?.notes || "",
  });

  const set = (key) => (e) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

  return (
    <form
      className="pp-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(form);
      }}
    >
      <div className="pp-form-row">
        <label>Nom du produit *</label>
        <input
          required
          value={form.name}
          onChange={set("name")}
          placeholder="ex: Atlantis WG"
        />
      </div>
      <div className="pp-form-row2">
        <div className="pp-form-row">
          <label>Catégorie</label>
          <select value={form.category} onChange={set("category")}>
            {PRODUCT_CATEGORIES.map((category) => (
              <option key={category}>{category}</option>
            ))}
          </select>
        </div>
        <div className="pp-form-row">
          <label>Unité</label>
          <select value={form.unit} onChange={set("unit")}>
            {PRODUCT_UNITS.map((unit) => (
              <option key={unit}>{unit}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="pp-form-row2">
        <div className="pp-form-row">
          <label>Stock</label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={form.stock}
            onChange={set("stock")}
            placeholder="0"
          />
        </div>
        <div className="pp-form-row">
          <label>Dose conseillée</label>
          <input
            value={form.dose}
            onChange={set("dose")}
            placeholder="ex: 0.8 L/ha"
          />
        </div>
      </div>
      <div className="pp-form-row2">
        <div className="pp-form-row">
          <label>DAR (jours)</label>
          <input
            type="number"
            min={0}
            value={form.phi}
            onChange={set("phi")}
            placeholder="21"
          />
        </div>
        <div className="pp-form-row">
          <label>Rentrée (heures)</label>
          <input
            type="number"
            min={0}
            value={form.reentry_hours}
            onChange={set("reentry_hours")}
            placeholder="6"
          />
        </div>
      </div>
      <div className="pp-form-row">
        <label>Notes</label>
        <textarea
          rows={3}
          value={form.notes}
          onChange={set("notes")}
          placeholder="Observations, cultures concernées, précautions..."
        />
      </div>
      <div className="pp-form-actions">
        <button
          type="button"
          className="pp-btn pp-btn-ghost"
          onClick={onCancel}
        >
          Annuler
        </button>
        <button type="submit" className="pp-btn pp-btn-primary">
          Enregistrer
        </button>
      </div>
    </form>
  );
}

function ApplicationForm({
  initial,
  products,
  selectedProductId,
  onSubmit,
  onCancel,
}) {
  const [form, setForm] = useState({
    date: initial?.date
      ? initial.date.split("T")[0]
      : new Date().toISOString().split("T")[0],
    parcel: initial?.parcel || "",
    product_id: String(
      initial?.product_id || selectedProductId || products[0]?.id || "",
    ),
    dose_applied: initial?.dose_applied || "",
    surface: initial?.surface ?? "",
    operator: initial?.operator || "",
    weather: initial?.weather || "",
    notes: initial?.notes || "",
  });

  const set = (key) => (e) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

  return (
    <form
      className="pp-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(form);
      }}
    >
      <div className="pp-form-row2">
        <div className="pp-form-row">
          <label>Date *</label>
          <input
            required
            type="date"
            value={form.date}
            onChange={set("date")}
          />
        </div>
        <div className="pp-form-row">
          <label>Parcelle *</label>
          <input
            required
            value={form.parcel}
            onChange={set("parcel")}
            placeholder="Champ Nord"
          />
        </div>
      </div>
      <div className="pp-form-row">
        <label>Produit *</label>
        <select required value={form.product_id} onChange={set("product_id")}>
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name}
            </option>
          ))}
        </select>
      </div>
      <div className="pp-form-row2">
        <div className="pp-form-row">
          <label>Dose appliquée</label>
          <input
            value={form.dose_applied}
            onChange={set("dose_applied")}
            placeholder="0.75 L/ha"
          />
        </div>
        <div className="pp-form-row">
          <label>Surface (ha)</label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={form.surface}
            onChange={set("surface")}
            placeholder="8.5"
          />
        </div>
      </div>
      <div className="pp-form-row2">
        <div className="pp-form-row">
          <label>Opérateur</label>
          <input
            value={form.operator}
            onChange={set("operator")}
            placeholder="Mathieu"
          />
        </div>
        <div className="pp-form-row">
          <label>Météo</label>
          <input
            value={form.weather}
            onChange={set("weather")}
            placeholder="Sec, vent faible"
          />
        </div>
      </div>
      <div className="pp-form-row">
        <label>Notes</label>
        <textarea
          rows={3}
          value={form.notes}
          onChange={set("notes")}
          placeholder="Mélange, stade culture, remarques..."
        />
      </div>
      <div className="pp-form-actions">
        <button
          type="button"
          className="pp-btn pp-btn-ghost"
          onClick={onCancel}
        >
          Annuler
        </button>
        <button type="submit" className="pp-btn pp-btn-primary">
          Enregistrer
        </button>
      </div>
    </form>
  );
}

export default function PhytoPage() {
  const { csrfToken, refreshCsrfToken } = useAuth();
  const [products, setProducts] = useState([]);
  const [applications, setApplications] = useState([]);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [editTarget, setEditTarget] = useState(null);

  usePageMeta("Phyto", "/assets/icons8-champ-32.png");

  const apiFetch = useCallback(
    async (url, options = {}) => {
      const method = (options.method || "GET").toUpperCase();
      const unsafe = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
      let token = csrfToken;
      if (unsafe && !token) token = await refreshCsrfToken();

      let body = options.body;
      if (unsafe && token && typeof options.body === "string") {
        try {
          body = JSON.stringify({ ...JSON.parse(options.body), _csrf: token });
        } catch {
          body = options.body;
        }
      }

      const requestOptions = {
        ...options,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": token || "",
          ...options.headers,
        },
        body,
      };

      const res = await fetch(url, requestOptions);
      if (res.status === 403 && unsafe) {
        const fresh = await refreshCsrfToken();
        const retryOptions = {
          ...requestOptions,
          headers: {
            ...requestOptions.headers,
            "x-csrf-token": fresh || "",
          },
        };
        if (typeof options.body === "string") {
          try {
            retryOptions.body = JSON.stringify({
              ...JSON.parse(options.body),
              _csrf: fresh,
            });
          } catch {
            retryOptions.body = options.body;
          }
        }
        const retryRes = await fetch(url, retryOptions);
        if (!retryRes.ok) throw new Error(`HTTP ${retryRes.status}`);
        return retryRes.json();
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    [csrfToken, refreshCsrfToken],
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [productsData, applicationsData] = await Promise.all([
        apiFetch("/api/phyto/products"),
        apiFetch("/api/phyto/applications"),
      ]);
      setProducts(productsData);
      setApplications(applicationsData);
    } catch (error) {
      console.error("Erreur chargement phyto:", error);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!selectedProduct) return;
    const stillExists = products.find(
      (product) => product.id === selectedProduct.id,
    );
    if (!stillExists) {
      setSelectedProduct(null);
    } else if (stillExists !== selectedProduct) {
      setSelectedProduct(stillExists);
    }
  }, [products, selectedProduct]);

  const filteredApplications = useMemo(() => {
    if (!selectedProduct) return applications;
    return applications.filter(
      (application) =>
        Number(application.product_id) === Number(selectedProduct.id),
    );
  }, [applications, selectedProduct]);

  const stats = useMemo(() => {
    const lowStockCount = products.filter(
      (product) =>
        Number(product.stock || 0) > 0 && Number(product.stock || 0) <= 5,
    ).length;
    const totalSurface = applications.reduce(
      (sum, application) => sum + Number(application.surface || 0),
      0,
    );
    const month = new Date().getMonth();
    const year = new Date().getFullYear();
    const thisMonthCount = applications.filter((application) => {
      const d = new Date(application.date);
      return d.getMonth() === month && d.getFullYear() === year;
    }).length;
    return { lowStockCount, totalSurface, thisMonthCount };
  }, [products, applications]);

  const productNameById = useMemo(
    () =>
      Object.fromEntries(
        products.map((product) => [String(product.id), product.name]),
      ),
    [products],
  );

  const createProduct = async (payload) => {
    await apiFetch("/api/phyto/products", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    setModal(null);
    await loadData();
  };

  const updateProduct = async (payload) => {
    await apiFetch(`/api/phyto/products/${editTarget.id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    setModal(null);
    setEditTarget(null);
    await loadData();
  };

  const deleteProduct = async (product) => {
    if (
      !confirm(
        `Supprimer le produit "${product.name}" et ses interventions associées ?`,
      )
    ) {
      return;
    }
    await apiFetch(`/api/phyto/products/${product.id}`, { method: "DELETE" });
    if (selectedProduct?.id === product.id) setSelectedProduct(null);
    await loadData();
  };

  const createApplication = async (payload) => {
    await apiFetch("/api/phyto/applications", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    setModal(null);
    await loadData();
  };

  const updateApplication = async (payload) => {
    await apiFetch(`/api/phyto/applications/${editTarget.id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    setModal(null);
    setEditTarget(null);
    await loadData();
  };

  const deleteApplication = async (application) => {
    if (
      !confirm(`Supprimer l'intervention du ${fmtDate(application.date)} ?`)
    ) {
      return;
    }
    await apiFetch(`/api/phyto/applications/${application.id}`, {
      method: "DELETE",
    });
    await loadData();
  };

  return (
    <>
      <Nav />
      <div className="pp-page">
        <div className="pp-summary-grid">
          <div className="pp-summary-card">
            <span className="pp-summary-label">Produits</span>
            <strong>{products.length}</strong>
          </div>
          <div className="pp-summary-card">
            <span className="pp-summary-label">Alertes stock</span>
            <strong>{stats.lowStockCount}</strong>
          </div>
          <div className="pp-summary-card">
            <span className="pp-summary-label">Interventions du mois</span>
            <strong>{stats.thisMonthCount}</strong>
          </div>
          <div className="pp-summary-card">
            <span className="pp-summary-label">Surface traitée</span>
            <strong>{stats.totalSurface.toFixed(1)} ha</strong>
          </div>
        </div>

        <div className="pp-layout">
          <section className="pp-panel pp-panel-left">
            <div className="pp-panel-header">
              <div>
                <h2>Produits phyto</h2>
                <span className="pp-panel-subtitle">
                  Stock, DAR, rentrée et notes
                </span>
              </div>
              <button
                className="pp-btn pp-btn-primary"
                onClick={() => setModal("add-product")}
              >
                + Produit
              </button>
            </div>

            {loading ? (
              <div className="pp-empty">Chargement…</div>
            ) : products.length === 0 ? (
              <div className="pp-empty">Aucun produit enregistré.</div>
            ) : (
              <div className="pp-product-list">
                {products.map((product) => {
                  const selected = selectedProduct?.id === product.id;
                  const lowStock =
                    Number(product.stock || 0) > 0 &&
                    Number(product.stock || 0) <= 5;
                  return (
                    <article
                      key={product.id}
                      className={`pp-product-card ${selected ? "pp-product-card-active" : ""}`}
                      onClick={() =>
                        setSelectedProduct(selected ? null : product)
                      }
                    >
                      <div className="pp-product-card-top">
                        <div>
                          <div className="pp-product-name">{product.name}</div>
                          <div className="pp-product-meta-row">
                            <span className={categoryClass(product.category)}>
                              {product.category}
                            </span>
                            {product.dose && (
                              <span className="pp-inline-meta">
                                Dose: {product.dose}
                              </span>
                            )}
                          </div>
                        </div>
                        <div
                          className="pp-card-actions"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            className="pp-icon-btn"
                            onClick={() => {
                              setEditTarget(product);
                              setModal("edit-product");
                            }}
                            title="Modifier"
                          >
                            ✏️
                          </button>
                          <button
                            className="pp-icon-btn pp-icon-btn-danger"
                            onClick={() => deleteProduct(product)}
                            title="Supprimer"
                          >
                            🗑️
                          </button>
                        </div>
                      </div>
                      <div className="pp-product-meta-row">
                        <span>
                          Stock: {product.stock || 0} {product.unit || ""}
                        </span>
                        {product.phi ? <span>DAR: {product.phi} j</span> : null}
                        {product.reentry_hours ? (
                          <span>Rentrée: {product.reentry_hours} h</span>
                        ) : null}
                      </div>
                      {lowStock && (
                        <div className="pp-alert pp-alert-warning">
                          Stock bas
                        </div>
                      )}
                      {product.notes && (
                        <div className="pp-notes">{product.notes}</div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <section className="pp-panel pp-panel-right">
            <div className="pp-panel-header">
              <div>
                <h2>Interventions</h2>
                <span className="pp-panel-subtitle">
                  {selectedProduct
                    ? `Filtré sur ${selectedProduct.name}`
                    : "Historique de tous les traitements"}
                </span>
              </div>
              <div className="pp-header-actions">
                {selectedProduct ? (
                  <button
                    className="pp-btn pp-btn-ghost"
                    onClick={() => setSelectedProduct(null)}
                  >
                    Réinitialiser
                  </button>
                ) : null}
                <button
                  className="pp-btn pp-btn-primary"
                  onClick={() => setModal("add-application")}
                  disabled={products.length === 0}
                >
                  + Intervention
                </button>
              </div>
            </div>

            {products.length === 0 ? (
              <div className="pp-empty pp-empty-center">
                Ajoute d'abord un produit pour enregistrer une intervention.
              </div>
            ) : loading ? (
              <div className="pp-empty">Chargement…</div>
            ) : filteredApplications.length === 0 ? (
              <div className="pp-empty pp-empty-center">
                Aucune intervention enregistrée.
              </div>
            ) : (
              <div className="pp-application-list">
                {filteredApplications.map((application) => (
                  <article key={application.id} className="pp-application-card">
                    <div className="pp-application-top">
                      <div>
                        <div className="pp-application-title">
                          {application.parcel}
                        </div>
                        <div className="pp-product-meta-row">
                          <span className="pp-badge pp-badge-neutral">
                            {productNameById[String(application.product_id)] ||
                              "Produit supprimé"}
                          </span>
                          <span>{fmtDate(application.date)}</span>
                          {application.surface ? (
                            <span>{application.surface} ha</span>
                          ) : null}
                        </div>
                      </div>
                      <div className="pp-card-actions">
                        <button
                          className="pp-icon-btn"
                          onClick={() => {
                            setEditTarget(application);
                            setModal("edit-application");
                          }}
                          title="Modifier"
                        >
                          ✏️
                        </button>
                        <button
                          className="pp-icon-btn pp-icon-btn-danger"
                          onClick={() => deleteApplication(application)}
                          title="Supprimer"
                        >
                          🗑️
                        </button>
                      </div>
                    </div>
                    <div className="pp-product-meta-row">
                      {application.dose_applied ? (
                        <span>Dose: {application.dose_applied}</span>
                      ) : null}
                      {application.operator ? (
                        <span>Opérateur: {application.operator}</span>
                      ) : null}
                      {application.weather ? (
                        <span>Météo: {application.weather}</span>
                      ) : null}
                    </div>
                    {application.notes ? (
                      <div className="pp-notes">{application.notes}</div>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {modal === "add-product" ? (
        <Modal title="Ajouter un produit phyto" onClose={() => setModal(null)}>
          <ProductForm
            onSubmit={createProduct}
            onCancel={() => setModal(null)}
          />
        </Modal>
      ) : null}

      {modal === "edit-product" && editTarget ? (
        <Modal title="Modifier le produit" onClose={() => setModal(null)}>
          <ProductForm
            initial={editTarget}
            onSubmit={updateProduct}
            onCancel={() => setModal(null)}
          />
        </Modal>
      ) : null}

      {modal === "add-application" ? (
        <Modal title="Ajouter une intervention" onClose={() => setModal(null)}>
          <ApplicationForm
            products={products}
            selectedProductId={selectedProduct?.id}
            onSubmit={createApplication}
            onCancel={() => setModal(null)}
          />
        </Modal>
      ) : null}

      {modal === "edit-application" && editTarget ? (
        <Modal title="Modifier l'intervention" onClose={() => setModal(null)}>
          <ApplicationForm
            initial={editTarget}
            products={products}
            selectedProductId={selectedProduct?.id}
            onSubmit={updateApplication}
            onCancel={() => setModal(null)}
          />
        </Modal>
      ) : null}
    </>
  );
}
