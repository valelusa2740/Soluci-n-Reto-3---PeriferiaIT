/**
 * Proveedor "local": implementación determinista de LlmAdapter, sin modelo ni clave.
 * Sirve para probar el chat sin gastar tokens y demuestra que cambiar de proveedor no toca el ciclo.
 * Entiende "procesa sol-00X" y "confirmo"; sigue el mismo flujo que pide agent/prompt.md.
 */
import type { Bloque, LlmAdapter, Mensaje, RespuestaLlm } from "./adapter.js"

type Paso = { nombre: string; args: Record<string, unknown>; r: { ok: boolean; data?: Record<string, unknown>; error?: string } }
type Hallazgo = { regla: string; detalle: string; accion_sugerida?: string }

const fmt = (n: unknown) => (typeof n === "number" ? n.toLocaleString("es-CO") : String(n))

export class LocalAdapter implements LlmAdapter {
  readonly proveedor = "local"
  readonly modelo = "determinista-sin-llm"

  async enviar(mensajes: Mensaje[]): Promise<RespuestaLlm> {
    const iUsuario = mensajes.findLastIndex((m) => m.rol === "usuario" && m.bloques.some((b) => b.tipo === "texto"))
    const texto = mensajes[iUsuario]?.bloques.flatMap((b) => (b.tipo === "texto" ? [b.texto] : [])).join(" ") ?? ""
    const pasos = pasosDelTurno(mensajes.slice(iUsuario + 1))
    const confirmado = texto.match(/CONFIRMÓ el caso (sol-[a-z0-9-]+)/)?.[1]
    const propio = texto.replace(/\[Nota del servidor:[^\]]*\]/g, "")
    const caso = confirmado ?? propio.match(/sol-\d{3}/i)?.[0].toLowerCase()
    const bloques = caso ? siguiente(caso, pasos, Boolean(confirmado), /no la crees|hasta que|antes de crear|sin crear/i.test(texto)) : [textoB(ayuda())]
    return { bloques, uso: { entrada: 0, salida: 0 } }
  }
}

function pasosDelTurno(ms: Mensaje[]): Paso[] {
  const llamadas = new Map<string, { nombre: string; args: Record<string, unknown> }>()
  const pasos: Paso[] = []
  for (const b of ms.flatMap((m) => m.bloques)) {
    if (b.tipo === "llamada") llamadas.set(b.id, { nombre: b.nombre, args: b.args as Record<string, unknown> })
    if (b.tipo === "resultado") {
      const l = llamadas.get(b.id)
      if (l) pasos.push({ ...l, r: JSON.parse(b.contenido) as Paso["r"] })
    }
  }
  return pasos
}

const textoB = (texto: string): Bloque => ({ tipo: "texto", texto })
let contador = 0
const llamar = (nombre: string, args: Record<string, unknown>): Bloque[] => [{ tipo: "llamada", id: `local-${++contador}`, nombre, args }]

function siguiente(caso: string, pasos: Paso[], confirmado: boolean, soloRevisar: boolean): Bloque[] {
  const de = (n: string) => pasos.find((p) => p.nombre === n)
  const paquete = de("oc_leer_paquete")
  if (!paquete) return llamar("oc_leer_paquete", { caso })
  if (!paquete.r.ok) return [textoB(`❌ No pude leer **${caso}**: ${paquete.r.error}`)]
  const val = de("oc_validar")
  if (!val) return llamar("oc_validar", { caso, paquete: paquete.r.data })
  if (!val.r.ok) return [textoB(`❌ ${val.r.error}`)]
  const v = val.r.data as { apta: boolean; bloqueos: Hallazgo[]; confirmaciones: Hallazgo[]; derivados: Record<string, string>; retroactiva: boolean }
  if (!v.apta) return [textoB(resumenBloqueos(caso, v.bloqueos))]
  const payload = de("oc_construir_payload")
  if (!payload) return llamar("oc_construir_payload", { caso, paquete: paquete.r.data, derivados: v.derivados })
  if (!payload.r.ok) return [textoB(`❌ ${payload.r.error}`)]
  const orden = (payload.r.data as { orden: Record<string, unknown> }).orden
  if (!de("oc_generar_evidencia")) return llamar("oc_generar_evidencia", { caso })
  const necesitaConfirmar = v.confirmaciones.length > 0 || soloRevisar
  if (necesitaConfirmar && !confirmado) return [textoB(`${tablaOc(caso, orden, v)}\n\n❓ **¿Confirmas que cree la OC de ${caso}?** Responde "confirmo" para crearla.`)]
  const crear = de("oc_crear")
  if (!crear) return llamar("oc_crear", { caso, payload: orden, confirmado })
  if (!crear.r.ok) return [textoB(`❌ ${crear.r.error}`)]
  const d = crear.r.data as { numero_oc: string; idempotente: boolean; retroactiva: boolean; evidencia?: string }
  const extra = d.retroactiva ? "\n\n⚠️ OC **retroactiva**: quedó marcada en `out/control.csv`." : ""
  const evid = d.evidencia ? ` Evidencia: \`${d.evidencia}\`.` : ""
  return [textoB(`✅ **OC ${d.numero_oc}** ${d.idempotente ? "ya existía (no se duplicó)" : "creada"} para ${caso}.${evid}${extra}\n\n${tablaOc(caso, orden, v)}`)]
}

function resumenBloqueos(caso: string, bloqueos: Hallazgo[]): string {
  const lista = bloqueos.map((b) => `- **${b.regla}**: ${b.detalle}\n  ↳ Acción sugerida: ${b.accion_sugerida ?? "-"}`).join("\n")
  return `⛔ **${caso} bloqueada.** No se crea la OC.\n\n${lista}`
}

function tablaOc(caso: string, o: Record<string, unknown>, v: { confirmaciones: Hallazgo[]; derivados: Record<string, string>; retroactiva: boolean }): string {
  const prov = o.proveedor as { codigo_sap: string; nit: string; nombre: string }
  const pos = (o.posiciones as { descripcion: string; cantidad: number; unidad: string; precio_unitario: number; centro_costo: string; subarea: string; indicador_iva: string }[])[0]
  const aprob = o.aprobador as { email: string }
  const filas = [
    ["Proveedor", `${prov.nombre} (${prov.codigo_sap}, NIT ${prov.nit})`],
    ["Descripción", pos.descripcion],
    ["Cantidad", `${fmt(pos.cantidad)} ${pos.unidad}`],
    ["Precio unitario", `${fmt(pos.precio_unitario)} ${String(o.moneda)}`],
    ["Total", `${fmt(pos.cantidad * pos.precio_unitario)} ${String(o.moneda)}`],
    ["Centro / subárea", `${pos.centro_costo} / ${pos.subarea}`],
    ["IVA", pos.indicador_iva],
    ["Condiciones de pago", String(o.condiciones_pago)],
    ["Aprobador", aprob.email],
  ]
  const tabla = `| Campo | Valor |\n|---|---|\n${filas.map(([a, b]) => `| ${a} | ${b} |`).join("\n")}`
  const conf = v.confirmaciones.length ? `\n\n**Requiere confirmación:**\n${v.confirmaciones.map((c) => `- ${c.regla}: ${c.detalle}`).join("\n")}` : "\n\nPasó todas las reglas RC1–RC10."
  const der = Object.keys(v.derivados).length ? `\n\nDerivados del maestro de proveedores: ${Object.entries(v.derivados).map(([k, x]) => `${k} = ${x}`).join(", ")}.` : ""
  return `**OC de ${caso} como quedaría en SAP**\n\n${tabla}${conf}${der}`
}

function ayuda(): string {
  return 'Soy el agente de órdenes de compra (modo local, sin modelo). Escríbeme por ejemplo: «Procesa la solicitud sol-004 y no la crees hasta que yo lo confirme».'
}
