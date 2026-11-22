/**
 * Ciclo del agente (PRD 6.3): mensaje → modelo → herramientas → modelo … hasta respuesta de texto,
 * con tope de iteraciones (CA1), tope de tokens (costo), confirmación humana validada por el
 * servidor (CA3) y errores en lenguaje claro sin matar la sesión (CA5). No conoce ningún SDK.
 */
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { Ctx } from "../core/rutas.js"
import { type Bloque, ErrorLlm, type LlmAdapter, type Mensaje } from "../llm/adapter.js"
import { definicionesParaModelo, ejecutarHerramienta } from "../tools/registro.js"

export type Limites = {
  maxIteraciones: number
  maxTokensSesion: number
  maxTokensDia: number
  maxTokensRespuesta: number
  timeoutMs: number
  /** Tiempo máximo total de un turno (el navegador y el proxy no esperan indefinidamente). */
  maxMsTurno?: number
}

export type LlamadaVisible = { nombre: string; args: unknown; ok: boolean; resultado: unknown; ms: number }

export type EventoVisible =
  | { tipo: "usuario"; texto: string; ts: string }
  | { tipo: "herramienta"; llamada: LlamadaVisible; ts: string }
  | { tipo: "agente"; texto: string; needsConfirmation: boolean; ts: string }

export type Sesion = {
  id: string
  mensajes: Mensaje[]
  visible: EventoVisible[]
  tokens: number
  /** Caso que espera confirmación humana; solo el SIGUIENTE mensaje de la persona puede confirmarlo. */
  pendiente: { caso: string; reglas: string[] } | null
}

export type RespuestaTurno = { reply: string; toolCalls: LlamadaVisible[]; needsConfirmation: boolean; pendiente: Sesion["pendiente"] }

export const nuevaSesion = (id: string): Sesion => ({ id, mensajes: [], visible: [], tokens: 0, pendiente: null })

const consumoDiario = { dia: "", tokens: 0 }
function tokensHoy(): number {
  const hoy = new Date().toISOString().slice(0, 10)
  if (consumoDiario.dia !== hoy) Object.assign(consumoDiario, { dia: hoy, tokens: 0 })
  return consumoDiario.tokens
}

/** ¿El mensaje de la persona confirma? Cualquier negación anula. */
export function esConfirmacion(texto: string): boolean {
  const t = texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  if (/\b(no|cancela\w*|rechaz\w*|espera|detente)\b/.test(t)) return false
  return /\b(confirmo|confirmado|confirmada|confirmar|si|apruebo|adelante|procede|crea|creala|dale|ok)\b/.test(t)
}

let promptCache: string | null = null
export async function systemPrompt(directory: string): Promise<string> {
  if (promptCache) return promptCache
  const [prompt, conocimiento] = await Promise.all([
    readFile(path.join(directory, "agent/prompt.md"), "utf8"),
    readFile(path.join(directory, "src/knowledge/ordenes-compra.md"), "utf8"),
  ])
  promptCache = `${prompt}\n\n---\n\n# Conocimiento del proceso (src/knowledge/ordenes-compra.md)\n\n${conocimiento}`
  return promptCache
}

const ahora = () => new Date().toISOString()

function parsear(resultado: string): { ok: boolean; data?: unknown; error?: string } {
  try {
    return JSON.parse(resultado) as { ok: boolean; data?: unknown; error?: string }
  } catch {
    return { ok: false, error: resultado }
  }
}

/** Actualiza el estado de confirmación según lo que devolvieron las herramientas. */
function actualizarPendiente(s: Sesion, nombre: string, args: unknown, r: { ok: boolean; data?: unknown; error?: string }): void {
  const caso = typeof args === "object" && args && "caso" in args ? String((args as { caso: unknown }).caso) : null
  if (!caso) return
  if ((nombre === "oc_validar" || nombre === "oc_procesar") && r.ok) {
    const d = r.data as { apta: boolean; confirmaciones: { regla: string }[] }
    if (d.apta && d.confirmaciones.length) s.pendiente = { caso, reglas: d.confirmaciones.map((c) => c.regla) }
  }
  if (nombre === "oc_crear" && !r.ok && r.error?.startsWith("REQUIERE_CONFIRMACION")) s.pendiente ??= { caso, reglas: [] }
  if (nombre === "oc_crear" && r.ok && s.pendiente?.caso === caso) s.pendiente = null
}

function nota(casoConfirmado: string | null, habiaPendiente: string | null): string {
  if (casoConfirmado) return `\n\n[Nota del servidor: la persona CONFIRMÓ el caso ${casoConfirmado} en este mensaje. Puedes llamar oc_crear con confirmado=true para ese caso.]`
  if (habiaPendiente) return `\n\n[Nota del servidor: este mensaje NO es una confirmación del caso ${habiaPendiente}. No lo crees; si la persona quiere crearlo, vuelve a preguntar.]`
  return ""
}

function recortarHistorial(s: Sesion, max = 60): void {
  if (s.mensajes.length <= max) return
  // Corta en un mensaje de usuario con texto (nunca deja un tool_result huérfano).
  const desde = s.mensajes.findIndex((m, i) => i >= s.mensajes.length - max && m.rol === "usuario" && m.bloques.some((b) => b.tipo === "texto"))
  if (desde > 0) s.mensajes.splice(0, desde)
}

export async function ejecutarTurno(s: Sesion, texto: string, deps: { llm: LlmAdapter; directory: string; limites: Limites }): Promise<RespuestaTurno> {
  const { llm, directory, limites } = deps
  const llamadas: LlamadaVisible[] = []
  s.visible.push({ tipo: "usuario", texto, ts: ahora() })

  const responder = (reply: string): RespuestaTurno => {
    const needsConfirmation = s.pendiente !== null
    s.visible.push({ tipo: "agente", texto: reply, needsConfirmation, ts: ahora() })
    return { reply, toolCalls: llamadas, needsConfirmation, pendiente: s.pendiente }
  }

  if (s.tokens >= limites.maxTokensSesion) return responder("Esta sesión alcanzó su tope de tokens. Abre una sesión nueva para continuar.")
  if (tokensHoy() >= limites.maxTokensDia) return responder("El servicio alcanzó el tope diario de uso del modelo. Intenta mañana o ejecuta demo.ts, que no usa el modelo.")

  // CA3: solo el mensaje inmediatamente siguiente puede confirmar, y solo el caso pendiente.
  const pendienteAnterior = s.pendiente
  const habiaPendiente = pendienteAnterior?.caso ?? null
  const casoConfirmado = habiaPendiente && esConfirmacion(texto) ? habiaPendiente : null
  s.pendiente = null
  const ctx: Ctx = { directory, sessionId: s.id, confirmacionHumana: (c) => c === casoConfirmado }

  const marca = s.mensajes.length
  s.mensajes.push({ rol: "usuario", bloques: [{ tipo: "texto", texto: texto + nota(casoConfirmado, habiaPendiente) }] })
  const [system, herramientas] = [await systemPrompt(directory), definicionesParaModelo()]

  try {
    const limiteTurno = Date.now() + (limites.maxMsTurno ?? 100_000)
    for (let i = 0; i < limites.maxIteraciones; i++) {
      const restante = limiteTurno - Date.now()
      if (restante < 3_000) {
        return responder(`El modelo está respondiendo muy lento y alcancé el tiempo máximo del turno. Lo hecho está en las llamadas a herramientas de arriba; escribe "continúa" para seguir.`)
      }
      const r = await llm.enviar(s.mensajes, herramientas, { system, timeoutMs: Math.min(limites.timeoutMs, restante), maxTokens: limites.maxTokensRespuesta })
      const usados = r.uso.entrada + r.uso.salida
      s.tokens += usados
      consumoDiario.tokens += usados
      s.mensajes.push({ rol: "asistente", bloques: r.bloques })

      const pedidas = r.bloques.filter((b): b is Extract<Bloque, { tipo: "llamada" }> => b.tipo === "llamada")
      const textoModelo = r.bloques.flatMap((b) => (b.tipo === "texto" ? [b.texto] : [])).join("\n").trim()
      if (pedidas.length === 0) return responder(textoModelo || "(sin respuesta del modelo)")

      const resultados: Bloque[] = []
      for (const p of pedidas) {
        const e = await ejecutarHerramienta(p.nombre, p.args, ctx)
        const parsed = parsear(e.resultado)
        actualizarPendiente(s, p.nombre, p.args, parsed)
        const llamada: LlamadaVisible = { nombre: p.nombre, args: p.args, ok: e.ok, resultado: parsed, ms: e.ms }
        llamadas.push(llamada)
        s.visible.push({ tipo: "herramienta", llamada, ts: ahora() })
        resultados.push({ tipo: "resultado", id: p.id, contenido: e.resultado, error: !e.ok })
      }
      s.mensajes.push({ rol: "usuario", bloques: resultados })
      if (s.tokens >= limites.maxTokensSesion) return responder("Alcancé el tope de tokens de la sesión antes de terminar. Revisa las llamadas a herramientas mostradas arriba.")
    }
    return responder(`Alcancé el tope de ${limites.maxIteraciones} pasos en este turno. Lo hecho está en las llamadas a herramientas de arriba; pídeme continuar si falta algo.`)
  } catch (e) {
    // La sesión no muere: se descarta el turno incompleto para no dejar el historial inconsistente.
    s.mensajes.splice(marca)
    if (pendienteAnterior) s.pendiente = pendienteAnterior
    const msg = e instanceof ErrorLlm ? e.message : "Ocurrió un error inesperado procesando tu mensaje. Intenta de nuevo."
    return responder(`⚠️ ${msg}`)
  } finally {
    recortarHistorial(s)
  }
}
