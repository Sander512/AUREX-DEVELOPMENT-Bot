"use client";
import { useRouter } from "next/navigation";

const STATUSES = [
  "PENDING", "AWAITING_PAYMENT", "PAID", "IN_PROGRESS",
  "AWAITING_CUSTOMER", "COMPLETED", "CANCELLED", "REFUNDED",
];

export default function OrderStatusSelect({ guildId, orderId, status }) {
  const router = useRouter();

  async function handleChange(e) {
    const newStatus = e.target.value;
    await fetch(`/api/orders`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guildId, orderId, status: newStatus }),
    });
    router.refresh();
  }

  return (
    <select
      defaultValue={status}
      onChange={handleChange}
      style={{ background: "#0b0b0d", border: "1px solid #333", color: "#f2f2f2", borderRadius: "6px", padding: "0.3rem 0.5rem" }}
    >
      {STATUSES.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}
