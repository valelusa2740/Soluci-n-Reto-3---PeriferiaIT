import type { LlmAdapter } from "./adapter.js"
import { AnthropicAdapter } from "./anthropic.js"
import { LocalAdapter } from "./local.js"

/**
 * Elige el proveedor por variables de entorno. Es el único lugar que conoce las implementaciones.
 * LLM_PROVIDER=anthropic (requiere ANTHROPIC_API_KEY) | local (sin modelo, determinista).
 */
export function crearLlm(env: NodeJS.ProcessEnv = process.env): LlmAdapter {
  const proveedor = env.LLM_PROVIDER ?? (env.ANTHROPIC_API_KEY ? "anthropic" : "local")
  if (proveedor === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) throw new Error("LLM_PROVIDER=anthropic requiere ANTHROPIC_API_KEY en el entorno.")
    return new AnthropicAdapter(env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5", env.ANTHROPIC_API_KEY)
  }
  return new LocalAdapter()
}
