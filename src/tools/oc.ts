/**
 * Herramientas del agente (PRD 6.2). El modelo las ve como `oc_<export>`.
 * Cada una: { description, args (objeto plano de zod), execute(args, ctx) → string JSON }. Nunca lanzan.
 * Son importables sin el servidor (demo.ts, modulo/).
 */
import path from "node:path"
import { z } from "zod"
import { cargarMaestros } from "../core/maestros.js"
import { leerPaquete } from "../core/paquete.js"
import { construirOrden, textoEvidencia } from "../core/payload.js"
import { validarPaquete } from "../core/reglas.js"
import { CASO_REGEX, type Ctx, rutas } from "../core/rutas.js"
import { pdfEvidencia } from "../core/pdf.js"
import { escribirArchivo, registrarControl, registrarLog } from "../core/salidas.js"
import { writeFile } from "node:fs/promises"
import type { OrdenCompra, Paquete, Validacion } from "../core/tipos.js"
import { jsonEstable, mensajeError, sha256 } from "../core/util.js"
import { SapMock } from "../sap/mock.js"

export type { Ctx } from "../core/rutas.js"

const caso = z.string().regex(CASO_REGEX, "Formato esperado: sol-XXX").describe('Carpeta del caso en fixtures/reto-03/solicitudes/, p. ej. "sol-001"')
const objeto = z.record(z.string(), z.unknown())

const ok = (data: unknown) => JSON.stringify({ ok: true, data })
const fallo = (error: string) => JSON.stringify({ ok: false, error })

/** Ruta relativa al proyecto: nunca se exponen rutas absolutas del servidor. */
const relativa = (ctx: Ctx, ruta: string) => path.relative(path.resolve(ctx.directory), ruta).split(path.sep).join("/")

type Contexto = { paquete: Paquete; validacion: Validacion }

/** Fuente de verdad: siempre se relee el caso desde sus archivos y se valida con los maestros. */
async function contextoDelCaso(ctx: Ctx, nombre: string): Promise<{ ok: true; c: Contexto } | { ok: false; error: string }> {
  const lectura = await leerPaquete(ctx, nombre)
  if (!lectura.ok) return lectura
  const maestros = await cargarMaestros(ctx)
  return { ok: true, c: { paquete: lectura.paquete, validacion: validarPaquete(lectura.paquete, maestros) } }
}

function advertenciaSiDifiere(recibido: unknown, real: unknown, que: string): string[] {
  if (recibido === undefined || jsonEstable(recibido) === jsonEstable(real)) return []
  return [`El ${que} recibido no coincide con el de los archivos; se usó el de los archivos.`]
}

const sinConfirmador = (o: OrdenCompra) => ({ ...o, excepciones: o.excepciones.map((e) => ({ ...e, confirmado_por: null })) })

export const leer_paquete = {
  description: "Lee y normaliza el paquete de una solicitud (correo, solicitud, cotización, aprobación y factura si existe); es el primer paso de todo caso.",
  args: { caso },
  async execute(args: { caso: string }, ctx: Ctx): Promise<string> {
    try {
      const r = await leerPaquete(ctx, args.caso)
      return r.ok ? ok(r.paquete) : fallo(r.error)
    } catch (e) {
      return fallo(`No se pudo leer ${args.caso}: ${mensajeError(e)}`)
    }
  },
}

export const validar = {
  description: "Aplica las reglas de control RC1–RC10 al paquete y devuelve si la OC es apta, sus bloqueos, confirmaciones, valores derivados y si es retroactiva.",
  args: {
    caso,
    paquete: objeto.optional().describe("Opcional: paquete de oc_leer_paquete. Siempre se valida contra los archivos del caso"),
  },
  async execute(args: { caso: string; paquete?: Record<string, unknown> }, ctx: Ctx): Promise<string> {
    try {
      const r = await contextoDelCaso(ctx, args.caso)
      if (!r.ok) return fallo(r.error)
      const { proveedor: _p, ...v } = r.c.validacion
      return ok({ ...v, advertencias: advertenciaSiDifiere(args.paquete, r.c.paquete, "paquete") })
    } catch (e) {
      return fallo(`No se pudo validar ${args.caso}: ${mensajeError(e)}`)
    }
  },
}

export const construir_payload = {
  description: "Construye la orden de compra exactamente como quedaría en SAP, con la fuente de cada valor, y guarda la trazabilidad; solo funciona si la validación no tiene bloqueos.",
  args: {
    caso,
    paquete: objeto.optional().describe("Opcional: paquete de oc_leer_paquete (se usa el de los archivos)"),
    derivados: objeto.optional().describe("Opcional: `derivados` de oc_validar (se recalculan)"),
  },
  async execute(args: { caso: string; paquete?: Record<string, unknown>; derivados?: Record<string, unknown> }, ctx: Ctx): Promise<string> {
    try {
      const r = await contextoDelCaso(ctx, args.caso)
      if (!r.ok) return fallo(r.error)
      const { paquete, validacion } = r.c
      if (!validacion.apta) {
        return fallo(`No se construye la OC de ${args.caso}: bloqueos ${validacion.bloqueos.map((b) => `${b.regla} (${b.detalle})`).join("; ")}`)
      }
      const { orden, trazabilidad } = construirOrden(paquete, validacion, validacion.derivados)
      const archivo = path.join(rutas(ctx).outCaso(args.caso), "trazabilidad.json")
      await escribirArchivo(archivo, JSON.stringify({ caso: args.caso, orden, trazabilidad }, null, 2))
      const advertencias = [
        ...advertenciaSiDifiere(args.paquete, paquete, "paquete"),
        ...advertenciaSiDifiere(args.derivados, validacion.derivados, "objeto de derivados"),
      ]
      return ok({ orden, trazabilidad, ruta_trazabilidad: relativa(ctx, archivo), advertencias })
    } catch (e) {
      return fallo(`No se pudo construir el payload de ${args.caso}: ${mensajeError(e)}`)
    }
  },
}

export const generar_evidencia = {
  description: "Genera la evidencia del correo de aprobación (out/<caso>/aprobacion.txt y .pdf) con su sha256 para adjuntarla a la OC.",
  args: { caso },
  async execute(args: { caso: string }, ctx: Ctx): Promise<string> {
    try {
      const r = await leerPaquete(ctx, args.caso)
      if (!r.ok) return fallo(r.error)
      const texto = textoEvidencia(r.paquete)
      if (!texto) return fallo(`${args.caso}: no hay correo de aprobación; pide al solicitante la aprobación del líder.`)
      const archivo = path.join(rutas(ctx).outCaso(args.caso), "aprobacion.txt")
      await escribirArchivo(archivo, texto)
      const pdf = path.join(rutas(ctx).outCaso(args.caso), "aprobacion.pdf")
      await writeFile(pdf, await pdfEvidencia(texto))
      return ok({ ruta: relativa(ctx, archivo), ruta_pdf: relativa(ctx, pdf), sha256: sha256(texto) })
    } catch (e) {
      return fallo(`No se pudo generar la evidencia de ${args.caso}: ${mensajeError(e)}`)
    }
  },
}

/** true solo si el modelo pide confirmado=true y el host certifica que la persona lo confirmó. */
function confirmadoPorHumano(args: { caso: string; confirmado?: boolean }, ctx: Ctx): boolean {
  if (args.confirmado !== true) return false
  return ctx.confirmacionHumana ? ctx.confirmacionHumana(args.caso) : true
}

export const crear = {
  description: "Crea la orden de compra en SAP (simulado); revalida todo, rechaza si hay bloqueos y, si hay confirmaciones pendientes, solo crea con confirmado=true después de que la persona confirmó en el chat.",
  args: {
    caso,
    payload: objeto.optional().describe("Opcional: `orden` de oc_construir_payload; se crea siempre la reconstruida desde los archivos"),
    confirmado: z.boolean().optional().describe("true solo si la persona confirmó explícitamente en su último mensaje"),
  },
  async execute(args: { caso: string; payload?: Record<string, unknown>; confirmado?: boolean }, ctx: Ctx): Promise<string> {
    try {
      return await crearOrden(args, ctx)
    } catch (e) {
      return fallo(`No se pudo crear la OC de ${args.caso}: ${mensajeError(e)}`)
    }
  },
}

async function crearOrden(args: { caso: string; payload?: Record<string, unknown>; confirmado?: boolean }, ctx: Ctx): Promise<string> {
  const r = await contextoDelCaso(ctx, args.caso)
  if (!r.ok) return fallo(r.error)
  const { paquete, validacion: v } = r.c
  const id = paquete.solicitud.solicitud_id
  const fila = {
    solicitud_id: id,
    retroactiva: v.retroactiva,
    bloqueos: v.bloqueos.map((b) => b.regla),
    confirmaciones: v.confirmaciones.map((c) => c.regla),
  }
  if (!v.apta) {
    await registrarControl(ctx, { ...fila, resultado: "bloqueada", numero_oc: null })
    return fallo(`OC NO creada para ${args.caso} por bloqueos: ${v.bloqueos.map((b) => `${b.regla}: ${b.detalle} Acción: ${b.accion_sugerida ?? "-"}`).join(" | ")}`)
  }
  const sap = new SapMock(ctx)
  const existente = await sap.buscarOrdenPorReferencia(id)
  if (existente) {
    await registrarControl(ctx, { ...fila, resultado: "idempotente", numero_oc: existente.numero_oc })
    return ok({ numero_oc: existente.numero_oc, fecha: null, idempotente: true, retroactiva: v.retroactiva })
  }
  if (v.confirmaciones.length > 0 && !confirmadoPorHumano(args, ctx)) {
    await registrarControl(ctx, { ...fila, resultado: "pendiente_confirmacion", numero_oc: null })
    return fallo(
      `REQUIERE_CONFIRMACION: la OC de ${args.caso} tiene confirmaciones pendientes (${v.confirmaciones.map((c) => `${c.regla}: ${c.detalle}`).join(" | ")}). Pregunta a la persona y espera que confirme en su siguiente mensaje.`,
    )
  }
  const proveedorSap = v.proveedor && (await sap.consultarProveedor(v.proveedor.nit))
  if (!proveedorSap?.activo) return fallo(`SAP no reconoce al proveedor como activo; no se crea la OC de ${args.caso}.`)

  const { orden } = construirOrden(paquete, v, v.derivados)
  const advertencias = args.payload ? advertenciaSiDifiere(sinConfirmador(args.payload as OrdenCompra), sinConfirmador(orden), "payload") : []
  const confirmador = `analista (sesión ${ctx.sessionId})`
  const final: OrdenCompra = { ...orden, excepciones: orden.excepciones.map((e) => ({ ...e, confirmado_por: confirmador })) }

  const texto = textoEvidencia(paquete) ?? ""
  const evidencia = path.join(rutas(ctx).outCaso(args.caso), "aprobacion.txt")
  await escribirArchivo(evidencia, texto)

  const creada = await sap.crearOrden(final)
  await registrarControl(ctx, { ...fila, resultado: "creada", numero_oc: creada.numero_oc })
  return ok({ ...creada, idempotente: false, retroactiva: v.retroactiva, evidencia: relativa(ctx, evidencia), advertencias })
}

type Res = { ok: boolean; data?: Record<string, unknown>; error?: string }

/** Ejecuta un paso y lo deja en out/log.jsonl, igual que si lo hubiera llamado el modelo. */
async function paso(ctx: Ctx, nombre: string, args: { caso: string }, fn: () => Promise<string>): Promise<Res> {
  const inicio = Date.now()
  const r = JSON.parse(await fn()) as Res
  await registrarLog(ctx, { herramienta: nombre, args, ok: r.ok, ms: Date.now() - inicio, error: r.ok ? undefined : "ver resultado" }).catch(() => undefined)
  return r
}

/**
 * Atajo determinista: encadena oc_leer_paquete → oc_validar → oc_construir_payload → oc_generar_evidencia
 * en UNA llamada y devuelve un resumen compacto. Reduce las vueltas al modelo (latencia y cuota).
 * No crea la OC: eso sigue siendo oc_crear, con la confirmación validada por el servidor.
 */
export const procesar = {
  description: "Procesa un caso de punta a punta sin crear la OC: lee el paquete, valida RC1–RC10, arma la OC como quedaría en SAP y genera la evidencia; devuelve un resumen. Úsala primero.",
  args: { caso },
  async execute(args: { caso: string }, ctx: Ctx): Promise<string> {
    try {
      const a = { caso: args.caso }
      const p = await paso(ctx, "oc_leer_paquete", a, () => leer_paquete.execute(a, ctx))
      if (!p.ok) return fallo(p.error ?? "No se pudo leer el paquete")
      const v = await paso(ctx, "oc_validar", a, () => validar.execute(a, ctx))
      if (!v.ok || !v.data) return fallo(v.error ?? "No se pudo validar")
      const { apta, bloqueos, confirmaciones, derivados, retroactiva } = v.data as { apta: boolean; bloqueos: unknown[]; confirmaciones: unknown[]; derivados: unknown; retroactiva: boolean }
      const base = { caso: args.caso, apta, retroactiva, bloqueos, confirmaciones, derivados, requiere_confirmacion: apta && confirmaciones.length > 0 }
      if (!apta) return ok({ ...base, siguiente_paso: "No crear la OC: explicar los bloqueos y la acción sugerida." })
      const c = await paso(ctx, "oc_construir_payload", a, () => construir_payload.execute(a, ctx))
      if (!c.ok || !c.data) return fallo(c.error ?? "No se pudo construir la OC")
      const e = await paso(ctx, "oc_generar_evidencia", a, () => generar_evidencia.execute(a, ctx))
      const orden = c.data.orden as OrdenCompra
      const pos = orden.posiciones[0]
      return ok({
        ...base,
        oc: {
          proveedor: `${orden.proveedor.nombre} (${orden.proveedor.codigo_sap}, NIT ${orden.proveedor.nit})`,
          descripcion: pos.descripcion,
          cantidad: `${pos.cantidad} ${pos.unidad}`,
          precio_unitario: pos.precio_unitario,
          total: pos.cantidad * pos.precio_unitario,
          moneda: orden.moneda,
          centro_costo: `${pos.centro_costo} / ${pos.subarea}`,
          indicador_iva: pos.indicador_iva,
          condiciones_pago: orden.condiciones_pago,
          aprobador: orden.aprobador.email,
          cotizacion: orden.referencia.cotizacion_ref,
        },
        trazabilidad: c.data.ruta_trazabilidad,
        evidencia: e.ok ? e.data?.ruta : null,
        siguiente_paso: base.requiere_confirmacion
          ? "Mostrar la OC y las confirmaciones y TERMINAR el turno preguntando si confirma. No llamar oc_crear."
          : "Si la persona no pidió revisar antes, llamar oc_crear con este caso.",
      })
    } catch (e) {
      return fallo(`No se pudo procesar ${args.caso}: ${mensajeError(e)}`)
    }
  },
}
