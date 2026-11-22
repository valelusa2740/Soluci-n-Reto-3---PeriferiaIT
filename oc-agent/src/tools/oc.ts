import { z } from "zod";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Herramientas del agente (Reto 3). Cada herramienta tiene un esquema zod (entrada validada)
 * y devuelve un resultado estructurado. La lógica de negocio vive AQUÍ (código determinista),
 * no en el prompt: el modelo solo decide qué herramienta llamar.
 *
 * TODO(SPEC): completar `validar_controles` con las reglas del PRD una vez recibido el ZIP.
 */

export const FIXTURES_DIR = process.env.FIXTURES_DIR ?? path.resolve("fixtures/reto-03");

export type Decision = "APROBAR" | "CONFIRMAR" | "RECHAZAR";

export interface ControlResult {
  control: string; // p. ej. "C1-proveedor-activo"
  passed: boolean;
  detail: string;
}

export interface Validation {
  decision: Decision;
  controls: ControlResult[];
  reason: string;
}

export interface OrdenCompra {
  numero: string;
  caso_id: string;
  creada: string;
  datos: unknown;
}

/** Estado POR SESIÓN/CASO. Se crea uno nuevo por cada caso => no se cruza información entre casos. */
export interface Ctx {
  validated: Map<string, Validation>;
  confirmed: Set<string>; // lo escribe SOLO el servidor cuando el humano aprueba (nunca el modelo)
  pending: { caso_id: string; motivo: string } | null;
  orders: Map<string, OrdenCompra>; // "SAP simulado"
}

export function createCtx(): Ctx {
  return { validated: new Map(), confirmed: new Set(), pending: null, orders: new Map() };
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  requiresConfirmation?: boolean;
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run: (input: z.infer<S>, ctx: Ctx) => Promise<ToolResult>;
}

const casoId = z.string().regex(/^sol-\d{3}$/, "caso_id debe tener el formato sol-001");

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

export async function listarCasos(): Promise<string[]> {
  try {
    const dir = path.join(FIXTURES_DIR, "solicitudes");
    return (await readdir(dir)).filter((d) => /^sol-\d{3}$/.test(d)).sort();
  } catch {
    return [];
  }
}

const leerCasoSchema = z.object({ caso_id: casoId });
export const leerCaso: ToolDef<typeof leerCasoSchema> = {
  name: "leer_caso",
  description:
    "Lee los documentos de una solicitud de compra (correo, solicitud, cotización, aprobación y factura si existe). No modifica nada.",
  schema: leerCasoSchema,
  run: async ({ caso_id }) => {
    const dir = path.join(FIXTURES_DIR, "solicitudes", caso_id);
    const files = ["correo.json", "solicitud.json", "cotizacion.txt", "aprobacion.json", "factura.txt"];
    const out: Record<string, unknown> = {};
    for (const f of files) {
      const content = await readIfExists(path.join(dir, f));
      if (content === null) continue;
      out[f] = f.endsWith(".json") ? JSON.parse(content) : content;
    }
    if (Object.keys(out).length === 0) return { ok: false, error: `No existe el caso ${caso_id}` };
    return { ok: true, data: out };
  },
};

const validarSchema = z.object({ caso_id: casoId });
export const validarControles: ToolDef<typeof validarSchema> = {
  name: "validar_controles",
  description:
    "Ejecuta la matriz de controles sobre el caso (proveedor, centro de costo, tope de aprobación, IVA, condición de pago, retroactividad) y devuelve la decisión: APROBAR, CONFIRMAR (requiere humano) o RECHAZAR.",
  schema: validarSchema,
  run: async ({ caso_id }, ctx) => {
    // TODO(SPEC): implementar cada control según docs/PRD.md y SPEC.md. Cada control = función pura y testeable.
    const v: Validation = {
      decision: "RECHAZAR",
      controls: [{ control: "C0-no-implementado", passed: false, detail: "Matriz de controles pendiente de implementar" }],
      reason: "NOT_IMPLEMENTED",
    };
    ctx.validated.set(caso_id, v);
    return { ok: true, data: v };
  },
};

const confSchema = z.object({ caso_id: casoId, motivo: z.string().min(5).max(500) });
export const solicitarConfirmacionHumana: ToolDef<typeof confSchema> = {
  name: "solicitar_confirmacion_humana",
  description:
    "Pide la aprobación de un humano cuando la validación resulta en CONFIRMAR. El agente debe detenerse y esperar; no puede aprobar por sí mismo.",
  schema: confSchema,
  run: async ({ caso_id, motivo }, ctx) => {
    ctx.pending = { caso_id, motivo };
    return { ok: true, requiresConfirmation: true, data: { caso_id, motivo, estado: "ESPERANDO_HUMANO" } };
  },
};

const crearSchema = z.object({ caso_id: casoId });
export const crearOrdenCompra: ToolDef<typeof crearSchema> = {
  name: "crear_orden_compra",
  description:
    "Crea la orden de compra en el SAP simulado. Solo funciona si la validación fue APROBAR, o CONFIRMAR con aprobación humana registrada. Nunca crea órdenes para casos RECHAZADOS.",
  schema: crearSchema,
  run: async ({ caso_id }, ctx) => {
    const v = ctx.validated.get(caso_id);
    if (!v) return { ok: false, error: "Primero ejecuta validar_controles para este caso" };
    if (v.decision === "RECHAZAR") return { ok: false, error: "Caso rechazado por los controles: no se crea la orden" };
    if (v.decision === "CONFIRMAR" && !ctx.confirmed.has(caso_id))
      return { ok: false, error: "Falta confirmación humana para este caso" };
    if (ctx.orders.has(caso_id)) return { ok: false, error: "Ya existe una orden para este caso (idempotencia)" };
    const orden: OrdenCompra = {
      numero: `4500${String(ctx.orders.size + 1).padStart(6, "0")}`,
      caso_id,
      creada: new Date().toISOString(),
      datos: v,
    };
    ctx.orders.set(caso_id, orden);
    return { ok: true, data: orden };
  },
};

export const TOOLS: ToolDef[] = [leerCaso, validarControles, solicitarConfirmacionHumana, crearOrdenCompra] as ToolDef[];

export function toolSpecs() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: z.toJSONSchema(t.schema) as Record<string, unknown>,
  }));
}

/** Punto único de ejecución: valida la entrada con zod antes de correr la herramienta. */
export async function runTool(name: string, rawInput: unknown, ctx: Ctx): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, error: `Herramienta desconocida: ${name}` };
  const parsed = tool.schema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, error: `Entrada inválida: ${parsed.error.message}` };
  try {
    return await tool.run(parsed.data, ctx);
  } catch (e) {
    return { ok: false, error: `Error interno: ${(e as Error).message}` };
  }
}
