"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

const CATEGORIES = [
  "CUSTOM_HUDS",
  "OX_INVENTORY",
  "REFUND_SYSTEMS",
  "FIVEM_SCRIPTS",
  "STAFF_ASSIST",
  "CUSTOM_DEVELOPMENT",
  "INSTALLATION_SERVICES",
];

export default function ProductForm({ guildId }) {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", slug: "", description: "", category: CATEGORIES[0], price: "" });
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    const res = await fetch(`/api/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        guildId,
        priceCents: Math.round(parseFloat(form.price || "0") * 100),
      }),
    });

    setSubmitting(false);

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Er ging iets mis.");
      return;
    }

    setForm({ name: "", slug: "", description: "", category: CATEGORIES[0], price: "" });
    router.refresh();
  }

  const inputStyle = {
    background: "#0b0b0d",
    border: "1px solid #333",
    borderRadius: "6px",
    color: "#f2f2f2",
    padding: "0.5rem 0.75rem",
    fontSize: "0.9rem",
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: "grid", gap: "0.75rem", maxWidth: "480px", marginBottom: "2rem" }}>
      <input
        style={inputStyle}
        placeholder="Naam"
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value, slug: e.target.value.toLowerCase().replace(/\s+/g, "-") })}
        required
      />
      <input style={inputStyle} placeholder="Slug" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} required />
      <textarea
        style={{ ...inputStyle, minHeight: "70px" }}
        placeholder="Beschrijving"
        value={form.description}
        onChange={(e) => setForm({ ...form, description: e.target.value })}
      />
      <select style={inputStyle} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <input
        style={inputStyle}
        placeholder="Prijs (EUR, bv. 29.99)"
        value={form.price}
        onChange={(e) => setForm({ ...form, price: e.target.value })}
        required
      />

      {error && <div style={{ color: "#e5484d" }}>{error}</div>}

      <button
        type="submit"
        disabled={submitting}
        style={{ background: "#c9a227", color: "#0b0b0d", border: "none", borderRadius: "6px", padding: "0.6rem", fontWeight: 600, cursor: "pointer" }}
      >
        {submitting ? "Bezig..." : "Product toevoegen"}
      </button>
    </form>
  );
}
