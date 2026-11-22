import type { Derivados, OrdenCompra, Paquete, Trazabilidad, Validacion } from "./tipos.js"
import { OrdenCompraSchema } from "./tipos.js"
import { sha256 } from "./util.js"

export const MAX_DESCRIPCION = 40

/** HU-4: texto de evidencia de aprobación. Determinista: mismo correo → mismo sha256. */
export function textoEvidencia(p: Paquete): string | null {
  const a = p.aprobacion
  if (!a) return null
  return [
    "EVIDENCIA DE APROBACIÓN",
    `Solicitud: ${p.solicitud.solicitud_id}`,
    `De: ${a.de}`,
    `Para: ${a.para}`,
    `Fecha: ${a.fecha}`,
    `Asunto: ${a.asunto}`,
    "",
    a.texto,
    "",
  ].join("\n")
}

export function recortar(texto: string, max = MAX_DESCRIPCION): string {
  const limpio = texto.replace(/\s+/g, " ").trim()
  if (limpio.length <= max) return limpio
  const corte = limpio.slice(0, max + 1).lastIndexOf(" ")
  return (corte > max / 2 ? limpio.slice(0, corte) : limpio.slice(0, max)).trimEnd()
}

/** Unidad SAP: horas si la cotización/solicitud habla de horas; si no, unidades. */
export function derivarUnidad(p: Paquete): "UN" | "H" | "MES" {
  const item = p.cotizacion?.texto.match(/^1\.\s*(.+)$/m)?.[1] ?? ""
  if (/\bhoras?\b/i.test(`${item} ${p.solicitud.descripcion}`)) return "H"
  return "UN"
}

export type PayloadConstruido = { orden: OrdenCompra; trazabilidad: Trazabilidad }

/** HU-3: arma la OC (7.4) con la fuente de cada valor. Requiere una validación sin bloqueos. */
export function construirOrden(p: Paquete, v: Validacion, derivados: Derivados): PayloadConstruido {
  if (!v.apta || !v.proveedor || !p.aprobacion) {
    throw new Error(`No se construye la OC: hay bloqueos (${v.bloqueos.map((b) => b.regla).join(", ")}).`)
  }
  const s = p.solicitud
  const iva = s.indicador_iva ?? derivados.indicador_iva
  const pago = s.condiciones_pago ?? derivados.condiciones_pago
  if (!iva || !pago) throw new Error("Faltan indicador de IVA o condiciones de pago y no se pudieron derivar.")
  const evidencia = textoEvidencia(p) ?? ""
  const descripcion = recortar(s.descripcion)
  const unidad = derivarUnidad(p)

  const orden = OrdenCompraSchema.parse({
    referencia: { solicitud_id: s.solicitud_id, correo_id: p.correo.id, cotizacion_ref: p.cotizacion?.referencia ?? null },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: v.proveedor,
    moneda: s.moneda,
    condiciones_pago: pago,
    aprobador: { email: p.aprobacion.de, fecha_aprobacion: p.aprobacion.fecha, evidencia_sha256: sha256(evidencia) },
    posiciones: [
      {
        numero: 10,
        descripcion,
        cantidad: s.cantidad,
        unidad,
        precio_unitario: s.valor_unitario,
        centro_costo: s.centro_costo,
        subarea: s.subarea,
        indicador_iva: iva,
      },
    ],
    excepciones: v.confirmaciones.map((c) => ({ codigo: c.regla, detalle: c.detalle, confirmado_por: null })),
  })

  const trazabilidad: Trazabilidad = {
    "referencia.solicitud_id": { valor: s.solicitud_id, fuente: "solicitud" },
    "referencia.correo_id": { valor: p.correo.id, fuente: "solicitud", nota: "correo.json del paquete" },
    "referencia.cotizacion_ref": { valor: orden.referencia.cotizacion_ref, fuente: "cotizacion" },
    sociedad: { valor: "1000", fuente: "constante" },
    organizacion_compras: { valor: "1000", fuente: "constante" },
    "proveedor.codigo_sap": { valor: v.proveedor.codigo_sap, fuente: "maestro.proveedores" },
    "proveedor.nit": { valor: v.proveedor.nit, fuente: "maestro.proveedores" },
    "proveedor.nombre": { valor: v.proveedor.nombre, fuente: "maestro.proveedores" },
    moneda: { valor: s.moneda, fuente: "solicitud" },
    condiciones_pago: s.condiciones_pago
      ? { valor: pago, fuente: "solicitud" }
      : { valor: pago, fuente: "maestro.proveedores", nota: "RC7: derivado de condiciones_pago_default" },
    "aprobador.email": { valor: p.aprobacion.de, fuente: "aprobacion" },
    "aprobador.fecha_aprobacion": { valor: p.aprobacion.fecha, fuente: "aprobacion" },
    "aprobador.evidencia_sha256": { valor: orden.aprobador.evidencia_sha256, fuente: "derivado", nota: "sha256 de aprobacion.txt" },
    "posiciones[0].numero": { valor: 10, fuente: "constante" },
    "posiciones[0].descripcion": {
      valor: descripcion,
      fuente: "solicitud",
      nota: descripcion.length < s.descripcion.length ? `recortada a ${MAX_DESCRIPCION} caracteres` : undefined,
    },
    "posiciones[0].cantidad": { valor: s.cantidad, fuente: "solicitud" },
    "posiciones[0].unidad": { valor: unidad, fuente: "derivado", nota: "según el ítem de la cotización" },
    "posiciones[0].precio_unitario": { valor: s.valor_unitario, fuente: "solicitud" },
    "posiciones[0].centro_costo": { valor: s.centro_costo, fuente: "solicitud" },
    "posiciones[0].subarea": { valor: s.subarea, fuente: "solicitud" },
    "posiciones[0].indicador_iva": s.indicador_iva
      ? { valor: iva, fuente: "solicitud" }
      : { valor: iva, fuente: "maestro.proveedores", nota: "RC6: derivado de indicador_iva_default, requiere confirmación" },
  }
  return { orden, trazabilidad }
}
