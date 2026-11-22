/**
 * Reglas de control RC1–RC10 (PRD 7.3). Funciones puras: reciben el paquete de UN caso y los
 * maestros, y no guardan estado; así ningún caso puede contaminar a otro.
 */
import type { Centro, Maestros, Proveedor } from "./maestros.js"
import type { Derivados, Hallazgo, Paquete, Validacion } from "./tipos.js"
import { diaLocal, normalizarNit, normalizarNombre } from "./util.js"

export const TOLERANCIA_COTIZACION = 0.02
export const TOLERANCIA_ARITMETICA = 1

type Acumulador = { bloqueos: Hallazgo[]; confirmaciones: Hallazgo[]; derivados: Derivados; retroactiva: boolean }

const fmt = (n: number) => n.toLocaleString("es-CO")

export function buscarProveedor(p: Paquete, m: Maestros): Proveedor | null {
  const nit = p.solicitud.proveedor_nit
  if (nit) return m.proveedores.find((x) => x.nit === normalizarNit(nit)) ?? null
  const nombre = normalizarNombre(p.solicitud.proveedor_nombre)
  return m.proveedores.find((x) => normalizarNombre(x.nombre) === nombre) ?? null
}

export function rc1Proveedor(p: Paquete, prov: Proveedor | null, acc: Acumulador): void {
  const id = p.solicitud.proveedor_nit ? `NIT ${p.solicitud.proveedor_nit}` : `nombre "${p.solicitud.proveedor_nombre}"`
  if (!prov) {
    acc.bloqueos.push({
      regla: "RC1",
      detalle: `El proveedor (${id}) no existe en el maestro de proveedores.`,
      accion_sugerida: "Solicitar la creación del proveedor en SAP (datos maestros) o elegir un proveedor registrado.",
    })
  } else if (!prov.activo) {
    acc.bloqueos.push({
      regla: "RC1",
      detalle: `El proveedor ${prov.nombre} (${prov.codigo_sap}) está inactivo.`,
      accion_sugerida: "Pedir a datos maestros reactivarlo o cambiar de proveedor.",
    })
  }
}

function aprobadorDelCentro(p: Paquete, centro: Centro | undefined) {
  const email = p.aprobacion?.de.toLowerCase()
  return centro?.aprobadores.find((a) => a.email.toLowerCase() === email)
}

export function rc2Aprobacion(p: Paquete, centro: Centro | undefined, acc: Acumulador): void {
  const a = p.aprobacion
  if (!a) {
    acc.bloqueos.push({ regla: "RC2", detalle: "No hay correo de aprobación en el paquete.", accion_sugerida: "Pedir al solicitante el correo de aprobación del líder." })
    return
  }
  if (!a.aprobado) {
    acc.bloqueos.push({ regla: "RC2", detalle: `El correo de ${a.de} no contiene "Aprobado".`, accion_sugerida: "Pedir al líder una aprobación explícita." })
  }
  if (!centro) {
    acc.bloqueos.push({ regla: "RC2", detalle: `El centro de costo ${p.solicitud.centro_costo} no existe en el maestro.`, accion_sugerida: "Corregir el centro de costo en la solicitud." })
  } else if (!aprobadorDelCentro(p, centro)) {
    const validos = centro.aprobadores.map((x) => x.email).join(", ")
    acc.bloqueos.push({
      regla: "RC2",
      detalle: `${a.de} no es aprobador del centro ${centro.centro_costo}. Aprobadores válidos: ${validos}.`,
      accion_sugerida: `Pedir la aprobación a un aprobador de ${centro.centro_costo}.`,
    })
  }
}

export function rc3Tope(p: Paquete, centro: Centro | undefined, acc: Acumulador): void {
  if (!centro || !p.aprobacion) return
  const total = p.solicitud.valor_total
  const aprobador = aprobadorDelCentro(p, centro)
  const maxCentro = Math.max(0, ...centro.aprobadores.map((x) => x.tope))
  const quienPuede = centro.aprobadores.filter((x) => x.tope >= total).map((x) => x.email)
  const accion = quienPuede.length
    ? `Pedir aprobación a ${quienPuede.join(" o ")}.`
    : `Ningún aprobador de ${centro.centro_costo} cubre ${fmt(total)} (tope máximo ${fmt(maxCentro)}): escalar o ajustar la matriz.`
  if (!aprobador) {
    acc.bloqueos.push({
      regla: "RC3",
      detalle: `${p.aprobacion.de} no tiene tope en ${centro.centro_costo}; un tope en otro centro no aplica. Valor ${fmt(total)}.`,
      accion_sugerida: accion,
      valores: { valor_total: total, tope: 0 },
    })
  } else if (total > aprobador.tope) {
    acc.bloqueos.push({
      regla: "RC3",
      detalle: `El valor ${fmt(total)} supera el tope de ${aprobador.email} en ${centro.centro_costo} (${fmt(aprobador.tope)}).`,
      accion_sugerida: accion,
      valores: { valor_total: total, tope: aprobador.tope },
    })
  }
}

export function rc4Subarea(p: Paquete, centro: Centro | undefined, acc: Acumulador): void {
  if (!centro) return
  if (!centro.subareas.includes(p.solicitud.subarea)) {
    acc.bloqueos.push({
      regla: "RC4",
      detalle: `La subárea "${p.solicitud.subarea}" no pertenece a ${centro.centro_costo} (${centro.subareas.join(", ")}).`,
      accion_sugerida: "Corregir la subárea o el centro de costo en la solicitud.",
    })
  }
}

export function rc5Cotizacion(p: Paquete, acc: Acumulador): void {
  const total = p.solicitud.valor_total
  if (!p.cotizacion) {
    acc.confirmaciones.push({ regla: "RC5", detalle: "No hay cotización: no se puede contrastar el valor.", valores: { solicitud: total } })
    return
  }
  const desvio = total === 0 ? 1 : Math.abs(p.cotizacion.total - total) / total
  if (desvio > TOLERANCIA_COTIZACION) {
    acc.confirmaciones.push({
      regla: "RC5",
      detalle: `La cotización (${fmt(p.cotizacion.total)}) difiere ${(desvio * 100).toFixed(1)} % de la solicitud (${fmt(total)}); tolerancia 2 %. La OC se crea por el valor de la solicitud.`,
      valores: { solicitud: total, cotizacion: p.cotizacion.total, desvio_pct: Number((desvio * 100).toFixed(2)) },
    })
  }
}

export function rc6Iva(p: Paquete, prov: Proveedor | null, acc: Acumulador): void {
  if (p.solicitud.indicador_iva || !prov) return
  acc.derivados.indicador_iva = prov.indicador_iva_default
  acc.confirmaciones.push({
    regla: "RC6",
    detalle: `La solicitud no trae indicador de IVA; se propone ${prov.indicador_iva_default} (por defecto del proveedor ${prov.nombre}).`,
    valores: { indicador_iva_derivado: prov.indicador_iva_default },
  })
}

export function rc7Pago(p: Paquete, prov: Proveedor | null, acc: Acumulador): void {
  if (p.solicitud.condiciones_pago || !prov) return
  acc.derivados.condiciones_pago = prov.condiciones_pago_default
}

export function rc8Retroactiva(p: Paquete, acc: Acumulador): void {
  const f = p.factura
  if (f && f.fecha < p.solicitud.fecha_solicitud) {
    acc.retroactiva = true
    acc.confirmaciones.push({
      regla: "RC8",
      detalle: `OC retroactiva: la factura ${f.numero} (${f.fecha}) es anterior a la solicitud (${p.solicitud.fecha_solicitud}). Quedará marcada en el control.`,
      valores: { factura: f.fecha, solicitud: p.solicitud.fecha_solicitud },
    })
  }
}

export function rc9FechaAprobacion(p: Paquete, acc: Acumulador): void {
  if (!p.aprobacion) return
  const dia = diaLocal(p.aprobacion.fecha)
  if (dia < p.solicitud.fecha_solicitud) {
    acc.confirmaciones.push({
      regla: "RC9",
      detalle: `La aprobación (${dia}) es anterior a la solicitud (${p.solicitud.fecha_solicitud}).`,
      valores: { aprobacion: dia, solicitud: p.solicitud.fecha_solicitud },
    })
  }
}

export function rc10Aritmetica(p: Paquete, acc: Acumulador): void {
  const { cantidad, valor_unitario, valor_total } = p.solicitud
  const calculado = cantidad * valor_unitario
  if (Math.abs(calculado - valor_total) > TOLERANCIA_ARITMETICA) {
    acc.bloqueos.push({
      regla: "RC10",
      detalle: `${fmt(cantidad)} × ${fmt(valor_unitario)} = ${fmt(calculado)}, pero el valor total dice ${fmt(valor_total)}.`,
      accion_sugerida: "Pedir al solicitante corregir cantidad, valor unitario o total.",
      valores: { calculado, valor_total },
    })
  }
}

/** HU-2: aplica RC1–RC10 al paquete de un caso. */
export function validarPaquete(p: Paquete, m: Maestros): Validacion {
  const acc: Acumulador = { bloqueos: [], confirmaciones: [], derivados: {}, retroactiva: false }
  const prov = buscarProveedor(p, m)
  const centro = m.centros.find((c) => c.centro_costo === p.solicitud.centro_costo)
  rc1Proveedor(p, prov, acc)
  rc2Aprobacion(p, centro, acc)
  rc3Tope(p, centro, acc)
  rc4Subarea(p, centro, acc)
  rc5Cotizacion(p, acc)
  rc6Iva(p, prov, acc)
  rc7Pago(p, prov, acc)
  rc8Retroactiva(p, acc)
  rc9FechaAprobacion(p, acc)
  rc10Aritmetica(p, acc)
  return {
    apta: acc.bloqueos.length === 0,
    ...acc,
    proveedor: prov && { codigo_sap: prov.codigo_sap, nit: prov.nit, nombre: prov.nombre },
  }
}
