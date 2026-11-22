/**
 * API HTTP del agente (PRD 6.4) y front estático (web/). La lógica de negocio vive en src/tools y
 * src/core; el ciclo en src/agente. Este archivo solo expone, protege y limita.
 */
import express, { type NextFunction, type Request, type Response } from "express"
import rateLimit from "express-rate-limit"
import { timingSafeEqual } from "node:crypto"
import path from "node:path"
import { z } from "zod"
import { ejecutarTurno, type Limites, nuevaSesion, type Sesion } from "./agente/ciclo.js"
import { crearLlm } from "./llm/fabrica.js"

const directory = path.resolve(process.env.PROJECT_DIR ?? process.cwd())
const num = (v: string | undefined, def: number) => (v && Number.isFinite(Number(v)) ? Number(v) : def)
const limites: Limites = {
  maxIteraciones: num(process.env.MAX_ITERACIONES, 25),
  maxTokensSesion: num(process.env.MAX_TOKENS_SESION, 150_000),
  maxTokensDia: num(process.env.MAX_TOKENS_DIA, 2_000_000),
  maxTokensRespuesta: num(process.env.MAX_TOKENS_RESPUESTA, 2_000),
  timeoutMs: num(process.env.LLM_TIMEOUT_MS, 60_000),
}
const MAX_SESIONES = 200
const { ACCESS_USER, ACCESS_PASS } = process.env
const enProduccion = process.env.NODE_ENV === "production"

if (enProduccion && (!ACCESS_USER || !ACCESS_PASS)) {
  console.error("Falta ACCESS_USER / ACCESS_PASS: el chat público debe estar protegido.")
  process.exit(1)
}

const llm = crearLlm()
const app = express()
app.disable("x-powered-by")
app.set("trust proxy", 1) // Render pone un proxy delante: el límite por IP usa la IP real.
app.use(express.json({ limit: "64kb" }))
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("X-Frame-Options", "DENY")
  res.setHeader("Referrer-Policy", "no-referrer")
  next()
})

// Salud: público para el health check de Render. Nunca expone claves.
app.get("/api/health", (_req, res) => res.json({ ok: true, provider: llm.proveedor, model: llm.modelo }))

function iguales(a: string, b: string): boolean {
  const [x, y] = [Buffer.from(a), Buffer.from(b)]
  return x.length === y.length && timingSafeEqual(x, y)
}

// Acceso con usuario y clave (HTTP Basic) para el chat y la API. En local sin variables queda abierto.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!ACCESS_USER || !ACCESS_PASS) return next()
  const [esquema, codificado] = (req.headers.authorization ?? "").split(" ")
  if (esquema === "Basic" && codificado) {
    const [usuario, ...resto] = Buffer.from(codificado, "base64").toString().split(":")
    if (iguales(usuario ?? "", ACCESS_USER) && iguales(resto.join(":"), ACCESS_PASS)) return next()
  }
  res.setHeader("WWW-Authenticate", 'Basic realm="Agente OC", charset="UTF-8"')
  res.status(401).send("Autenticación requerida")
})

app.use("/api", rateLimit({ windowMs: 60_000, limit: num(process.env.MAX_PETICIONES_MINUTO, 20), standardHeaders: true, legacyHeaders: false, message: { error: "Demasiadas peticiones; espera un minuto." } }))
app.use(express.static(path.join(directory, "web")))

const sesiones = new Map<string, Sesion>()
const ocupadas = new Set<string>()
function obtenerSesion(id: string): Sesion {
  let s = sesiones.get(id)
  if (!s) {
    if (sesiones.size >= MAX_SESIONES) sesiones.delete(sesiones.keys().next().value ?? "")
    s = nuevaSesion(id)
    sesiones.set(id, s)
  }
  return s
}

const ChatBody = z.object({ sessionId: z.string().uuid(), message: z.string().trim().min(1).max(2000) })

app.post("/api/chat", async (req, res) => {
  const p = ChatBody.safeParse(req.body)
  if (!p.success) return void res.status(400).json({ error: "Cuerpo inválido: se espera { sessionId (uuid), message (1-2000 caracteres) }." })
  const { sessionId, message } = p.data
  if (ocupadas.has(sessionId)) return void res.status(429).json({ error: "Ya estoy procesando un mensaje de esta sesión; espera la respuesta." })
  ocupadas.add(sessionId)
  try {
    res.json(await ejecutarTurno(obtenerSesion(sessionId), message, { llm, directory, limites }))
  } catch (e) {
    console.error("Error en /api/chat:", e instanceof Error ? e.message : "desconocido")
    res.status(500).json({ error: "Error interno; la sesión sigue activa, intenta de nuevo." })
  } finally {
    ocupadas.delete(sessionId)
  }
})

app.get("/api/sessions/:id", (req, res) => {
  const s = sesiones.get(req.params.id)
  if (!s) return void res.status(404).json({ error: "Sesión no encontrada" })
  res.json({ id: s.id, eventos: s.visible, tokens: s.tokens, pendiente: s.pendiente, limites: { maxTokensSesion: limites.maxTokensSesion } })
})

const puerto = num(process.env.PORT, 3000)
app.listen(puerto, () => console.log(`Agente OC en http://localhost:${puerto} · LLM: ${llm.proveedor}/${llm.modelo}`))
