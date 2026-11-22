import { readFile } from "node:fs/promises"
import path from "node:path"
import { cargarMaestros } from "../core/maestros.js"
import { type Ctx, rutas } from "../core/rutas.js"
import { escribirArchivo, enSerie } from "../core/salidas.js"
import type { OrdenCompra } from "../core/tipos.js"
import { normalizarNit } from "../core/util.js"
import type { SapAdapter } from "./adapter.js"

export const PRIMER_NUMERO_OC = 4500000001

type Registro = { numero_oc: string; fecha: string; orden: OrdenCompra }

/** SAP simulado sobre out/sap/ordenes.jsonl: números secuenciales e idempotencia por solicitud_id. */
export class SapMock implements SapAdapter {
  private readonly archivo: string

  constructor(private readonly ctx: Ctx) {
    this.archivo = path.join(rutas(ctx).sap, "ordenes.jsonl")
  }

  private async leerOrdenes(): Promise<Registro[]> {
    try {
      const texto = await readFile(this.archivo, "utf8")
      return texto
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Registro)
    } catch {
      return []
    }
  }

  async consultarProveedor(nit: string) {
    const { proveedores } = await cargarMaestros(this.ctx)
    const p = proveedores.find((x) => x.nit === normalizarNit(nit))
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  async buscarOrdenPorReferencia(solicitud_id: string) {
    const r = (await this.leerOrdenes()).find((o) => o.orden.referencia.solicitud_id === solicitud_id)
    return r ? { numero_oc: r.numero_oc } : null
  }

  /** Crear es atómico dentro del proceso: si la referencia ya existe, devuelve la OC existente. */
  crearOrden(orden: OrdenCompra) {
    return enSerie(async () => {
      const ordenes = await this.leerOrdenes()
      const existente = ordenes.find((o) => o.orden.referencia.solicitud_id === orden.referencia.solicitud_id)
      if (existente) return { numero_oc: existente.numero_oc, fecha: existente.fecha }
      const registro: Registro = {
        numero_oc: String(PRIMER_NUMERO_OC + ordenes.length),
        fecha: new Date().toISOString(),
        orden,
      }
      const contenido = [...ordenes, registro].map((o) => JSON.stringify(o)).join("\n") + "\n"
      await escribirArchivo(this.archivo, contenido)
      return { numero_oc: registro.numero_oc, fecha: registro.fecha }
    })
  }
}
