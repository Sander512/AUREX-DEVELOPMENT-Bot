"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function SettingsForm({ guildId, initial }) {
  const router = useRouter();
  const [form, setForm] = useState({
    accentColor: initial.accentColor || "#C9A227",
    welcomeEnabled: initial.welcomeEnabled || false,
    welcomeChannelId: initial.welcomeChannelId || "",
    welcomeMessage: initial.welcomeMessage || "",
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);

    await fetch(`/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, guildId }),
    });

    setSaving(false);
    setSaved(true);
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
    <form onSubmit={handleSubmit} style={{ display: "grid", gap: "0.75rem", maxWidth: "480px" }}>
      <label style={{ fontSize: "0.8rem", color: "#999" }}>Accentkleur</label>
      <input
        type="color"
        value={form.accentColor}
        onChange={(e) => setForm({ ...form, accentColor: e.target.value })}
        style={{ width: "60px", height: "36px", border: "none", background: "none" }}
      />

      <label style={{ fontSize: "0.8rem", color: "#999", marginTop: "0.5rem" }}>
        <input
          type="checkbox"
          checked={form.welcomeEnabled}
          onChange={(e) => setForm({ ...form, welcomeEnabled: e.target.checked })}
          style={{ marginRight: "0.5rem" }}
        />
        Welkomstbericht ingeschakeld
      </label>

      <input
        style={inputStyle}
        placeholder="Welkomstkanaal-ID"
        value={form.welcomeChannelId}
        onChange={(e) => setForm({ ...form, welcomeChannelId: e.target.value })}
      />
      <textarea
        style={{ ...inputStyle, minHeight: "80px" }}
        placeholder="Welkomstbericht (gebruik {user}, {username}, {server})"
        value={form.welcomeMessage}
        onChange={(e) => setForm({ ...form, welcomeMessage: e.target.value })}
      />

      <button
        type="submit"
        disabled={saving}
        style={{ background: "#c9a227", color: "#0b0b0d", border: "none", borderRadius: "6px", padding: "0.6rem", fontWeight: 600, cursor: "pointer" }}
      >
        {saving ? "Opslaan..." : "Opslaan"}
      </button>
      {saved && <span style={{ color: "#4caf50", fontSize: "0.85rem" }}>Opgeslagen.</span>}
    </form>
  );
}
