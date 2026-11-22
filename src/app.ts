/**
 * Aplicación HTTP (PRD 6.4) separada del arranque para poder probar la seguridad.
 * Controles: acceso HTTP Basic en tiempo constante, límites por IP (antes y después del acceso),
 * cabeceras de seguridad con CSP estricta, sin CORS (solo mismo origen), validación zod de toda
 * entrada, tamaño máximo de cuerpo y errores genéricos sin trazas.
 */
import express, { type NextFunction, type Request, type Response } from "express"
import rateLimit from "express-rate-limit"
import { timingSafeEqual, createHash } from "node:crypto"
import path from "node:path"
import { z } from "zod"
import { ejecutarTurno, type Limites, nuevaSesion, type Sesion } from "./agente/ciclo.js"
import type { LlmAdapter } from "./llm/adapter.js"

export type ConfigApp = {
  directory: string
  llm: LlmAdapter
  limites: Limites
  acceso: { usuario: string; clave: string } | null
  peticionesPorMinuto: number
  maxSesiones?: number
}

const CABECERAS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
}

/** Compara en tiempo constante (hash previo: no filtra ni la longitud). */
function iguales(a: string, b: string): boolean {
  const h = (s: string) => createHash("sha256").update(s).digest()
  return timingSafeEqual(h(a), h(b))
}

const SessionId = z.string().uuid()
const ChatBody = z.object({ sessionId: SessionId, message: z.string().trim().min(1).max(2000) }).strict()

export function crearApp(cfg: ConfigApp) {
  const app = express()
  app.disable("x-powered-by")
  app.set("trust proxy", 1) // Render pone un proxy delante: el límite por IP usa la IP real.
  app.use((_req, res, next) => {
    for (const [k, v] of Object.entries(CABECERAS)) res.setHeader(k, v)
    next()
  })

  // Salud: pública para el health check de Render. Solo proveedor y modelo, nunca claves.
  app.get("/api/health", (_req, res) => res.json({ ok: true, provider: cfg.llm.proveedor, model: cfg.llm.modelo }))

  // Freno a fuerza bruta sobre el usuario y la clave: límite por IP ANTES de autenticar.
  app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false, message: { error: "Demasiados intentos; espera un minuto." } }))

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!cfg.acceso) return next()
    const [esquema, codificado] = (req.headers.authorization ?? "").split(" ")
    if (esquema === "Basic" && codificado) {
      const [usuario, ...resto] = Buffer.from(codificado, "base64").toString().split(":")
      const okUsuario = iguales(usuario ?? "", cfg.acceso.usuario)
      const okClave = iguales(resto.join(":"), cfg.acceso.clave)
      if (okUsuario && okClave) return next()
    }
    res.setHeader("WWW-Authenticate", 'Basic realm="Agente OC", charset="UTF-8"')
    res.status(401).json({ error: "Autenticación requerida" })
  })

  app.use("/api", rateLimit({ windowMs: 60_000, limit: cfg.peticionesPorMinuto, standardHeaders: true, legacyHeaders: false, message: { error: "Demasiadas peticiones; espera un minuto." } }))
  app.use("/api", express.json({ limit: "16kb" }))
  app.use(express.static(path.join(cfg.directory, "web"), { index: "index.html", dotfiles: "deny" }))

  const sesiones = new Map<string, Sesion>()
  const ocupadas = new Set<string>()
  const maxSesiones = cfg.maxSesiones ?? 200
  const obtener = (id: string): Sesion => {
    let s = sesiones.get(id)
    if (!s) {
      if (sesiones.size >= maxSesiones) sesiones.delete(sesiones.keys().next().value ?? "")
      s = nuevaSesion(id)
      sesiones.set(id, s)
    }
    return s
  }

  app.post("/api/chat", async (req, res) => {
    const p = ChatBody.safeParse(req.body)
    if (!p.success) return void res.status(400).json({ error: "Cuerpo inválido: se espera { sessionId (uuid), message (1-2000 caracteres) }." })
    const { sessionId, message } = p.data
    if (ocupadas.has(sessionId)) return void res.status(429).json({ error: "Ya estoy procesando un mensaje de esta sesión; espera la respuesta." })
    ocupadas.add(sessionId)
    try {
      res.json(await ejecutarTurno(obtener(sessionId), message, { llm: cfg.llm, directory: cfg.directory, limites: cfg.limites }))
    } catch {
      console.error("Error en /api/chat") // sin contenido del usuario ni trazas
      res.status(500).json({ error: "Error interno; la sesión sigue activa, intenta de nuevo." })
    } finally {
      ocupadas.delete(sessionId)
    }
  })

  app.get("/api/sessions/:id", (req, res) => {
    const id = SessionId.safeParse(req.params.id)
    if (!id.success) return void res.status(400).json({ error: "Id de sesión inválido" })
    const s = sesiones.get(id.data)
    if (!s) return void res.status(404).json({ error: "Sesión no encontrada" })
    res.json({ id: s.id, eventos: s.visible, tokens: s.tokens, pendiente: s.pendiente, limites: { maxTokensSesion: cfg.limites.maxTokensSesion } })
  })

  app.use("/api", (_req, res) => res.status(404).json({ error: "Ruta no encontrada" }))

  // Errores (JSON malformado, cuerpo demasiado grande…): respuesta genérica, nunca la traza.
  app.use((err: { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status === 413 || err.type === "entity.too.large" ? 413 : err.status === 400 ? 400 : 500
    const error = status === 413 ? "Mensaje demasiado grande." : status === 400 ? "JSON inválido." : "Error interno."
    res.status(status).json({ error })
  })
  return app
}
