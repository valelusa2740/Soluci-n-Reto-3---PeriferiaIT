# SPEC — Agente "Órdenes de Compra SAP" (Reto 03)

Especificación de la que salen las pruebas (`tests/`) y el código. Fuente: `docs/PRD.md` v2.0.
Cada criterio tiene un identificador que aparece en el nombre de su prueba.

## 1. Alcance

Agente conversacional en TypeScript (Node 20+ / Bun) que lee el paquete de una solicitud de compra,
lo valida contra los maestros (RC1–RC10), construye el payload de la OC, genera la evidencia de
aprobación y crea la OC en un SAP simulado. Las excepciones se devuelven a la persona: los
**bloqueos** impiden crear; las **confirmaciones** solo permiten crear con confirmación humana
validada por el servidor.

## 2. Contrato de herramientas (`src/tools/oc.ts`)

Cada export es `{ description, args, execute(args, ctx) }`; `args` es un objeto plano de esquemas
zod con `.describe()`; `execute` devuelve **string** JSON `{ok:true,data}` | `{ok:false,error}` y
nunca lanza. El modelo las ve como `oc_<export>`. `ctx = { directory, sessionId, confirmacionHumana? }`.

| Herramienta | Entrada | `data` |
|---|---|---|
| `oc_leer_paquete` | `{caso}` | Paquete 7.2 + `faltantes[]` |
| `oc_validar` | `{caso, paquete}` | `{apta, bloqueos[], confirmaciones[], derivados, retroactiva}` |
| `oc_construir_payload` | `{caso, paquete, derivados}` | `{orden, trazabilidad, ruta_trazabilidad}` |
| `oc_generar_evidencia` | `{caso}` | `{ruta, sha256}` |
| `oc_crear` | `{caso, payload, confirmado?}` | `{numero_oc, fecha, idempotente, retroactiva}` |

- **T1** `caso` solo acepta `^sol-[a-z0-9-]+$` (evita salir de `fixtures/`).
- **T2** Argumentos inválidos → `{ok:false}` con el error de zod, sin ejecutar.
- **T3** Toda llamada (de la app o de `demo.ts`) queda en `out/log.jsonl`.

## 3. Lectura (HU-1)

- **L1** NIT de la cotización se normaliza: `"900.555.111-2"` → `"900555111"` (sin puntos ni DV).
- **L2** Montos de texto (`COP 11.400.000`) → número. Monto no numérico en la solicitud → `{ok:false}` legible.
- **L3** Adjunto ausente (cotización, aprobación, factura) → `null` y su nombre en `faltantes`. Sin `solicitud.json` o JSON malformado → `{ok:false}`.
- **L4** `aprobado = true` si el cuerpo contiene la palabra "Aprobado" y no "No aprobado"/"rechazado".

## 4. Matriz de controles (7.3)

| # | Regla | Tipo | Implementación | Prueba positiva | Prueba negativa |
|---|---|---|---|---|---|
| RC1 | Proveedor existe (por NIT; sin NIT, por nombre normalizado) y activo | Bloqueo | `reglas.ts › rc1Proveedor` | sol-001, sol-006 (por nombre) | sol-002 (no existe), proveedor inactivo (sintético) |
| RC2 | Aprobación existe, dice "Aprobado" y la envía un aprobador **del centro** | Bloqueo | `rc2Aprobacion` | sol-001 | sol-003 (fvargas no aprueba CC-2020), sin aprobación, "No aprobado" |
| RC3 | `valor_total` ≤ tope del aprobador **en ese centro** | Bloqueo | `rc3Tope` | sol-004 (25M ≤ 200M) | sol-003 (fvargas no tiene tope en CC-2020; su tope de 80M es de CC-3030 y no aplica), monto > tope (sintético) |
| RC4 | Subárea pertenece al centro | Bloqueo | `rc4Subarea` | todos los casos | subárea de otro centro (sintético) |
| RC5 | Desvío cotización vs solicitud ≤ 2 %; si excede o no hay cotización | Confirmación | `rc5Cotizacion` | sol-001 (0 %) | sol-004 (6 %: 25.000.000 vs 26.500.000), sin cotización |
| RC6 | `indicador_iva` ausente → derivar del proveedor | Confirmación + derivado | `rc6Iva` | sol-001 (C1 informado) | sol-006 (deriva C1) |
| RC7 | `condiciones_pago` ausente → derivar del proveedor | Derivado (informa) | `rc7Pago` | sol-001 | sol-006 (deriva Z030, sin confirmación) |
| RC8 | Factura con fecha < `fecha_solicitud` → `retroactiva=true` | Confirmación + control | `rc8Retroactiva` | sol-001 (sin factura) | sol-005 (FC-88231 2026-08-10 < 2026-08-27) |
| RC9 | Fecha de aprobación ≥ `fecha_solicitud` (por día, hora local del correo) | Confirmación | `rc9FechaAprobacion` | sol-004 (26-ago 18:45 -05:00 = mismo día) | aprobación anterior (sintético) |
| RC10 | `cantidad × valor_unitario = valor_total` (±1) | Bloqueo | `rc10Aritmetica` | todos los casos | 100 × 250.000 ≠ 26.000.000 (sintético) |

- **V1** `apta = (bloqueos.length === 0)`. Las confirmaciones no cambian `apta`.
- **V2** Cada caso se valida solo con sus archivos y los maestros: ningún estado de un caso afecta a otro (prueba de aislamiento: validar en cualquier orden da lo mismo).
- **V3** Cada bloqueo trae `regla`, `detalle` y `accion_sugerida`. Cada confirmación trae `regla`, `detalle` y, en RC5, ambos valores.
- **V4** Si el paquete recibido del modelo difiere del que está en disco → bloqueo `INTEGRIDAD` (el modelo no puede "arreglar" montos).

## 5. Resultado esperado por caso (oráculo de `demo.ts` y de `tests/casos.test.ts`)

| Caso | apta | Bloqueos | Confirmaciones | Derivados | retroactiva | Resultado de `oc_crear` |
|---|---|---|---|---|---|---|
| sol-001 | sí | — | — | — | no | OC 4500000001; 2.ª vez idempotente (mismo número) |
| sol-002 | no | RC1 | — | — | no | Rechazada (bloqueo) |
| sol-003 | no | RC2, RC3 | — | — | no | Rechazada (bloqueo) |
| sol-004 | sí | — | RC5 | — | no | Sin confirmación: pendiente. Con confirmación: OC |
| sol-005 | sí | — | RC8 | — | **sí** | Solo con confirmación; `retroactiva=true` en `control.csv` |
| sol-006 | sí | — | RC6 | IVA C1, pago Z030 | no | Solo con confirmación |

## 6. Payload (HU-3) y evidencia (HU-4)

- **P1** El payload valida contra `OrdenCompraSchema` (zod, 7.4).
- **P2** `posiciones[0].descripcion` ≤ 40 caracteres (se recorta la de la solicitud).
- **P3** Cada valor tiene fuente: `solicitud`, `cotizacion`, `aprobacion`, `maestro.<nombre>`, `derivado` o `constante`; se guarda en `out/<caso>/trazabilidad.json`.
- **P4** `excepciones[]` = confirmaciones del caso, con `confirmado_por = null` hasta que la persona confirma.
- **E1** `out/<caso>/aprobacion.txt` con de, para, fecha, asunto, cuerpo; `sha256` del contenido; el mismo hash va en `aprobador.evidencia_sha256`.

## 7. Creación (HU-5) y confirmación humana (CA3)

- **C1** `oc_crear` revalida desde los archivos (no confía en lo que le pase el modelo) y reconstruye el payload; si el payload recibido difiere → `{ok:false}`.
- **C2** Con bloqueos → `{ok:false}` y fila `bloqueada` en `control.csv`.
- **C3** Con confirmaciones y sin confirmación humana válida → `{ok:false, error:"requiere confirmación"}` y fila `pendiente_confirmacion`.
- **C4** Confirmación humana válida = `confirmado:true` **y** el servidor (`ctx.confirmacionHumana(caso)`) certifica que el mensaje inmediatamente siguiente de la persona confirmó ese caso (texto "confirmo"/"sí, créala" o botón). El modelo no puede confirmar solo.
- **C5** SAP mock: números desde `4500000001`, `out/sap/ordenes.jsonl`, idempotente por `solicitud_id` (fila `idempotente`).
- **C6** `control.csv`: `solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts`, una fila por intento.

## 8. Ciclo del agente y API

- **A1** Tope de 25 iteraciones modelo→herramientas por turno (`MAX_ITERACIONES`); al alcanzarlo responde con lo que tiene.
- **A2** Tope de tokens por sesión (`MAX_TOKENS_SESION`) y global diario (`MAX_TOKENS_DIA`); al superarlo, mensaje claro y sin llamar al modelo.
- **A3** Timeout al proveedor LLM (`LLM_TIMEOUT_MS`) con mensaje claro; la sesión sigue viva.
- **A4** Error de herramienta o de LLM → texto claro en el chat; la sesión no muere.
- **A5** `POST /api/chat {sessionId,message}` → `{reply, toolCalls[], needsConfirmation, pendiente}`; `GET /api/sessions/:id`; `GET /api/health` → `{ok, provider, model}` sin claves.
- **A6** El adaptador LLM es una interfaz propia (`enviar(mensajes, herramientas)`); el ciclo no importa ningún SDK.
- **A7** Límite de peticiones por IP y tamaño de mensaje; la clave del modelo nunca sale del backend.
