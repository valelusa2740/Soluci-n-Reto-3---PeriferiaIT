/**
 * Interfaz propia del proveedor LLM (PRD 6.1). El ciclo del agente solo conoce estos tipos;
 * cambiar de proveedor = escribir otra implementación de LlmAdapter, sin tocar el ciclo.
 */
export type Bloque =
  | { tipo: "texto"; texto: string }
  | { tipo: "llamada"; id: string; nombre: string; args: unknown; firma?: string }
  | { tipo: "resultado"; id: string; contenido: string; error: boolean }

// `firma`: dato opaco que algunos proveedores (Gemini) exigen devolver tal cual en la siguiente petición.
export type Mensaje = { rol: "usuario" | "asistente"; bloques: Bloque[] }

export type DefinicionHerramienta = { nombre: string; descripcion: string; esquema: Record<string, unknown> }

export type RespuestaLlm = {
  bloques: Bloque[]
  uso: { entrada: number; salida: number }
}

export type OpcionesLlm = { system: string; timeoutMs: number; maxTokens: number }

export interface LlmAdapter {
  readonly proveedor: string
  readonly modelo: string
  enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[], opciones: OpcionesLlm): Promise<RespuestaLlm>
}

/** Errores del proveedor traducidos a lenguaje claro (CA5). */
export class ErrorLlm extends Error {
  constructor(
    mensaje: string,
    readonly tipo: "timeout" | "autenticacion" | "limite" | "saturado" | "proveedor",
  ) {
    super(mensaje)
  }
}
