/**
 * Genera modulo/ (bonus 9.4) desde las MISMAS fuentes que usa la app: agent/prompt.md y
 * src/knowledge/ordenes-compra.md. modulo/tools/oc.ts reexporta src/tools/oc.ts (no es copia).
 * tests/modulo.test.ts falla si modulo/ diverge de las fuentes.
 */
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const raiz = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")

export async function contenidoModulo(dir = raiz) {
  const [prompt, conocimiento] = await Promise.all([
    readFile(path.join(dir, "agent/prompt.md"), "utf8"),
    readFile(path.join(dir, "src/knowledge/ordenes-compra.md"), "utf8"),
  ])
  const agent = `---
description: Agente que lee, valida (RC1–RC10) y crea órdenes de compra en SAP con confirmación humana.
mode: primary
permission:
  edit: deny
  bash: deny
---

${prompt}`
  const skill = `---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra de Periferia (paquete, maestros, reglas RC1–RC10, OC retroactivas y salidas de control).
---

${conocimiento}`
  return { agent, skill }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const { agent, skill } = await contenidoModulo()
  await writeFile(path.join(raiz, "modulo/agent.md"), agent)
  await writeFile(path.join(raiz, "modulo/skill/ordenes-compra/SKILL.md"), skill)
  console.log("modulo/ regenerado desde agent/prompt.md y src/knowledge/ordenes-compra.md")
}
