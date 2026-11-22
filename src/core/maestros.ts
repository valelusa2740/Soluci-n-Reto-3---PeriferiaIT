import { readFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { type Ctx, rutas } from "./rutas.js"

const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
})
const CentroSchema = z.object({
  centro_costo: z.string(),
  nombre: z.string().optional(),
  subareas: z.array(z.string()),
  aprobadores: z.array(z.object({ email: z.string(), nombre: z.string().optional(), tope: z.number() })),
})
const CodigoSchema = z.object({ codigo: z.string(), descripcion: z.string() })

export type Proveedor = z.infer<typeof ProveedorSchema>
export type Centro = z.infer<typeof CentroSchema>
export type Maestros = {
  proveedores: Proveedor[]
  centros: Centro[]
  iva: z.infer<typeof CodigoSchema>[]
  pago: z.infer<typeof CodigoSchema>[]
}

async function leer<T>(archivo: string, schema: z.ZodType<T>): Promise<T> {
  const texto = await readFile(archivo, "utf8")
  return schema.parse(JSON.parse(texto))
}

/** Lee los 4 maestros de fixtures (solo lectura). Lanza si un maestro está corrupto. */
export async function cargarMaestros(ctx: Ctx): Promise<Maestros> {
  const dir = rutas(ctx).maestros
  const [proveedores, centros, iva, pago] = await Promise.all([
    leer(path.join(dir, "proveedores.json"), z.array(ProveedorSchema)),
    leer(path.join(dir, "centros-costo.json"), z.array(CentroSchema)),
    leer(path.join(dir, "indicadores-iva.json"), z.array(CodigoSchema)),
    leer(path.join(dir, "condiciones-pago.json"), z.array(CodigoSchema)),
  ])
  return { proveedores, centros, iva, pago }
}
