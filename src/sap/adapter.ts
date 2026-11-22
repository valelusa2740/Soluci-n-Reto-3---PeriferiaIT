import type { OrdenCompra } from "../core/tipos.js"

/** Interfaz obligatoria (PRD 7.4). El mock la implementa con archivos; la real iría a SAP (ver SOLUCION.md §6). */
export interface SapAdapter {
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null>
}
