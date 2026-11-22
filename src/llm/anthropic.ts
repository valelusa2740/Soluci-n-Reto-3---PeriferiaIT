import Anthropic from "@anthropic-ai/sdk"
import { type Bloque, type DefinicionHerramienta, ErrorLlm, type LlmAdapter, type Mensaje, type OpcionesLlm, type RespuestaLlm } from "./adapter.js"

/** Implementación de LlmAdapter para Anthropic. La clave se lee de ANTHROPIC_API_KEY (solo backend). */
export class AnthropicAdapter implements LlmAdapter {
  readonly proveedor = "anthropic"
  private readonly cliente: Anthropic

  constructor(
    readonly modelo: string,
    apiKey: string,
  ) {
    this.cliente = new Anthropic({ apiKey, maxRetries: 1 })
  }

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[], o: OpcionesLlm): Promise<RespuestaLlm> {
    try {
      const r = await this.cliente.messages.create(
        {
          model: this.modelo,
          max_tokens: o.maxTokens,
          system: o.system,
          tools: herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, input_schema: aEsquema(h.esquema) })),
          messages: mensajes.map(aAnthropic),
        },
        { timeout: o.timeoutMs },
      )
      return { bloques: r.content.flatMap(deAnthropic), uso: { entrada: r.usage.input_tokens, salida: r.usage.output_tokens } }
    } catch (e) {
      throw traducirError(e)
    }
  }
}

function aEsquema(esquema: Record<string, unknown>): Anthropic.Tool.InputSchema {
  const { $schema: _s, ...resto } = esquema
  return { ...resto, type: "object" }
}

function aAnthropic(m: Mensaje): Anthropic.MessageParam {
  const content = m.bloques.map((b): Anthropic.ContentBlockParam => {
    if (b.tipo === "texto") return { type: "text", text: b.texto }
    if (b.tipo === "llamada") return { type: "tool_use", id: b.id, name: b.nombre, input: b.args }
    return { type: "tool_result", tool_use_id: b.id, content: b.contenido, is_error: b.error }
  })
  return { role: m.rol === "usuario" ? "user" : "assistant", content }
}

function deAnthropic(b: Anthropic.ContentBlock): Bloque[] {
  if (b.type === "text") return [{ tipo: "texto", texto: b.text }]
  if (b.type === "tool_use") return [{ tipo: "llamada", id: b.id, nombre: b.name, args: b.input }]
  return []
}

function traducirError(e: unknown): ErrorLlm {
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ErrorLlm("El modelo tardó demasiado en responder (timeout). Intenta de nuevo.", "timeout")
  if (e instanceof Anthropic.AuthenticationError) return new ErrorLlm("El servidor no tiene una clave válida del modelo. Avísale al administrador.", "autenticacion")
  if (e instanceof Anthropic.RateLimitError) return new ErrorLlm("El proveedor del modelo está limitando peticiones. Espera un minuto e intenta de nuevo.", "limite")
  if (e instanceof Anthropic.APIError) return new ErrorLlm(`El proveedor del modelo respondió con error (${e.status ?? "sin estado"}). Intenta de nuevo.`, "proveedor")
  return new ErrorLlm("No se pudo contactar al proveedor del modelo. Intenta de nuevo.", "proveedor")
}
