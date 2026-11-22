import { access, readFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { type Ctx, rutas } from "./rutas.js"
import { type Paquete, SolicitudSchema } from "./tipos.js"
import { normalizarNit, parsearMonto } from "./util.js"

class ErrorPaquete extends Error {}

/** Lee un archivo del caso; null si no existe. */
async function leerOpcional(dir: string, nombre: string): Promise<string | null> {
  try {
    return await readFile(path.join(dir, nombre), "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
    throw e
  }
}

function parsearJson(texto: string, nombre: string): unknown {
  try {
    return JSON.parse(texto)
  } catch {
    throw new ErrorPaquete(`${nombre} no es un JSON válido. Pide al solicitante reenviar el archivo.`)
  }
}

export function describirZod(error: z.ZodError, nombre: string): string {
  const detalles = error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
  return `${nombre} tiene campos inválidos (${detalles}). Pide al solicitante corregirlos.`
}

const campo = (texto: string, etiqueta: RegExp): string | null => texto.match(etiqueta)?.[1]?.trim() ?? null

function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

export function parsearCotizacion(texto: string): NonNullable<Paquete["cotizacion"]> {
  const lineaTotal = campo(texto, /^TOTAL[^:\n]*:\s*(.+)$/m)
  const total = lineaTotal ? parsearMonto(lineaTotal) : null
  if (total === null) throw new ErrorPaquete("La cotización no tiene un TOTAL numérico legible.")
  const nit = campo(texto, /^NIT:\s*(.+)$/m)
  const fecha = campo(texto, /^Fecha:\s*(\d{4}-\d{2}-\d{2})/m)
  const dias = campo(texto, /Validez de la oferta:\s*(\d+)\s*d[ií]as/i)
  return {
    referencia: campo(texto, /^COTIZACI[ÓO]N\s+(\S+)/m),
    proveedor: campo(texto, /^Proveedor:\s*(.+)$/m) ?? "",
    nit: nit ? normalizarNit(nit) : null,
    total,
    moneda: lineaTotal?.match(/\b(COP|USD)\b/)?.[1] ?? "COP",
    validez_hasta: fecha && dias ? sumarDias(fecha, Number(dias)) : null,
    texto,
  }
}

export function parsearFactura(texto: string): NonNullable<Paquete["factura"]> {
  const numero = campo(texto, /No\.\s*(\S+)/)
  const fecha = campo(texto, /Fecha de emisi[óo]n:\s*(\d{4}-\d{2}-\d{2})/i)
  const lineaTotal = campo(texto, /^TOTAL[^:\n]*:\s*(.+)$/m)
  const total = lineaTotal ? parsearMonto(lineaTotal) : null
  if (!numero || !fecha || total === null) {
    throw new ErrorPaquete("La factura no tiene número, fecha de emisión o total legibles.")
  }
  return { numero, fecha, total }
}

/** Aprobado si dice "Aprobado" y no es una negación ("No aprobado", "rechazado"). */
export function esAprobado(cuerpo: string): boolean {
  if (/\bno\s+aprobad[oa]\b|\brechazad[oa]\b/i.test(cuerpo)) return false
  return /\baprobad[oa]\b/i.test(cuerpo)
}

const AprobacionRawSchema = z.object({
  de: z.string(),
  para: z.string(),
  fecha: z.string(),
  asunto: z.string(),
  cuerpo: z.string(),
})
const CorreoRawSchema = z.object({ id: z.string(), de: z.string(), asunto: z.string(), fecha: z.string() })

function validar<T>(schema: z.ZodType<T>, valor: unknown, nombre: string): T {
  const r = schema.safeParse(valor)
  if (!r.success) throw new ErrorPaquete(describirZod(r.error, nombre))
  return r.data
}

async function construirPaquete(dir: string): Promise<Paquete> {
  const faltantes: string[] = []
  const textoSolicitud = await leerOpcional(dir, "solicitud.json")
  if (textoSolicitud === null) throw new ErrorPaquete("Falta solicitud.json: pide al solicitante el Excel de solicitud.")
  const textoCorreo = await leerOpcional(dir, "correo.json")
  if (textoCorreo === null) throw new ErrorPaquete("Falta correo.json del paquete.")

  const solicitud = validar(SolicitudSchema, parsearJson(textoSolicitud, "solicitud.json"), "solicitud.json")
  const correo = validar(CorreoRawSchema, parsearJson(textoCorreo, "correo.json"), "correo.json")

  const textoCot = await leerOpcional(dir, "cotizacion.txt")
  if (textoCot === null) faltantes.push("cotizacion")
  const textoAprob = await leerOpcional(dir, "aprobacion.json")
  if (textoAprob === null) faltantes.push("aprobacion")
  const textoFactura = await leerOpcional(dir, "factura.txt")

  const aprobRaw = textoAprob === null ? null : validar(AprobacionRawSchema, parsearJson(textoAprob, "aprobacion.json"), "aprobacion.json")

  return {
    correo: { id: correo.id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha },
    solicitud,
    cotizacion: textoCot === null ? null : parsearCotizacion(textoCot),
    aprobacion: aprobRaw && {
      de: aprobRaw.de,
      para: aprobRaw.para,
      fecha: aprobRaw.fecha,
      asunto: aprobRaw.asunto,
      aprobado: esAprobado(aprobRaw.cuerpo),
      texto: aprobRaw.cuerpo,
    },
    factura: textoFactura === null ? null : parsearFactura(textoFactura),
    faltantes,
  }
}

export type LecturaPaquete = { ok: true; paquete: Paquete } | { ok: false; error: string }

/** HU-1: lee y normaliza el paquete. Nunca lanza: los problemas del paquete vuelven como error legible. */
export async function leerPaquete(ctx: Ctx, caso: string): Promise<LecturaPaquete> {
  const dir = rutas(ctx).caso(caso)
  try {
    await access(dir)
  } catch {
    return { ok: false, error: `El caso "${caso}" no existe en fixtures/reto-03/solicitudes/.` }
  }
  try {
    return { ok: true, paquete: await construirPaquete(dir) }
  } catch (e) {
    if (e instanceof ErrorPaquete) return { ok: false, error: `${caso}: ${e.message}` }
    return { ok: false, error: `${caso}: no se pudo leer el paquete (${(e as Error).message}).` }
  }
}
