import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { type Ctx, rutas } from "./rutas.js"

const CABECERA_CONTROL = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n"

export type ResultadoControl = "creada" | "idempotente" | "bloqueada" | "pendiente_confirmacion" | "error"

export type FilaControl = {
  solicitud_id: string
  resultado: ResultadoControl
  numero_oc: string | null
  retroactiva: boolean
  bloqueos: string[]
  confirmaciones: string[]
}

// Escrituras serializadas en el proceso: evita filas intercaladas con sesiones concurrentes.
let cola: Promise<unknown> = Promise.resolve()
export function enSerie<T>(fn: () => Promise<T>): Promise<T> {
  const siguiente = cola.then(fn, fn)
  cola = siguiente.catch(() => undefined)
  return siguiente
}

const csv = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

export async function escribirArchivo(archivo: string, contenido: string): Promise<void> {
  await mkdir(path.dirname(archivo), { recursive: true })
  await writeFile(archivo, contenido, "utf8")
}

async function anexar(archivo: string, linea: string, cabecera = ""): Promise<void> {
  await mkdir(path.dirname(archivo), { recursive: true })
  let existe = true
  try {
    await readFile(archivo)
  } catch {
    existe = false
  }
  await appendFile(archivo, (existe ? "" : cabecera) + linea, "utf8")
}

/** HU-5: una fila por intento de creación en out/control.csv. */
export function registrarControl(ctx: Ctx, f: FilaControl): Promise<void> {
  const fila = [
    f.solicitud_id,
    f.resultado,
    f.numero_oc ?? "",
    String(f.retroactiva),
    f.bloqueos.join("|"),
    f.confirmaciones.join("|"),
    new Date().toISOString(),
  ]
  return enSerie(() => anexar(rutas(ctx).control, `${fila.map(csv).join(",")}\n`, CABECERA_CONTROL))
}

/** CA4: toda llamada a herramienta queda en out/log.jsonl (sin datos sensibles: no hay claves aquí). */
export function registrarLog(ctx: Ctx, entrada: { herramienta: string; args: unknown; ok: boolean; ms: number; error?: string }): Promise<void> {
  const linea = JSON.stringify({ ts: new Date().toISOString(), sessionId: ctx.sessionId, ...entrada })
  return enSerie(() => anexar(rutas(ctx).log, `${linea}\n`))
}
