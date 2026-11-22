// Pruebas por caso a través de las herramientas (SPEC §5–§7): el oráculo es la tabla del SPEC.
import { readFile } from "node:fs/promises"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { OrdenCompraSchema } from "../src/core/tipos.js"
import type { Ctx } from "../src/core/rutas.js"
import { ejecutarHerramienta } from "../src/tools/registro.js"
import { casoSintetico, crearEntorno, parse } from "./entorno.js"

type Entorno = Awaited<ReturnType<typeof crearEntorno>>
let entorno: Entorno
beforeEach(async () => { entorno = await crearEntorno() })
afterEach(() => entorno.limpiar())

const llamar = async (ctx: Ctx, nombre: string, args: Record<string, unknown>) => parse((await ejecutarHerramienta(nombre, args, ctx)).resultado)

type V = { apta: boolean; bloqueos: { regla: string }[]; confirmaciones: { regla: string }[]; derivados: Record<string, string>; retroactiva: boolean }

/** Flujo completo sin modelo: leer → validar → construir → evidencia → crear. */
async function procesar(ctx: Ctx, caso: string, confirmado?: boolean) {
  const paquete = await llamar(ctx, "oc_leer_paquete", { caso })
  const v = await llamar(ctx, "oc_validar", { caso, paquete: paquete.data })
  const val = v.data as unknown as V
  const payload = val.apta ? await llamar(ctx, "oc_construir_payload", { caso, paquete: paquete.data, derivados: val.derivados }) : null
  const orden = payload?.ok ? (payload.data as { orden: Record<string, unknown> }).orden : {}
  const crear = await llamar(ctx, "oc_crear", { caso, payload: orden, confirmado })
  return { val, payload, crear }
}
const reglas = (h: { regla: string }[]) => h.map((x) => x.regla)
const control = async (ctx: Ctx) => (await readFile(path.join(ctx.directory, "out/control.csv"), "utf8")).trim().split("\n")

describe("Resultado esperado por caso (SPEC §5)", () => {
  it("sol-001: apta, se crea sin intervención y la 2.ª vez es idempotente", async () => {
    const a = await procesar(entorno, "sol-001")
    expect(a.val).toMatchObject({ apta: true, bloqueos: [], confirmaciones: [], retroactiva: false })
    expect(a.crear.data).toMatchObject({ numero_oc: "4500000001", idempotente: false })
    const b = await procesar(entorno, "sol-001")
    expect(b.crear.data).toMatchObject({ numero_oc: "4500000001", idempotente: true })
    const sap = (await readFile(path.join(entorno.directory, "out/sap/ordenes.jsonl"), "utf8")).trim().split("\n")
    expect(sap).toHaveLength(1)
  })
  it("sol-002: bloqueo RC1, no crea", async () => {
    const r = await procesar(entorno, "sol-002")
    expect(r.val.apta).toBe(false)
    expect(reglas(r.val.bloqueos)).toEqual(["RC1"])
    expect(r.crear.ok).toBe(false)
    expect(r.crear.error).toContain("RC1")
  })
  it("sol-003: bloqueos RC2 y RC3, no crea", async () => {
    const r = await procesar(entorno, "sol-003")
    expect(reglas(r.val.bloqueos)).toEqual(["RC2", "RC3"])
    expect(r.crear.ok).toBe(false)
  })
  it("sol-004: confirmación RC5; sin confirmación queda pendiente", async () => {
    const r = await procesar(entorno, "sol-004")
    expect(r.val).toMatchObject({ apta: true, retroactiva: false })
    expect(reglas(r.val.confirmaciones)).toEqual(["RC5"])
    expect(r.crear.error).toContain("REQUIERE_CONFIRMACION")
  })
  it("sol-004: con confirmación humana se crea y registra quién confirmó", async () => {
    const ctx = { ...entorno, confirmacionHumana: (c: string) => c === "sol-004" }
    const r = await procesar(ctx, "sol-004", true)
    expect(r.crear.data).toMatchObject({ numero_oc: "4500000001", idempotente: false })
    const sap = JSON.parse((await readFile(path.join(entorno.directory, "out/sap/ordenes.jsonl"), "utf8")).trim())
    expect(sap.orden.excepciones[0]).toMatchObject({ codigo: "RC5", confirmado_por: "analista (sesión test)" })
  })
  it("sol-005: retroactiva solo con confirmación y marcada en control.csv", async () => {
    const pendiente = await procesar(entorno, "sol-005")
    expect(pendiente.val.retroactiva).toBe(true)
    expect(reglas(pendiente.val.confirmaciones)).toEqual(["RC8"])
    expect(pendiente.crear.ok).toBe(false)
    const creada = await procesar(entorno, "sol-005", true)
    expect(creada.crear.data).toMatchObject({ retroactiva: true, idempotente: false })
    const filas = await control(entorno)
    expect(filas[0]).toBe("solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts")
    expect(filas[1]).toMatch(/^SOL-2026-005,pendiente_confirmacion,,true,,RC8,/)
    expect(filas[2]).toMatch(/^SOL-2026-005,creada,4500000001,true,,RC8,/)
  })
  it("sol-006: proveedor por nombre, deriva C1 (confirmación) y Z030", async () => {
    const r = await procesar(entorno, "sol-006", true)
    expect(r.val.derivados).toEqual({ indicador_iva: "C1", condiciones_pago: "Z030" })
    expect(reglas(r.val.confirmaciones)).toEqual(["RC6"])
    const orden = (r.payload?.data as { orden: { condiciones_pago: string; posiciones: { indicador_iva: string }[] } }).orden
    expect(orden.condiciones_pago).toBe("Z030")
    expect(orden.posiciones[0].indicador_iva).toBe("C1")
    expect(r.crear.ok).toBe(true)
  })
})

describe("Confirmación humana validada por el servidor (C4)", () => {
  it("el modelo no puede confirmar solo: confirmado=true sin certificación del host no crea", async () => {
    const ctx = { ...entorno, confirmacionHumana: () => false }
    const r = await procesar(ctx, "sol-004", true)
    expect(r.crear.ok).toBe(false)
    expect(r.crear.error).toContain("REQUIERE_CONFIRMACION")
  })
  it("la confirmación de un caso no vale para otro", async () => {
    const ctx = { ...entorno, confirmacionHumana: (c: string) => c === "sol-004" }
    const r = await procesar(ctx, "sol-005", true)
    expect(r.crear.ok).toBe(false)
  })
  it("un bloqueo no se salta con confirmación", async () => {
    const ctx = { ...entorno, confirmacionHumana: () => true }
    expect((await procesar(ctx, "sol-003", true)).crear.ok).toBe(false)
  })
})

describe("Payload, trazabilidad y evidencia (SPEC §6)", () => {
  it("P1–P3 el payload valida con zod, descripción ≤ 40 y trazabilidad en archivo", async () => {
    const r = await procesar(entorno, "sol-001")
    const data = r.payload?.data as { orden: unknown; ruta_trazabilidad: string; trazabilidad: Record<string, { fuente: string }> }
    const orden = OrdenCompraSchema.parse(data.orden)
    expect(orden.posiciones[0].descripcion.length).toBeLessThanOrEqual(40)
    expect(data.ruta_trazabilidad).toBe("out/sol-001/trazabilidad.json")
    expect(data.trazabilidad["proveedor.codigo_sap"].fuente).toBe("maestro.proveedores")
    const archivo = JSON.parse(await readFile(path.join(entorno.directory, data.ruta_trazabilidad), "utf8"))
    expect(archivo.orden).toEqual(data.orden)
  })
  it("unidad H para la bolsa de horas de sol-004", async () => {
    const r = await procesar(entorno, "sol-004")
    expect((r.payload?.data as { orden: { posiciones: { unidad: string }[] } }).orden.posiciones[0].unidad).toBe("H")
  })
  it("E1 evidencia con encabezados y el mismo sha256 que el payload", async () => {
    const ev = await llamar(entorno, "oc_generar_evidencia", { caso: "sol-001" })
    const d = ev.data as { ruta: string; sha256: string }
    const texto = await readFile(path.join(entorno.directory, d.ruta), "utf8")
    expect(texto).toContain("De: mlopez@periferia-ficticia.com")
    expect(texto).toContain("Asunto: RE: Solicitud de orden de compra SOL-001")
    const r = await procesar(entorno, "sol-001")
    expect((r.payload?.data as { orden: { aprobador: { evidencia_sha256: string } } }).orden.aprobador.evidencia_sha256).toBe(d.sha256)
  })
  it("construir_payload con bloqueos devuelve error, no OC", async () => {
    const r = await llamar(entorno, "oc_construir_payload", { caso: "sol-002", paquete: {}, derivados: {} })
    expect(r.ok).toBe(false)
  })
  it("V4 el modelo no puede alterar montos: se usa lo de los archivos y se advierte", async () => {
    const p = await llamar(entorno, "oc_leer_paquete", { caso: "sol-004" })
    const alterado = structuredClone(p.data) as { solicitud: { valor_total: number } }
    alterado.solicitud.valor_total = 26500000
    const v = await llamar(entorno, "oc_validar", { caso: "sol-004", paquete: alterado })
    expect((v.data as unknown as V).confirmaciones.map((c) => c.regla)).toEqual(["RC5"])
    expect((v.data as { advertencias: string[] }).advertencias[0]).toContain("no coincide")
  })
})

describe("Aislamiento entre casos (V2) y numeración SAP (C5)", () => {
  it("validar en distinto orden da el mismo resultado", async () => {
    const casos = ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"]
    const ida: Record<string, unknown> = {}
    for (const c of casos) ida[c] = (await procesar(entorno, c)).val
    const otro = await crearEntorno()
    const vuelta: Record<string, unknown> = {}
    for (const c of [...casos].reverse()) vuelta[c] = (await procesar(otro, c)).val
    await otro.limpiar()
    expect(vuelta).toEqual(ida)
  })
  it("números secuenciales desde 4500000001 y un caso malo no frena el siguiente", async () => {
    const ctx = { ...entorno, confirmacionHumana: () => true }
    expect((await procesar(ctx, "sol-002", true)).crear.ok).toBe(false)
    expect((await procesar(ctx, "sol-001", true)).crear.data).toMatchObject({ numero_oc: "4500000001" })
    expect((await procesar(ctx, "sol-004", true)).crear.data).toMatchObject({ numero_oc: "4500000002" })
  })
})

describe("Excepciones (HU-6, T1–T3)", () => {
  it("caso inexistente", async () => {
    const r = await llamar(entorno, "oc_leer_paquete", { caso: "sol-999" })
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("no existe") })
  })
  it("T1 rechaza rutas fuera de fixtures", async () => {
    const r = await llamar(entorno, "oc_leer_paquete", { caso: "../../etc" })
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Argumentos inválidos") })
  })
  it("T2 argumentos faltantes y herramienta desconocida", async () => {
    expect((await llamar(entorno, "oc_validar", { paquete: {} })).ok).toBe(false)
    expect((await llamar(entorno, "oc_borrar_todo", {})).error).toContain("desconocida")
  })
  it("JSON malformado", async () => {
    await casoSintetico(entorno, "sol-001", "sol-malo", { "solicitud.json": "{ esto no es json" })
    expect((await llamar(entorno, "oc_leer_paquete", { caso: "sol-malo" })).error).toContain("no es un JSON válido")
  })
  it("monto no numérico", async () => {
    const s = JSON.parse(await readFile(path.join(entorno.directory, "fixtures/reto-03/solicitudes/sol-001/solicitud.json"), "utf8"))
    s.valor_total = "once millones"
    await casoSintetico(entorno, "sol-001", "sol-monto", { "solicitud.json": JSON.stringify(s) })
    expect((await llamar(entorno, "oc_leer_paquete", { caso: "sol-monto" })).error).toContain("valor_total")
  })
  it("L3 adjunto ausente se reporta como null y en faltantes", async () => {
    await casoSintetico(entorno, "sol-001", "sol-sincot", { "cotizacion.txt": null })
    const r = await llamar(entorno, "oc_leer_paquete", { caso: "sol-sincot" })
    expect(r.data).toMatchObject({ cotizacion: null, faltantes: ["cotizacion"] })
    const sinAprob = await (async () => {
      await casoSintetico(entorno, "sol-001", "sol-sinaprob", { "aprobacion.json": null })
      return llamar(entorno, "oc_generar_evidencia", { caso: "sol-sinaprob" })
    })()
    expect(sinAprob.ok).toBe(false)
  })
  it("T3 cada llamada queda en out/log.jsonl", async () => {
    await procesar(entorno, "sol-001")
    const lineas = (await readFile(path.join(entorno.directory, "out/log.jsonl"), "utf8")).trim().split("\n")
    expect(lineas.map((l) => JSON.parse(l).herramienta)).toEqual(["oc_leer_paquete", "oc_validar", "oc_construir_payload", "oc_crear"])
  })
})
