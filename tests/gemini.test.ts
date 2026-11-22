// Adaptador Gemini con fetch falso: function calling, firma, 429 y timeout (sin red ni clave real).
import { describe, expect, it } from "vitest"
import { ErrorLlm, type Mensaje } from "../src/llm/adapter.js"
import { aGemini, GeminiAdapter } from "../src/llm/gemini.js"

const opciones = { system: "s", timeoutMs: 1000, maxTokens: 100 }
const herramientas = [{ nombre: "oc_leer_paquete", descripcion: "lee", esquema: { $schema: "x", type: "object", properties: {} } }]
const respuesta = (status: number, cuerpo: unknown) => (async () => new Response(JSON.stringify(cuerpo), { status })) as unknown as typeof fetch

describe("GeminiAdapter", () => {
  it("convierte functionCall en llamada y conserva la firma; la clave va en cabecera, no en la URL", async () => {
    let url = "", headers: HeadersInit | undefined, body = ""
    const fetcher = (async (u: string, init: RequestInit) => {
      url = u; headers = init.headers; body = String(init.body)
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "oc_leer_paquete", args: { caso: "sol-001" } }, thoughtSignature: "firma1" }] } }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5 } }), { status: 200 })
    }) as unknown as typeof fetch
    const r = await new GeminiAdapter("gemini-x", "CLAVE-SECRETA", fetcher).enviar([{ rol: "usuario", bloques: [{ tipo: "texto", texto: "hola" }] }], herramientas, opciones)
    expect(r.bloques[0]).toMatchObject({ tipo: "llamada", nombre: "oc_leer_paquete", args: { caso: "sol-001" }, firma: "firma1" })
    expect(r.uso).toEqual({ entrada: 50, salida: 5 })
    expect(url).not.toContain("CLAVE-SECRETA")
    expect((headers as Record<string, string>)["x-goog-api-key"]).toBe("CLAVE-SECRETA")
    expect(JSON.parse(body).tools[0].functionDeclarations[0].parametersJsonSchema.$schema).toBeUndefined()
  })
  it("429 → mensaje claro de límite", async () => {
    const p = new GeminiAdapter("m", "k", respuesta(429, { error: { code: 429 } }), [1]).enviar([], herramientas, opciones)
    await expect(p).rejects.toBeInstanceOf(ErrorLlm)
    await expect(p).rejects.toMatchObject({ tipo: "limite", message: expect.stringContaining("límite gratuito") })
  })
  it("timeout → ErrorLlm timeout", async () => {
    const lento = (async (_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("t"), { name: "TimeoutError" }))))) as unknown as typeof fetch
    await expect(new GeminiAdapter("m", "k", lento, []).enviar([], herramientas, { ...opciones, timeoutMs: 20 })).rejects.toMatchObject({ tipo: "timeout" })
  })
  it("functionResponse lleva el nombre de la llamada y devuelve la firma", () => {
    const m: Mensaje[] = [
      { rol: "asistente", bloques: [{ tipo: "llamada", id: "g-1", nombre: "oc_validar", args: { caso: "sol-001" }, firma: "f" }] },
      { rol: "usuario", bloques: [{ tipo: "resultado", id: "g-1", contenido: '{"ok":true,"data":{}}', error: false }] },
    ]
    const g = aGemini(m)
    expect(g[0]).toEqual({ role: "model", parts: [{ functionCall: { name: "oc_validar", args: { caso: "sol-001" } }, thoughtSignature: "f" }] })
    expect(g[1].parts[0].functionResponse).toEqual({ name: "oc_validar", response: { ok: true, data: {} } })
  })

  it("503 transitorio: reintenta con el mismo modelo y responde sin error", async () => {
    const estados = [503, 503, 200]
    const urls: string[] = []
    const fetcher = (async (u: string) => {
      urls.push(u)
      const s = estados.shift() ?? 200
      return new Response(JSON.stringify(s === 200 ? { candidates: [{ content: { parts: [{ text: "ok" }] } }] } : { error: { code: s } }), { status: s })
    }) as unknown as typeof fetch
    const r = await new GeminiAdapter("principal", "k", fetcher, [1, 1], "respaldo").enviar([], herramientas, opciones)
    expect(r.bloques).toEqual([{ tipo: "texto", texto: "ok" }])
    expect(urls.every((u) => u.includes("/principal:"))).toBe(true)
    expect(urls).toHaveLength(3)
  })
  it("si el principal sigue saturado, cae al modelo de respaldo", async () => {
    const urls: string[] = []
    const fetcher = (async (u: string) => {
      urls.push(u)
      return u.includes("/principal:") ? new Response("{}", { status: 503 }) : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "desde respaldo" }] } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const r = await new GeminiAdapter("principal", "k", fetcher, [1, 1], "respaldo").enviar([], herramientas, opciones)
    expect(r.bloques).toEqual([{ tipo: "texto", texto: "desde respaldo" }])
    expect(urls.filter((u) => u.includes("/principal:"))).toHaveLength(3)
    expect(urls.filter((u) => u.includes("/respaldo:"))).toHaveLength(1)
  })
  it("si ambos fallan: mensaje claro de saturación", async () => {
    const p = new GeminiAdapter("principal", "k", respuesta(503, {}), [1], "respaldo").enviar([], herramientas, opciones)
    await expect(p).rejects.toMatchObject({ tipo: "saturado", message: expect.stringContaining("saturado") })
  })
  it("errores no transitorios (401) no se reintentan", async () => {
    let n = 0
    const fetcher = (async () => { n++; return new Response("{}", { status: 401 }) }) as unknown as typeof fetch
    await expect(new GeminiAdapter("m", "k", fetcher, [1, 1], "r").enviar([], herramientas, opciones)).rejects.toMatchObject({ tipo: "autenticacion" })
    expect(n).toBe(1)
  })
})
