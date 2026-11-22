import type { LlmAdapter } from "./adapter.js"
import { GeminiAdapter } from "./gemini.js"
import { LocalAdapter } from "./local.js"

export const MODELO_GEMINI_POR_DEFECTO = "gemini-3.8-flash"

/**
 * Elige el proveedor por variables de entorno. Es el único lugar que conoce las implementaciones.
 * LLM_PROVIDER=gemini (requiere GEMINI_API_KEY) | local (sin modelo, determinista).
 */
export function crearLlm(env: NodeJS.ProcessEnv = process.env): LlmAdapter {
  const proveedor = env.LLM_PROVIDER ?? (env.GEMINI_API_KEY ? "gemini" : "local")
  if (proveedor === "gemini") {
    if (!env.GEMINI_API_KEY) throw new Error("LLM_PROVIDER=gemini requiere GEMINI_API_KEY en el entorno.")
    return new GeminiAdapter(env.GEMINI_MODEL || MODELO_GEMINI_POR_DEFECTO, env.GEMINI_API_KEY)
  }
  if (proveedor === "local") return new LocalAdapter()
  throw new Error(`LLM_PROVIDER desconocido: ${proveedor} (usa gemini o local).`)
}
