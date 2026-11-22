import { cp, mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Ctx } from "../src/core/rutas.js"

const RAIZ = path.resolve(import.meta.dirname, "..")

/** Copia los fixtures a un directorio temporal: cada prueba tiene su propio out/ (aislamiento). */
export async function crearEntorno(): Promise<Ctx & { limpiar: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "oc-test-"))
  await cp(path.join(RAIZ, "fixtures"), path.join(dir, "fixtures"), { recursive: true })
  return { directory: dir, sessionId: "test", limpiar: () => rm(dir, { recursive: true, force: true }) }
}

/** Crea un caso sintético copiando uno real y sobrescribiendo archivos. */
export async function casoSintetico(ctx: Ctx, base: string, nuevo: string, archivos: Record<string, string | null>) {
  const dirBase = path.join(ctx.directory, "fixtures/reto-03/solicitudes", base)
  const dir = path.join(ctx.directory, "fixtures/reto-03/solicitudes", nuevo)
  await cp(dirBase, dir, { recursive: true })
  for (const [nombre, contenido] of Object.entries(archivos)) {
    if (contenido === null) await rm(path.join(dir, nombre), { force: true })
    else await writeFile(path.join(dir, nombre), contenido, "utf8")
  }
}

export const parse = <T = Record<string, unknown>>(s: string) => JSON.parse(s) as { ok: boolean; data: T; error: string }
