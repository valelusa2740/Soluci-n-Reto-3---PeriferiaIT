// Bonus 9.4: modulo/ usa las mismas piezas que la app (no copias divergentes).
import { readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"
import * as modulo from "../modulo/tools/oc.js"
import * as app from "../src/tools/oc.js"
import { contenidoModulo } from "../scripts/modulo.js"

const raiz = path.resolve(import.meta.dirname, "..")

describe("modulo/ reutilizable", () => {
  it("las herramientas son los mismos objetos que usa la app", () => {
    for (const k of ["leer_paquete", "validar", "construir_payload", "generar_evidencia", "crear"] as const) expect(modulo[k]).toBe(app[k])
  })
  it("agent.md y SKILL.md están sincronizados con agent/prompt.md y src/knowledge (npm run modulo)", async () => {
    const esperado = await contenidoModulo(raiz)
    expect(await readFile(path.join(raiz, "modulo/agent.md"), "utf8")).toBe(esperado.agent)
    expect(await readFile(path.join(raiz, "modulo/skill/ordenes-compra/SKILL.md"), "utf8")).toBe(esperado.skill)
  })
})
