import express, { NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { AgentEvent, Session, runAgent } from "./agent/loop.js";
import { createCtx } from "./tools/oc.js";

const app = express();
const isProd = process.env.NODE_ENV === "production";
const { ACCESS_USER, ACCESS_PASS } = process.env;

if (isProd && (!ACCESS_USER || !ACCESS_PASS)) {
  console.error("Falta ACCESS_USER / ACCESS_PASS: el chat público debe estar protegido.");
  process.exit(1);
}

app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

// Sin autenticación: solo el chequeo de salud (no expone datos).
app.get("/health", (_req, res) => res.json({ status: "ok" }));

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Acceso protegido (HTTP Basic) para todo lo demás.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!ACCESS_USER || !ACCESS_PASS) return next(); // solo desarrollo local
  const header = req.headers.authorization ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const [u, ...rest] = Buffer.from(encoded, "base64").toString().split(":");
    if (safeEqual(u ?? "", ACCESS_USER) && safeEqual(rest.join(":"), ACCESS_PASS)) return next();
  }
  res.setHeader("WWW-Authenticate", 'Basic realm="Agente OC"');
  res.status(401).send("Autenticación requerida");
});

app.use("/api", rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.resolve("public")));

const sessions = new Map<string, Session>();
function getSession(id: string): Session {
  let s = sessions.get(id);
  if (!s) {
    if (sessions.size > 200) sessions.delete(sessions.keys().next().value!); // límite de memoria
    s = { ctx: createCtx(), history: [] };
    sessions.set(id, s);
  }
  return s;
}

const chatBody = z.object({ sessionId: z.string().uuid(), message: z.string().min(1).max(4000) });
const confirmBody = z.object({ sessionId: z.string().uuid(), approve: z.boolean() });

async function respond(res: Response, session: Session, text: string) {
  const events: AgentEvent[] = [];
  try {
    const reply = await runAgent(session, text, (e) => events.push(e));
    res.json({ reply, events, pending: session.ctx.pending });
  } catch (e) {
    console.error("agent error:", (e as Error).message); // sin volcar datos del usuario
    res.status(502).json({ error: "El agente no pudo responder. Revisa la configuración del modelo." });
  }
}

app.post("/api/chat", async (req, res) => {
  const p = chatBody.safeParse(req.body);
  if (!p.success) return void res.status(400).json({ error: "Solicitud inválida" });
  const session = getSession(p.data.sessionId);
  if (session.ctx.pending) return void res.status(409).json({ error: "Hay una confirmación humana pendiente" });
  await respond(res, session, p.data.message);
});

// La confirmación humana la registra el SERVIDOR (no el modelo): el agente no puede autoaprobarse.
app.post("/api/confirm", async (req, res) => {
  const p = confirmBody.safeParse(req.body);
  if (!p.success) return void res.status(400).json({ error: "Solicitud inválida" });
  const session = getSession(p.data.sessionId);
  const pending = session.ctx.pending;
  if (!pending) return void res.status(409).json({ error: "No hay confirmación pendiente" });
  session.ctx.pending = null;
  if (p.data.approve) session.ctx.confirmed.add(pending.caso_id);
  await respond(
    res,
    session,
    p.data.approve
      ? `El humano APROBÓ el caso ${pending.caso_id}. Continúa con el proceso.`
      : `El humano RECHAZÓ el caso ${pending.caso_id}. No crees la orden y explica el cierre.`,
  );
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Agente OC escuchando en :${port}`));
