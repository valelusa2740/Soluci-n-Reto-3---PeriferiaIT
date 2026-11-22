/**
 * Registro de herramientas: nombre `<archivo>_<export>`, validación de argumentos con zod antes de
 * ejecutar (T2) y registro de cada llamada en out/log.jsonl (T3/CA4).
 */
import { z } from "zod"
import type { Ctx } from "../core/rutas.js"
import { registrarLog } from "../core/salidas.js"
import { mensajeError } from "../core/util.js"
import * as oc from "./oc.js"

export type Herramienta = {
  description: string
  args: z.ZodRawShape
  // El contrato del PRD tipa args por herramienta; aquí se recibe ya validado por zod.
  execute(args: never, ctx: Ctx): Promise<string>
}

/** Agrupa los exports de un módulo de herramientas con el prefijo del archivo. */
function conPrefijo(prefijo: string, modulo: Record<string, unknown>): Record<string, Herramienta> {
  const salida: Record<string, Herramienta> = {}
  for (const [nombre, valor] of Object.entries(modulo)) {
    if (valor && typeof valor === "object" && "execute" in valor && "args" in valor) {
      salida[`${prefijo}_${nombre}`] = valor as Herramienta
    }
  }
  return salida
}

export const herramientas: Record<string, Herramienta> = conPrefijo("oc", oc)

/** Esquema JSON para el proveedor LLM (lo genera zod; no se duplica a mano). */
export function definicionesParaModelo() {
  return Object.entries(herramientas).map(([nombre, h]) => ({
    nombre,
    descripcion: h.description,
    esquema: z.toJSONSchema(z.object(h.args)) as Record<string, unknown>,
  }))
}

export type LlamadaEjecutada = { nombre: string; args: unknown; resultado: string; ok: boolean; ms: number }

/** Ejecuta una herramienta por nombre. Nunca lanza: todo error vuelve como {ok:false}. */
export async function ejecutarHerramienta(nombre: string, argsCrudos: unknown, ctx: Ctx): Promise<LlamadaEjecutada> {
  const inicio = Date.now()
  const h = herramientas[nombre]
  let resultado: string
  if (!h) {
    resultado = JSON.stringify({ ok: false, error: `Herramienta desconocida: ${nombre}` })
  } else {
    const parsed = z.object(h.args).safeParse(argsCrudos)
    if (!parsed.success) {
      const detalle = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      resultado = JSON.stringify({ ok: false, error: `Argumentos inválidos para ${nombre}: ${detalle}` })
    } else {
      try {
        resultado = await h.execute(parsed.data as never, ctx)
      } catch (e) {
        resultado = JSON.stringify({ ok: false, error: `Error inesperado en ${nombre}: ${mensajeError(e)}` })
      }
    }
  }
  const okFlag = esOk(resultado)
  const ms = Date.now() - inicio
  await registrarLog(ctx, { herramienta: nombre, args: argsCrudos, ok: okFlag, ms, error: okFlag ? undefined : errorDe(resultado) }).catch(() => undefined)
  return { nombre, args: argsCrudos, resultado, ok: okFlag, ms }
}

function esOk(resultado: string): boolean {
  try {
    return (JSON.parse(resultado) as { ok?: unknown }).ok === true
  } catch {
    return false
  }
}

function errorDe(resultado: string): string | undefined {
  try {
    const e = (JSON.parse(resultado) as { error?: unknown }).error
    return typeof e === "string" ? e : undefined
  } catch {
    return undefined
  }
}
