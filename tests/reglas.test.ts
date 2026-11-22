// Pruebas unitarias por regla (SPEC §4): positivo, negativo y excepción, sobre paquetes reales
// modificados en memoria. Las reglas son funciones puras.
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { cargarMaestros, type Maestros } from "../src/core/maestros.js"
import { esAprobado, leerPaquete } from "../src/core/paquete.js"
import { validarPaquete } from "../src/core/reglas.js"
import type { Paquete } from "../src/core/tipos.js"
import { diaLocal, normalizarNit, normalizarNombre, parsearMonto } from "../src/core/util.js"
import { crearEntorno } from "./entorno.js"

let entorno: Awaited<ReturnType<typeof crearEntorno>>
let maestros: Maestros
const paquetes: Record<string, Paquete> = {}

beforeAll(async () => {
  entorno = await crearEntorno()
  maestros = await cargarMaestros(entorno)
  for (const c of ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"]) {
    const r = await leerPaquete(entorno, c)
    if (!r.ok) throw new Error(r.error)
    paquetes[c] = r.paquete
  }
})
afterAll(() => entorno.limpiar())

/** Copia profunda + cambios: cada prueba trabaja sobre su propio paquete. */
const con = (caso: string, cambio: (p: Paquete) => void): Paquete => {
  const p = structuredClone(paquetes[caso])
  cambio(p)
  return p
}
const reglas = (h: { regla: string }[]) => h.map((x) => x.regla)

describe("L — lectura y normalización", () => {
  it("L1 normaliza NIT con puntos y dígito de verificación", () => {
    expect(normalizarNit("900.555.111-2")).toBe("900555111")
    expect(normalizarNit("900555111")).toBe("900555111")
    expect(paquetes["sol-001"].cotizacion?.nit).toBe("900555111")
  })
  it("L2 convierte montos en formato colombiano", () => {
    expect(parsearMonto("COP 11.400.000")).toBe(11400000)
    expect(parsearMonto("sin monto")).toBeNull()
    expect(paquetes["sol-004"].cotizacion?.total).toBe(26500000)
    expect(paquetes["sol-005"].factura).toEqual({ numero: "FC-88231", fecha: "2026-08-10", total: 3200000 })
  })
  it("L4 detecta 'Aprobado' y rechaza negaciones", () => {
    expect(esAprobado("Aprobado, proceder.")).toBe(true)
    expect(esAprobado("No aprobado por ahora.")).toBe(false)
    expect(esAprobado("Queda rechazado.")).toBe(false)
    expect(esAprobado("Revisemos el lunes.")).toBe(false)
  })
  it("normaliza nombres sin tildes ni puntuación", () => {
    expect(normalizarNombre("Consultores Ágiles S.A.S.")).toBe("consultores agiles s a s")
  })
  it("diaLocal usa el día del correo, no UTC", () => {
    expect(diaLocal("2026-08-26T18:45:00-05:00")).toBe("2026-08-26")
  })
})

describe("RC1 proveedor existe y activo (bloqueo)", () => {
  it("positivo: sol-001 por NIT", () => expect(reglas(validarPaquete(paquetes["sol-001"], maestros).bloqueos)).not.toContain("RC1"))
  it("positivo: sol-006 sin NIT, por nombre normalizado", () => {
    const v = validarPaquete(paquetes["sol-006"], maestros)
    expect(reglas(v.bloqueos)).not.toContain("RC1")
    expect(v.proveedor?.codigo_sap).toBe("100234")
  })
  it("negativo: sol-002 NIT inexistente", () => expect(reglas(validarPaquete(paquetes["sol-002"], maestros).bloqueos)).toContain("RC1"))
  it("negativo: proveedor inactivo", () => {
    const p = con("sol-001", (x) => { x.solicitud.proveedor_nit = "901777888" })
    expect(validarPaquete(p, maestros).bloqueos[0]).toMatchObject({ regla: "RC1", detalle: expect.stringContaining("inactivo") })
  })
  it("excepción: sin NIT y nombre desconocido", () => {
    const p = con("sol-006", (x) => { x.solicitud.proveedor_nombre = "Proveedor Fantasma" })
    expect(reglas(validarPaquete(p, maestros).bloqueos)).toContain("RC1")
  })
})

describe("RC2 aprobación válida del centro (bloqueo)", () => {
  it("positivo: sol-001 mlopez aprueba CC-1010", () => expect(reglas(validarPaquete(paquetes["sol-001"], maestros).bloqueos)).not.toContain("RC2"))
  it("negativo: sol-003 fvargas no es aprobador de CC-2020", () => {
    const b = validarPaquete(paquetes["sol-003"], maestros).bloqueos.find((x) => x.regla === "RC2")
    expect(b?.detalle).toContain("rtorres@periferia-ficticia.com")
  })
  it("negativo: cuerpo sin 'Aprobado'", () => {
    const p = con("sol-001", (x) => { if (x.aprobacion) x.aprobacion.aprobado = false })
    expect(reglas(validarPaquete(p, maestros).bloqueos)).toContain("RC2")
  })
  it("excepción: sin correo de aprobación", () => {
    const p = con("sol-001", (x) => { x.aprobacion = null })
    expect(reglas(validarPaquete(p, maestros).bloqueos)).toContain("RC2")
  })
})

describe("RC3 tope del aprobador en ESE centro (bloqueo)", () => {
  it("positivo: sol-004 25M ≤ 200M de dgarcia", () => expect(reglas(validarPaquete(paquetes["sol-004"], maestros).bloqueos)).not.toContain("RC3"))
  it("negativo: sol-003 el tope de 80M de fvargas es de CC-3030 y no aplica en CC-2020", () => {
    const b = validarPaquete(paquetes["sol-003"], maestros).bloqueos.find((x) => x.regla === "RC3")
    expect(b?.valores).toEqual({ valor_total: 74000000, tope: 0 })
    expect(b?.accion_sugerida).toContain("Ningún aprobador de CC-2020")
  })
  it("negativo: monto mayor al tope del aprobador correcto", () => {
    const p = con("sol-001", (x) => { x.solicitud.cantidad = 600; x.solicitud.valor_total = 57000000 })
    const b = validarPaquete(p, maestros).bloqueos.find((x) => x.regla === "RC3")
    expect(b?.valores).toEqual({ valor_total: 57000000, tope: 50000000 })
    expect(b?.accion_sugerida).toContain("dgarcia")
  })
})

describe("RC4 subárea del centro (bloqueo)", () => {
  it("positivo: todos los casos reales", () => {
    for (const p of Object.values(paquetes)) expect(reglas(validarPaquete(p, maestros).bloqueos)).not.toContain("RC4")
  })
  it("negativo: subárea de otro centro", () => {
    const p = con("sol-001", (x) => { x.solicitud.subarea = "Marketing" })
    expect(reglas(validarPaquete(p, maestros).bloqueos)).toContain("RC4")
  })
})

describe("RC5 cotización vs solicitud ≤ 2 % (confirmación)", () => {
  it("positivo: sol-001 sin desvío", () => expect(reglas(validarPaquete(paquetes["sol-001"], maestros).confirmaciones)).not.toContain("RC5"))
  it("positivo: desvío de 1,5 % se tolera", () => {
    const p = con("sol-001", (x) => { if (x.cotizacion) x.cotizacion.total = 11571000 })
    expect(reglas(validarPaquete(p, maestros).confirmaciones)).not.toContain("RC5")
  })
  it("negativo: sol-004 6 % muestra ambos valores", () => {
    const c = validarPaquete(paquetes["sol-004"], maestros).confirmaciones.find((x) => x.regla === "RC5")
    expect(c?.valores).toMatchObject({ solicitud: 25000000, cotizacion: 26500000, desvio_pct: 6 })
  })
  it("excepción: sin cotización pide confirmación", () => {
    const p = con("sol-001", (x) => { x.cotizacion = null })
    expect(reglas(validarPaquete(p, maestros).confirmaciones)).toContain("RC5")
  })
})

describe("RC6/RC7 derivados del proveedor", () => {
  it("positivo: sol-001 trae IVA y pago, no deriva", () => {
    const v = validarPaquete(paquetes["sol-001"], maestros)
    expect(v.derivados).toEqual({})
  })
  it("negativo: sol-006 deriva C1 (confirmación) y Z030 (solo informa)", () => {
    const v = validarPaquete(paquetes["sol-006"], maestros)
    expect(v.derivados).toEqual({ indicador_iva: "C1", condiciones_pago: "Z030" })
    expect(reglas(v.confirmaciones)).toEqual(["RC6"])
  })
})

describe("RC8 factura anterior a la solicitud → retroactiva (confirmación)", () => {
  it("positivo: sol-001 sin factura", () => expect(validarPaquete(paquetes["sol-001"], maestros).retroactiva).toBe(false))
  it("negativo: sol-005 FC-88231 del 10-ago < 27-ago", () => {
    const v = validarPaquete(paquetes["sol-005"], maestros)
    expect(v.retroactiva).toBe(true)
    expect(reglas(v.confirmaciones)).toEqual(["RC8"])
  })
  it("factura posterior no es retroactiva", () => {
    const p = con("sol-005", (x) => { if (x.factura) x.factura.fecha = "2026-08-30" })
    expect(validarPaquete(p, maestros).retroactiva).toBe(false)
  })
})

describe("RC9 aprobación ≥ solicitud por día local (confirmación)", () => {
  it("positivo: sol-004 aprobada el mismo día a las 18:45 -05:00", () => expect(reglas(validarPaquete(paquetes["sol-004"], maestros).confirmaciones)).not.toContain("RC9"))
  it("negativo: aprobación anterior a la solicitud", () => {
    const p = con("sol-001", (x) => { if (x.aprobacion) x.aprobacion.fecha = "2026-08-19T23:30:00-05:00" })
    expect(reglas(validarPaquete(p, maestros).confirmaciones)).toContain("RC9")
  })
})

describe("RC10 cantidad × valor unitario = total ±1 (bloqueo)", () => {
  it("positivo: todos los casos reales", () => {
    for (const p of Object.values(paquetes)) expect(reglas(validarPaquete(p, maestros).bloqueos)).not.toContain("RC10")
  })
  it("positivo: diferencia de 1 peso se tolera", () => {
    const p = con("sol-001", (x) => { x.solicitud.valor_total = 11400001 })
    expect(reglas(validarPaquete(p, maestros).bloqueos)).not.toContain("RC10")
  })
  it("negativo: total que no cuadra", () => {
    const p = con("sol-004", (x) => { x.solicitud.valor_total = 26000000 })
    expect(reglas(validarPaquete(p, maestros).bloqueos)).toContain("RC10")
  })
})

describe("Excepciones por regla (datos ausentes o límite)", () => {
  it("RC3/RC4 centro de costo inexistente: bloqueo claro sin fallar", () => {
    const v = validarPaquete(con("sol-001", (x) => { x.solicitud.centro_costo = "CC-9999" }), maestros)
    expect(v.apta).toBe(false)
    expect(v.bloqueos.find((b) => b.regla === "RC2")?.detalle).toContain("CC-9999")
    expect(reglas(v.bloqueos)).not.toContain("RC4")
  })
  it("RC3 en el límite exacto del tope (= 50M) pasa", () => {
    const p = con("sol-001", (x) => { x.solicitud.cantidad = 500; x.solicitud.valor_unitario = 100000; x.solicitud.valor_total = 50000000; if (x.cotizacion) x.cotizacion.total = 50000000 })
    expect(reglas(validarPaquete(p, maestros).bloqueos)).not.toContain("RC3")
  })
  it("RC4 subárea con distinto uso de mayúsculas no pertenece (comparación exacta)", () => {
    expect(reglas(validarPaquete(con("sol-001", (x) => { x.solicitud.subarea = "infraestructura" }), maestros).bloqueos)).toContain("RC4")
  })
  it("RC5 desvío exactamente en 2 % se tolera", () => {
    expect(reglas(validarPaquete(con("sol-001", (x) => { if (x.cotizacion) x.cotizacion.total = 11628000 }), maestros).confirmaciones)).not.toContain("RC5")
  })
  it("RC6/RC7 sin IVA ni pago y proveedor inexistente: no se inventa derivado, bloquea RC1", () => {
    const v = validarPaquete(con("sol-006", (x) => { x.solicitud.proveedor_nombre = "Desconocido S.A.S." }), maestros)
    expect(v.derivados).toEqual({})
    expect(reglas(v.bloqueos)).toContain("RC1")
  })
  it("RC8 factura del mismo día de la solicitud no es retroactiva", () => {
    expect(validarPaquete(con("sol-005", (x) => { if (x.factura) x.factura.fecha = "2026-08-27" }), maestros).retroactiva).toBe(false)
  })
  it("RC9 sin aprobación no genera RC9 (ya bloquea RC2)", () => {
    const v = validarPaquete(con("sol-001", (x) => { x.aprobacion = null }), maestros)
    expect(reglas(v.confirmaciones)).not.toContain("RC9")
    expect(reglas(v.bloqueos)).toContain("RC2")
  })
  it("RC10 diferencia de 2 pesos bloquea (fuera de ±1)", () => {
    expect(reglas(validarPaquete(con("sol-001", (x) => { x.solicitud.valor_total = 11400002 }), maestros).bloqueos)).toContain("RC10")
  })
})
