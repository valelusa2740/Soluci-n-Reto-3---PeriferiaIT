import { z } from "zod"

/** Solicitud (Excel normalizado, PRD 7.1). Los campos opcionales pueden faltar. */
export const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string(),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: z.number().finite(),
  valor_unitario: z.number().finite(),
  valor_total: z.number().finite(),
  moneda: z.enum(["COP", "USD"]),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha_solicitud debe ser AAAA-MM-DD"),
})
export type Solicitud = z.infer<typeof SolicitudSchema>

/** Paquete normalizado (PRD 7.2) + lista de adjuntos faltantes. */
export const PaqueteSchema = z.object({
  correo: z.object({ id: z.string(), de: z.string(), asunto: z.string(), fecha: z.string() }),
  solicitud: SolicitudSchema,
  cotizacion: z
    .object({
      referencia: z.string().nullable(),
      proveedor: z.string(),
      nit: z.string().nullable(),
      total: z.number(),
      moneda: z.string(),
      validez_hasta: z.string().nullable(),
      texto: z.string(),
    })
    .nullable(),
  aprobacion: z
    .object({
      de: z.string(),
      para: z.string(),
      fecha: z.string(),
      asunto: z.string(),
      aprobado: z.boolean(),
      texto: z.string(),
    })
    .nullable(),
  factura: z.object({ numero: z.string(), fecha: z.string(), total: z.number() }).nullable(),
  faltantes: z.array(z.string()),
})
export type Paquete = z.infer<typeof PaqueteSchema>

export type Hallazgo = {
  regla: string
  detalle: string
  accion_sugerida?: string
  valores?: Record<string, number | string>
}

export const DerivadosSchema = z.object({
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
})
export type Derivados = z.infer<typeof DerivadosSchema>

export type Validacion = {
  apta: boolean
  bloqueos: Hallazgo[]
  confirmaciones: Hallazgo[]
  derivados: Derivados
  retroactiva: boolean
  proveedor: { codigo_sap: string; nit: string; nombre: string } | null
}

/** Payload de la OC (PRD 7.4). */
export const OrdenCompraSchema = z.object({
  referencia: z.object({
    solicitud_id: z.string(),
    correo_id: z.string(),
    cotizacion_ref: z.string().nullable(),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string() }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string().min(1),
  aprobador: z.object({
    email: z.string(),
    fecha_aprobacion: z.string(),
    evidencia_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  posiciones: z
    .array(
      z.object({
        numero: z.number().int().positive(),
        descripcion: z.string().min(1).max(40),
        cantidad: z.number().positive(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number().nonnegative(),
        centro_costo: z.string(),
        subarea: z.string(),
        indicador_iva: z.string(),
      }),
    )
    .min(1),
  excepciones: z.array(
    z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() }),
  ),
})
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>

export type Fuente = "solicitud" | "cotizacion" | "aprobacion" | "derivado" | "constante" | `maestro.${string}`
export type Trazabilidad = Record<string, { valor: string | number | null; fuente: Fuente; nota?: string }>

/** Resultado estándar de toda herramienta. */
export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string }
