import { createHash } from "node:crypto"

/** "900.555.111-2" → "900555111" (quita puntos, espacios y dígito de verificación). */
export function normalizarNit(nit: string): string {
  const sinDv = nit.trim().replace(/-\s*\d\s*$/, "")
  return sinDv.replace(/\D/g, "")
}

/** "Papelería Central Ltda." → "papeleria central ltda" */
export function normalizarNombre(nombre: string): string {
  return nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** "COP 11.400.000" → 11400000. Devuelve null si no hay número. */
export function parsearMonto(texto: string): number | null {
  const m = texto.match(/(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?/)
  if (!m) return null
  const entero = Number(m[1].replace(/\./g, ""))
  const dec = m[2] ? Number(`0.${m[2]}`) : 0
  const n = entero + dec
  return Number.isFinite(n) ? n : null
}

/**
 * Día calendario de una fecha ISO tal como la vio quien la escribió (hora local del correo).
 * "2026-08-26T18:45:00-05:00" → "2026-08-26" (en UTC sería el 27: por eso no se convierte).
 */
export function diaLocal(fechaIso: string): string {
  return fechaIso.slice(0, 10)
}

export function sha256(texto: string): string {
  return createHash("sha256").update(texto, "utf8").digest("hex")
}

/** Stringify estable (claves ordenadas) para comparar objetos. */
export function jsonEstable(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(jsonEstable).join(",")}]`
  if (valor && typeof valor === "object") {
    const entradas = Object.entries(valor as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
    return `{${entradas.map(([k, v]) => `${JSON.stringify(k)}:${jsonEstable(v)}`).join(",")}}`
  }
  return JSON.stringify(valor)
}

export function mensajeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
