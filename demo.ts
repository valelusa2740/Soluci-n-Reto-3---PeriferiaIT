/**
 * Verificación sin modelo (PRD 6.6): procesa los 6 casos llamando directo a las herramientas.
 * Determinista: limpia out/ al inicio. Uso: `npm run demo` o `bun run demo.ts`.
 */
import { rm } from "node:fs/promises"
import path from "node:path"
import type { Ctx } from "./src/core/rutas.js"
import { ejecutarHerramienta } from "./src/tools/registro.js"

type Res = { ok: boolean; data: Record<string, unknown>; error: string }
type Hallazgo = { regla: string; detalle: string }
type Val = { apta: boolean; bloqueos: Hallazgo[]; confirmaciones: Hallazgo[]; derivados: Record<string, string>; retroactiva: boolean }

const directory = path.dirname(new URL(import.meta.url).pathname)
// Simula al humano: solo cuentan los casos que "la analista" confirmó explícitamente.
const confirmadosPorHumano = new Set<string>()
const ctx: Ctx = { directory, sessionId: "demo", confirmacionHumana: (c) => confirmadosPorHumano.has(c) }

async function llamar(nombre: string, args: Record<string, unknown>): Promise<Res> {
  return JSON.parse((await ejecutarHerramienta(nombre, args, ctx)).resultado) as Res
}

const lista = (h: Hallazgo[]) => (h.length ? h.map((x) => `\n      - ${x.regla}: ${x.detalle}`).join("") : " —")

async function procesar(caso: string, confirmado = false): Promise<void> {
  console.log(`\n▶ ${caso}${confirmado ? " (con confirmación explícita de la analista)" : ""}`)
  const paquete = await llamar("oc_leer_paquete", { caso })
  if (!paquete.ok) return void console.log(`  ✗ ${paquete.error}`)
  const v = await llamar("oc_validar", { caso, paquete: paquete.data })
  if (!v.ok) return void console.log(`  ✗ ${v.error}`)
  const val = v.data as unknown as Val
  console.log(`  apta: ${val.apta} · retroactiva: ${val.retroactiva}`)
  console.log(`  bloqueos:${lista(val.bloqueos)}`)
  console.log(`  confirmaciones:${lista(val.confirmaciones)}`)
  if (Object.keys(val.derivados).length) console.log(`  derivados: ${JSON.stringify(val.derivados)}`)

  let orden: Record<string, unknown> = {}
  if (val.apta) {
    const p = await llamar("oc_construir_payload", { caso, paquete: paquete.data, derivados: val.derivados })
    if (p.ok) orden = p.data.orden as Record<string, unknown>
    const ev = await llamar("oc_generar_evidencia", { caso })
    if (ev.ok) console.log(`  evidencia: ${String(ev.data.ruta)} (sha256 ${String(ev.data.sha256).slice(0, 12)}…)`)
  }
  const r = await llamar("oc_crear", { caso, payload: orden, confirmado })
  if (r.ok) {
    const d = r.data
    console.log(`  ✔ OC ${String(d.numero_oc)}${d.idempotente ? " (idempotente: ya existía, no se duplicó)" : " creada"}`)
  } else {
    console.log(`  ✗ No creada: ${r.error}`)
  }
}

async function main(): Promise<void> {
  await rm(path.join(directory, "out"), { recursive: true, force: true })
  console.log("Demo sin modelo — Agente Órdenes de Compra SAP (out/ limpio)")
  await procesar("sol-001")
  await procesar("sol-001") // idempotencia: devuelve el mismo número
  await procesar("sol-002")
  await procesar("sol-003")
  await procesar("sol-004") // sin confirmación: queda pendiente
  confirmadosPorHumano.add("sol-004")
  await procesar("sol-004", true) // confirmación explícita
  await procesar("sol-005") // retroactiva: pendiente
  confirmadosPorHumano.add("sol-005")
  await procesar("sol-005", true)
  await procesar("sol-006")
  confirmadosPorHumano.add("sol-006")
  await procesar("sol-006", true)
  console.log("\nSalidas: out/control.csv · out/log.jsonl · out/sap/ordenes.jsonl · out/<caso>/{trazabilidad.json,aprobacion.txt}")
}

main().catch((e: unknown) => {
  console.error("La demo falló:", e)
  process.exitCode = 1
})
