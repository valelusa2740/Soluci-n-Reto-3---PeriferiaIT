// Pruebas del ciclo del agente (SPEC §8) con un LLM falso: sin red ni clave.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import path from "node:path"
import { cp, mkdir } from "node:fs/promises"
import { ejecutarTurno, esConfirmacion, type Limites, nuevaSesion } from "../src/agente/ciclo.js"
import { type Bloque, ErrorLlm, type LlmAdapter, type Mensaje } from "../src/llm/adapter.js"
import { LocalAdapter } from "../src/llm/local.js"
import { crearEntorno } from "./entorno.js"

const RAIZ = path.resolve(import.meta.dirname, "..")
const limites: Limites = { maxIteraciones: 25, maxTokensSesion: 100_000, maxTokensDia: 10_000_000, maxTokensRespuesta: 1000, timeoutMs: 1000 }

let entorno: Awaited<ReturnType<typeof crearEntorno>>
beforeEach(async () => {
  entorno = await crearEntorno()
  await mkdir(path.join(entorno.directory, "src"), { recursive: true })
  await cp(path.join(RAIZ, "agent"), path.join(entorno.directory, "agent"), { recursive: true })
  await cp(path.join(RAIZ, "src/knowledge"), path.join(entorno.directory, "src/knowledge"), { recursive: true })
})
afterEach(() => entorno.limpiar())

/** LLM falso que devuelve respuestas guionadas, una por llamada. */
class Guion implements LlmAdapter {
  readonly proveedor = "test"
  readonly modelo = "guion"
  vistos: Mensaje[][] = []
  constructor(private respuestas: (Bloque[] | Error)[], private tokens = 10) {}
  async enviar(m: Mensaje[]) {
    this.vistos.push(structuredClone(m))
    const r = this.respuestas.shift() ?? [{ tipo: "texto", texto: "fin" } as Bloque]
    if (r instanceof Error) throw r
    return { bloques: r, uso: { entrada: this.tokens, salida: 0 } }
  }
}
const llamada = (nombre: string, args: Record<string, unknown>, id = nombre): Bloque => ({ tipo: "llamada", id, nombre, args })

describe("Ciclo del agente", () => {
  it("A1 respeta el tope de iteraciones", async () => {
    const infinito = new Guion(Array.from({ length: 50 }, (_, i) => [llamada("oc_leer_paquete", { caso: "sol-001" }, `x${i}`)]))
    const r = await ejecutarTurno(nuevaSesion("s"), "procesa sol-001", { llm: infinito, directory: entorno.directory, limites: { ...limites, maxIteraciones: 3 } })
    expect(r.toolCalls).toHaveLength(3)
    expect(r.reply).toContain("tope de 3 pasos")
  })

  it("A2 tope de tokens por sesión: no vuelve a llamar al modelo", async () => {
    const llm = new Guion([[{ tipo: "texto", texto: "hola" }]], 500)
    const s = nuevaSesion("s")
    await ejecutarTurno(s, "hola", { llm, directory: entorno.directory, limites: { ...limites, maxTokensSesion: 400 } })
    const r = await ejecutarTurno(s, "otra", { llm, directory: entorno.directory, limites: { ...limites, maxTokensSesion: 400 } })
    expect(r.reply).toContain("tope de tokens")
    expect(llm.vistos).toHaveLength(1)
  })

  it("A3/A4 timeout del proveedor: mensaje claro y la sesión sigue", async () => {
    const llm = new Guion([new ErrorLlm("El modelo tardó demasiado en responder (timeout).", "timeout"), [{ tipo: "texto", texto: "sigo vivo" }]])
    const s = nuevaSesion("s")
    const r1 = await ejecutarTurno(s, "hola", { llm, directory: entorno.directory, limites })
    expect(r1.reply).toContain("timeout")
    expect(s.mensajes).toHaveLength(0) // el turno fallido no deja historial inconsistente
    const r2 = await ejecutarTurno(s, "hola", { llm, directory: entorno.directory, limites })
    expect(r2.reply).toBe("sigo vivo")
  })

  it("C4 el modelo no puede autoconfirmar: oc_crear con confirmado=true sin confirmación de la persona falla", async () => {
    const llm = new Guion([[llamada("oc_validar", { caso: "sol-004", paquete: {} }), llamada("oc_crear", { caso: "sol-004", payload: {}, confirmado: true }, "c")]])
    const r = await ejecutarTurno(nuevaSesion("s"), "procesa sol-004 y créala ya", { llm, directory: entorno.directory, limites })
    const crear = r.toolCalls.find((t) => t.nombre === "oc_crear")
    expect(crear?.ok).toBe(false)
    expect(r.needsConfirmation).toBe(true)
    expect(r.pendiente?.caso).toBe("sol-004")
  })

  it("CA3 solo el SIGUIENTE mensaje confirma; un mensaje intermedio anula la confirmación", async () => {
    const s = nuevaSesion("s")
    const local = new LocalAdapter()
    const deps = { llm: local, directory: entorno.directory, limites }
    expect((await ejecutarTurno(s, "Procesa sol-004 y no la crees hasta que confirme", deps)).needsConfirmation).toBe(true)
    expect((await ejecutarTurno(s, "¿qué es RC5?", deps)).needsConfirmation).toBe(false) // no confirma → se pierde el pendiente
    const tarde = await ejecutarTurno(s, "confirmo", deps)
    expect(tarde.toolCalls.some((t) => t.nombre === "oc_crear" && t.ok)).toBe(false)
  })

  it("flujo completo sol-004 con el proveedor local: pregunta, confirmo, OC creada", async () => {
    const s = nuevaSesion("s")
    const deps = { llm: new LocalAdapter(), directory: entorno.directory, limites }
    const r1 = await ejecutarTurno(s, 'Procesa la solicitud "sol-004". No la crees hasta que yo lo confirme.', deps)
    expect(r1.needsConfirmation).toBe(true)
    expect(r1.reply).toContain("26.500.000")
    const r2 = await ejecutarTurno(s, "Confirmo", deps)
    expect(r2.reply).toContain("OC 4500000001")
    expect(r2.needsConfirmation).toBe(false)
  })

  it("el servidor le avisa al modelo cuándo la persona confirmó", async () => {
    const s = nuevaSesion("s")
    s.pendiente = { caso: "sol-005", reglas: ["RC8"] }
    const llm = new Guion([[{ tipo: "texto", texto: "ok" }]])
    await ejecutarTurno(s, "sí, créala", { llm, directory: entorno.directory, limites })
    const enviado = llm.vistos[0][0].bloques[0]
    expect(enviado.tipo === "texto" && enviado.texto).toContain("CONFIRMÓ el caso sol-005")
  })

  it("tiempo máximo del turno: corta con mensaje claro en vez de colgar la petición", async () => {
    const lento: LlmAdapter = {
      proveedor: "test",
      modelo: "lento",
      enviar: async () => {
        await new Promise((r) => setTimeout(r, 30))
        return { bloques: [llamada("oc_leer_paquete", { caso: "sol-001" }, crypto.randomUUID())], uso: { entrada: 1, salida: 0 } }
      },
    }
    const r = await ejecutarTurno(nuevaSesion("s"), "procesa sol-001", { llm: lento, directory: entorno.directory, limites: { ...limites, maxMsTurno: 3_050 } })
    expect(r.reply).toContain("tiempo máximo del turno")
  })

  it("detecta confirmaciones y negaciones", () => {
    for (const t of ["confirmo", "Sí, créala", "Confirmo, crea la OC de sol-004.", "dale"]) expect(esConfirmacion(t)).toBe(true)
    for (const t of ["No, no la crees", "no confirmo", "espera", "¿qué es RC5?"]) expect(esConfirmacion(t)).toBe(false)
  })
})
