import path from "node:path"

/** Contexto que recibe toda herramienta (PRD 6.2). */
export type Ctx = {
  /** Raíz del proyecto; todas las rutas se resuelven desde aquí. */
  directory: string
  sessionId: string
  /**
   * La pone el servidor: devuelve true solo si el mensaje inmediatamente siguiente de la persona
   * confirmó este caso. Si el host no la provee (demo, módulo), cuenta solo `confirmado`.
   */
  confirmacionHumana?: (caso: string) => boolean
}

export const CASO_REGEX = /^sol-[a-z0-9-]{1,40}$/

export const rutas = (ctx: Ctx) => {
  const base = path.resolve(ctx.directory)
  const fixtures = path.join(base, "fixtures", "reto-03")
  const out = path.join(base, "out")
  return {
    fixtures,
    maestros: path.join(fixtures, "maestros"),
    caso: (caso: string) => path.join(fixtures, "solicitudes", caso),
    out,
    outCaso: (caso: string) => path.join(out, caso),
    sap: path.join(out, "sap"),
    control: path.join(out, "control.csv"),
    log: path.join(out, "log.jsonl"),
  }
}
