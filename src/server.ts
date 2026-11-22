/** Arranque: lee la configuración del entorno y valida que producción esté protegida. */
import path from "node:path"
import { crearApp } from "./app.js"
import type { Limites } from "./agente/ciclo.js"
import { crearLlm } from "./llm/fabrica.js"

const num = (v: string | undefined, def: number) => (v && Number.isFinite(Number(v)) ? Number(v) : def)
const env = process.env
const limites: Limites = {
  maxIteraciones: num(env.MAX_ITERACIONES, 25),
  maxTokensSesion: num(env.MAX_TOKENS_SESION, 150_000),
  maxTokensDia: num(env.MAX_TOKENS_DIA, 2_000_000),
  maxTokensRespuesta: num(env.MAX_TOKENS_RESPUESTA, 2_000),
  timeoutMs: num(env.LLM_TIMEOUT_MS, 30_000),
  maxMsTurno: num(env.MAX_MS_TURNO, 100_000),
}

const { ACCESS_USER, ACCESS_PASS } = env
if (env.NODE_ENV === "production") {
  if (!ACCESS_USER || !ACCESS_PASS) {
    console.error("Falta ACCESS_USER / ACCESS_PASS: el chat público debe estar protegido.")
    process.exit(1)
  }
  if (ACCESS_PASS.length < 10) {
    console.error("ACCESS_PASS debe tener al menos 10 caracteres.")
    process.exit(1)
  }
}

// Un error no previsto nunca tumba el proceso (evita respuestas 502 del proxy de Render).
process.on("unhandledRejection", () => console.error("Promesa rechazada sin manejar (detalle omitido)"))
process.on("uncaughtException", (e) => console.error("Excepción no capturada:", e.name))

const llm = crearLlm(env)
const app = crearApp({
  directory: path.resolve(env.PROJECT_DIR ?? process.cwd()),
  llm,
  limites,
  acceso: ACCESS_USER && ACCESS_PASS ? { usuario: ACCESS_USER, clave: ACCESS_PASS } : null,
  peticionesPorMinuto: num(env.MAX_PETICIONES_MINUTO, 10),
})
const puerto = num(env.PORT, 3000)
const servidor = app.listen(puerto, () => console.log(`Agente OC en el puerto ${puerto} · LLM: ${llm.proveedor}/${llm.modelo} · acceso ${ACCESS_USER ? "protegido" : "abierto (solo local)"}`))
servidor.requestTimeout = 0 // el turno tiene su propio límite (MAX_MS_TURNO)
servidor.keepAliveTimeout = 120_000
