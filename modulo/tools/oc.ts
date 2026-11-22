/**
 * Herramientas del agente para integrarlas en otra plataforma, sin el servidor HTTP.
 * Reexporta exactamente las mismas que usa la app (src/tools/oc.ts): no hay copia divergente.
 * Cada export: { description, args (zod), execute(args, ctx) → string JSON }. Nombre: oc_<export>.
 */
export { leer_paquete, validar, construir_payload, generar_evidencia, crear, procesar } from "../../src/tools/oc.js"
export type { Ctx } from "../../src/tools/oc.js"
