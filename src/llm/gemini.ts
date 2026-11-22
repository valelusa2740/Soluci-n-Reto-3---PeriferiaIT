/**
 * Implementación de LlmAdapter para Google Gemini (Google AI Studio) con function calling, vía REST
 * (sin SDK). La clave se lee de GEMINI_API_KEY solo en el backend y viaja en una cabecera, nunca en la URL.
 */
import { type Bloque, type DefinicionHerramienta, ErrorLlm, type LlmAdapter, type Mensaje, type OpcionesLlm, type RespuestaLlm } from "./adapter.js"

const BASE = "https://generativelanguage.googleapis.com/v1beta/models"

type ParteGemini = {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> }
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> }
}
type ContenidoGemini = { role: "user" | "model"; parts: ParteGemini[] }
type RespuestaGemini = {
  candidates?: { content?: { parts?: ParteGemini[] }; finishReason?: string }[]
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }
  error?: { code?: number; message?: string; status?: string }
}

export class GeminiAdapter implements LlmAdapter {
  readonly proveedor = "gemini"
  private contador = 0

  constructor(
    readonly modelo: string,
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
    /** Espera antes del único reintento tras un 429 (el plan gratuito limita peticiones por minuto). */
    private readonly esperaReintentoMs = 4000,
  ) {}

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[], o: OpcionesLlm): Promise<RespuestaLlm> {
    const cuerpo = {
      systemInstruction: { parts: [{ text: o.system }] },
      contents: aGemini(mensajes),
      tools: [{ functionDeclarations: herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, parametersJsonSchema: sinMeta(h.esquema) })) }],
      generationConfig: { maxOutputTokens: o.maxTokens, temperature: 0 },
    }
    let res = await this.pedir(cuerpo, o.timeoutMs)
    if (res.status === 429 && this.esperaReintentoMs > 0) {
      await new Promise((r) => setTimeout(r, this.esperaReintentoMs))
      res = await this.pedir(cuerpo, o.timeoutMs)
    }
    if (!res.ok) throw errorHttp(res.status)
    const json = (await res.json()) as RespuestaGemini
    const candidato = json.candidates?.[0]
    const partes = candidato?.content?.parts ?? []
    if (partes.length === 0) {
      throw new ErrorLlm(`El modelo no devolvió respuesta (motivo: ${candidato?.finishReason ?? "desconocido"}). Reformula tu mensaje.`, "proveedor")
    }
    const u = json.usageMetadata
    return {
      bloques: partes.flatMap((p) => this.deGemini(p)),
      uso: { entrada: u?.promptTokenCount ?? 0, salida: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0) },
    }
  }

  private async pedir(cuerpo: unknown, timeoutMs: number): Promise<Response> {
    try {
      return await this.fetcher(`${BASE}/${encodeURIComponent(this.modelo)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new ErrorLlm("El modelo tardó demasiado en responder (timeout). Intenta de nuevo.", "timeout")
      }
      throw new ErrorLlm("No se pudo contactar al proveedor del modelo (Gemini). Intenta de nuevo.", "proveedor")
    }
  }

  private deGemini(p: ParteGemini): Bloque[] {
    if (p.functionCall) {
      const id = p.functionCall.id ?? `g-${++this.contador}`
      return [{ tipo: "llamada", id, nombre: p.functionCall.name, args: p.functionCall.args ?? {}, firma: p.thoughtSignature }]
    }
    if (p.text && !p.thought) return [{ tipo: "texto", texto: p.text }]
    return []
  }
}

function errorHttp(status: number): ErrorLlm {
  if (status === 429) return new ErrorLlm("Se alcanzó el límite gratuito del modelo (Gemini, error 429). Espera un minuto y vuelve a intentarlo; tu sesión sigue activa.", "limite")
  if (status === 401 || status === 403) return new ErrorLlm("El servidor no tiene una clave válida del modelo. Avísale al administrador.", "autenticacion")
  if (status === 404) return new ErrorLlm("El modelo configurado (GEMINI_MODEL) no existe o no está disponible.", "proveedor")
  return new ErrorLlm(`El proveedor del modelo respondió con error (${status}). Intenta de nuevo.`, "proveedor")
}

function sinMeta(esquema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _s, ...resto } = esquema
  return resto
}

/** Convierte el historial neutro al formato de Gemini. functionResponse necesita el nombre de la llamada. */
export function aGemini(mensajes: Mensaje[]): ContenidoGemini[] {
  const nombres = new Map<string, string>()
  return mensajes.map((m) => ({
    role: m.rol === "usuario" ? "user" : "model",
    parts: m.bloques.map((b): ParteGemini => {
      if (b.tipo === "texto") return { text: b.texto }
      if (b.tipo === "llamada") {
        nombres.set(b.id, b.nombre)
        const parte: ParteGemini = { functionCall: { name: b.nombre, args: (b.args ?? {}) as Record<string, unknown> } }
        if (!b.id.startsWith("g-")) parte.functionCall = { ...parte.functionCall!, id: b.id }
        if (b.firma) parte.thoughtSignature = b.firma
        return parte
      }
      const response = parsearObjeto(b.contenido)
      const fr: ParteGemini["functionResponse"] = { name: nombres.get(b.id) ?? "desconocida", response }
      if (!b.id.startsWith("g-")) fr.id = b.id
      return { functionResponse: fr }
    }),
  }))
}

function parsearObjeto(texto: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(texto)
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { resultado: v }
  } catch {
    return { resultado: texto }
  }
}
