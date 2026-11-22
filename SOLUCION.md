# SOLUCIÓN — Agente "Órdenes de Compra SAP" (Reto 03)

> **Link de prueba:** https://reto-03-oc-agent-w7pl.onrender.com/ · usuario `evaluador` · clave `Reto3PeriferiaIT` · Repositorio: https://github.com/valelusa2740/Soluci-n-Reto-3---PeriferiaIT

## 1. Problema en una frase y a quién le duele

La analista administrativa digita a mano cada orden de compra en SAP y valida de memoria si quien aprueba puede aprobar ese monto en ese centro de costo. Eso cuesta tiempo, deja pasar errores y no permite medir las OC que se crean después de la factura. Les duele a la analista (tiempo), a contabilidad y auditoría (control) y a la dirección (no tiene la medición).

## 2. Arquitectura

```
┌──────────────┐  POST /api/chat   ┌───────────────────────────────────────────────┐
│ web/index.html│ ───────────────▶ │ src/server.ts  (acceso Basic, límites, sesiones) │
│ chat, tool    │ ◀─────────────── │        │                                        │
│ calls, banner │  reply/toolCalls │        ▼                                        │
│ confirmación  │  needsConfirm.   │ src/agente/ciclo.ts  (ciclo, topes, CA3)        │
└──────────────┘                   │        │                 │                      │
                                   │        ▼                 ▼                      │
                                   │ src/llm/adapter.ts   src/tools/registro.ts     │
                                   │  ├ gemini.ts (REST)   (zod, oc_<export>, log)   │
                                   │  └ local.ts           src/tools/oc.ts           │
                                   │                        │  src/core/* (reglas,   │
                                   │                        │  paquete, payload)     │
                                   │                        ▼                        │
                                   │                  src/sap/mock.ts (SapAdapter)   │
                                   └──────────┬──────────────────────┬──────────────┘
                                   fixtures/ (solo lectura)     out/ (control.csv, log.jsonl,
                                                                sap/ordenes.jsonl, <caso>/…)
```

| Pieza | Dónde vive | Qué cambia si cambia |
|---|---|---|
| Comportamiento | `agent/prompt.md` | Cómo conversa y en qué orden llama herramientas |
| Conocimiento | `src/knowledge/ordenes-compra.md` | Lo que el agente sabe del proceso (se anexa al prompt) |
| Ejecución | `src/tools/oc.ts` + `src/core/` | Reglas de negocio; el servidor no se toca |
| Integración SAP | `src/sap/adapter.ts` (interfaz) y `mock.ts` | Cambiar a SAP real = otra implementación |
| Proveedor LLM | `src/llm/adapter.ts` + `gemini.ts` / `local.ts` | Cambiar de proveedor no toca el ciclo |

## 3. Ciclo del agente

`src/agente/ciclo.ts › ejecutarTurno`:

1. Revisa los topes de tokens de la sesión y del día. Si se superaron, responde sin llamar al modelo.
2. **Confirmación humana (CA3):** si la sesión tenía un caso pendiente y este mensaje lo confirma ("confirmo", "sí, créala" o el botón del chat), el servidor marca **solo ese caso** como confirmado **solo durante este turno**. Cualquier otro mensaje borra el pendiente. Al modelo se le agrega una nota del servidor indicando si hubo confirmación.
3. Envía historial, prompt y herramientas al adaptador LLM. Si el modelo pide herramientas, el registro valida los argumentos con zod, ejecuta, guarda la llamada en `out/log.jsonl` y devuelve el resultado al modelo. Repite hasta que el modelo responde con texto o se alcanza el **tope de 25 iteraciones** (CA1). En ese caso responde con lo que tiene.
4. Si `oc_validar` devuelve confirmaciones o `oc_crear` responde `REQUIERE_CONFIRMACION`, la sesión queda con un pendiente, la respuesta sale con `needsConfirmation=true` y el front muestra un banner naranja con los botones Confirmar / No.
5. **La confirmación no depende del modelo.** `oc_crear` crea solo si recibe `confirmado=true` **y** si `ctx.confirmacionHumana(caso)`, función que pone el servidor, devuelve true. Aunque el modelo "decida" confirmar, no puede crear la OC (lo prueba `tests/ciclo.test.ts`).
6. Errores (timeout, 429, clave inválida, error inesperado) → mensaje claro en el chat. El turno incompleto se descarta del historial y la sesión sigue (CA5).

## 4. Elección del modelo

- **Proveedor:** Google Gemini (Google AI Studio), plan gratuito. **Modelo:** configurable en `GEMINI_MODEL`, por defecto `gemini-3.5-flash-lite` (gratuito y el más rápido; en la prueba real `gemini-3.8-flash` fue demasiado lento para el turno) con `gemini-3.8-flash` como respaldo automático. Se pide el mínimo de *thinking* (`thinkingLevel: low`) para bajar la latencia.
- **Menos vueltas al modelo:** la herramienta compuesta `oc_procesar` encadena leer → validar → construir → evidencia en una sola llamada (las cinco herramientas obligatorias siguen expuestas por separado y quedan en el log). Un caso típico pasa de ~6 llamadas al modelo a 2–3.
- **Por qué:** el plan gratuito permite que los evaluadores prueben sin costo y el agente casi no necesita razonar. Las reglas están en código determinista; el modelo solo orquesta herramientas y redacta, y para eso basta un modelo *flash*.
- **Integración:** REST directo (`fetch`), sin SDK, con function calling (`functionDeclarations` con `parametersJsonSchema` generado por zod). Devuelve la `thoughtSignature` de cada llamada, como pide la API.
- **Costo estimado por caso:** 2–3 llamadas al modelo gracias a `oc_procesar` (antes ~6). Prompt, conocimiento y herramientas pesan unos 8,5 kB (≈ 2,5 k tokens) y los resultados de herramientas acumulan otros ≈ 2,5 k. En total ≈ 10 k tokens de entrada y ≈ 1 k de salida por caso. En plan gratuito el costo es 0; en plan pago hay que multiplicar por el precio vigente del modelo. Para cuidar la cuota, las herramientas reciben solo `caso` (no se reenvían paquetes grandes). Además hay tope de tokens por sesión y por día y límite de peticiones por IP.
- **Errores transitorios (429, 5xx, timeout):** hasta 3 intentos con espera creciente (1,5 s y 4 s). Si el modelo principal sigue saturado, el adaptador cae a `GEMINI_FALLBACK_MODEL` (por defecto `gemini-3.8-flash`) con los mismos reintentos. Si también falla, el chat muestra un mensaje claro y la sesión sigue. Los intentos fallidos no suman tokens al tope. Esto salió de una prueba real: en el despliegue, `gemini-3.8-flash` respondió 503 (saturado) y luego fue lento.
- **Respaldo:** `LLM_PROVIDER=local` es un adaptador determinista sin modelo que sigue el mismo flujo. Sirve si se agota la cuota y demuestra que el ciclo no depende del proveedor.

## 5. Matriz de controles

Implementadas como funciones puras en `src/core/reglas.ts`, con pruebas positivas y negativas en `tests/reglas.test.ts` (ver la matriz completa en `SPEC.md §4`).

| # | Implementación | Tipo |
|---|---|---|
| RC1 | Busca por NIT normalizado; si la solicitud no trae NIT, por nombre normalizado (sin tildes ni puntuación). Verifica `activo`. | Bloqueo |
| RC2 | Aprobación presente, "Aprobado" sin negación ("No aprobado", "rechazado"), remitente en `aprobadores` **del centro de la solicitud**. | Bloqueo |
| RC3 | Tope del aprobador **en ese centro**. Si el aprobador no pertenece al centro, su tope es 0 ahí. Sugiere quién sí puede aprobar o que hay que escalar. | Bloqueo |
| RC4 | `subarea ∈ centro.subareas`. | Bloqueo |
| RC5 | `|cot − sol| / sol ≤ 2 %`; muestra ambos valores y el %. Sin cotización → confirmación. La OC usa el valor aprobado de la solicitud. | Confirmación |
| RC6 | Sin IVA → `indicador_iva_default` del proveedor + confirmación. | Confirmación + derivado |
| RC7 | Sin condiciones de pago → `condiciones_pago_default` (solo informa, trazado como `maestro.proveedores`). | Derivado |
| RC8 | Factura con fecha < solicitud → `retroactiva=true`, confirmación, columna `retroactiva` en `control.csv`. | Confirmación |
| RC9 | Día de la aprobación **en la hora local del correo** ≥ `fecha_solicitud`. | Confirmación |
| RC10 | `|cantidad × unitario − total| ≤ 1`. | Bloqueo |

**La más difícil: RC3 (con RC2).** En sol-003, fvargas tiene tope de 80 M, lo que "cubriría" los 74 M, pero ese tope es de CC-3030 y la compra es de CC-2020. La lectura ingenua (buscar el tope del aprobador en cualquier centro) deja pasar la compra. La regla correcta evalúa el tope **en el centro de la solicitud**, y la acción sugerida avisa además que ningún aprobador de CC-2020 cubre 74 M (rtorres tiene 30 M), así que hay que escalar. Otra trampa fue RC9: la aprobación de sol-004 es del 26-ago 18:45 −05:00. Convertida a UTC sería el 27, así que la comparación se hace con el día local del correo.

## 6. Diseño del adaptador SAP real

**Opción elegida: OData `API_PURCHASEORDER_PROCESS_SRV` (S/4HANA)**, expuesta a través de **SAP Integration Suite / API Management** si el cliente la tiene. Motivos: es la API estándar y soportada para crear OC, usa HTTP+JSON (encaja con Node) y permite leer la OC por referencia para la idempotencia. Si el sistema es ECC sin gateway OData, la alternativa es RFC `BAPI_PO_CREATE1` mediante un middleware (Integration Suite o un conector Java/.NET), nunca desde el agente.

**Mapeo del payload (7.4 → `A_PurchaseOrder`):**

| Payload | OData |
|---|---|
| `sociedad` | `CompanyCode` |
| `organizacion_compras` | `PurchasingOrganization` (+ `PurchasingGroup` configurado) |
| `proveedor.codigo_sap` | `Supplier` |
| `moneda` | `DocumentCurrency` |
| `condiciones_pago` | `PaymentTerms` |
| `referencia.solicitud_id` | `CorrespondncExternalReference` (o campo Z / texto de cabecera): llave de idempotencia |
| `posiciones[].numero` | `to_PurchaseOrderItem.PurchaseOrderItem` |
| `posiciones[].descripcion` | `PurchaseOrderItemText` (40 caracteres) |
| `cantidad`, `unidad` | `OrderQuantity`, `PurchaseOrderQuantityUnit` (UN→EA/ST, H→H, MES→MON según customizing) |
| `precio_unitario` | `NetPriceAmount` |
| `indicador_iva` | `TaxCode` |
| `centro_costo` | `to_AccountAssignment.CostCenter` con `AccountAssignmentCategory = K` |
| `subarea` | Campo de imputación acordado (p. ej. orden interna o texto) |
| `aprobador`, `evidencia_sha256` | Texto de cabecera + adjunto (Attachment Service / GOS) con `aprobacion.pdf` |
| `excepciones[]` | Texto de cabecera "Excepciones confirmadas" |

**Autenticación y credenciales:** OAuth 2.0 client credentials (o certificado X.509) contra un usuario técnico con rol mínimo (crear y leer OC). Las credenciales viven en un gestor de secretos (Azure Key Vault, AWS Secrets Manager o variables del servicio) y solo las lee el adaptador del backend. Nunca el modelo, el prompt ni el front. El agente solo ve `SapAdapter`.

**Idempotencia y errores parciales:**
- Antes de crear: `buscarOrdenPorReferencia(solicitud_id)` (GET filtrando por la referencia externa). Si existe, devuelve ese número.
- Crear con el token CSRF y un `Idempotency-Key = solicitud_id` en el middleware. Ante timeout, **no se reintenta a ciegas**: se reconsulta por referencia y se reintenta solo si no existe.
- Si SAP crea la cabecera pero falla un adjunto o un texto (éxito parcial), la OC se registra como creada con estado `incompleta` en `control.csv` y queda una tarea de reintento solo para el adjunto. Si falla la creación (mensajes `BAPIRET2`/OData con tipo E), no se registra OC y se devuelven los mensajes de SAP traducidos a la analista.

**Plan B (si la conexión no es viable):** el agente igual hace todo el trabajo de validación y genera **(a)** la OC lista para pegar (tabla campo → valor en el orden de la transacción ME21N) y **(b)** un archivo de carga masiva (CSV/LSMW o plantilla de *Migration Cockpit*) con las OC aptas y confirmadas del día, más el PDF de aprobación. La analista solo carga el archivo y registra el número. Se mantiene el control y la medición de retroactivas.

## 7. Lectura del proceso: OC retroactivas

**Qué está pasando.** En 1 de las 6 solicitudes del lote (≈17 %), sol-005, la factura FC-88231 se emitió el 10 de agosto y la solicitud se hizo el 27 de agosto, 17 días después. El correo del aprobador lo confirma: "Ya llegó la factura, por favor crear la OC para poder radicarla". En ese caso la OC no sirvió para **autorizar** el gasto antes de comprometerlo. Se usó para **legalizar** una factura que ya existía. La cotización, la comparación de precios y la validación del aprobador llegan cuando el proveedor ya entregó y facturó, así que el control pierde su valor preventivo.

**Qué le diría a la dirección.**
1. Ya se puede medir. Cada OC retroactiva queda marcada (`retroactiva = true`) en `out/control.csv`, con fecha, centro de costo y proveedor. Con eso se arma un indicador mensual: % de OC retroactivas por centro de costo, por aprobador y por proveedor.
2. El riesgo no es administrativo. Es de control: compras sin precio negociado, sin verificar que el aprobador tenga tope y, sobre todo, sin presupuesto comprometido a tiempo. Eso distorsiona el cierre contable.
3. La política es una decisión de la dirección. Propongo una transición en dos pasos. Primero, **tolerar con marca y justificación obligatoria** (el agente ya exige confirmación explícita). Después, cuando el indicador baje de una meta acordada (por ejemplo < 5 %), **rechazar** las retroactivas que superen un monto definido, salvo urgencia aprobada por la gerencia.

**Cambio de proceso que propondría.**
- **"Sin OC no hay pago":** cuentas por pagar no radica facturas sin una OC creada **antes** de la fecha de la factura.
- **OC primero:** que el agente procese la solicitud apenas llega el correo, y no cuando aparece la factura. Así crear la OC toma minutos y deja de ser una excusa.
- **Proveedores informados:** comunicar a los proveedores recurrentes que su factura debe citar el número de OC.
- **Seguimiento:** revisión mensual del indicador con los líderes y centros que más retroactivas generan, con planes concretos (por ejemplo, contratos marco u OC abiertas para compras recurrentes como papelería).

## 8. Decisiones y trade-offs

1. **Las herramientas releen los archivos del caso en vez de confiar en lo que manda el modelo.** El contrato del PRD pide `paquete`, `derivados` y `payload` como entrada. Se aceptan (opcionales), pero la validación y la creación siempre se hacen desde los archivos, y si difieren se informa en `advertencias`. *Descartado:* validar el objeto que manda el modelo, porque el modelo podría "arreglar" un monto (riesgo explícito del PRD §10) y además cuesta tokens reenviar paquetes grandes.
2. **Confirmación validada por el servidor (`ctx.confirmacionHumana`)**, no solo un parámetro `confirmado`. *Descartado:* confiar en `confirmado=true` del modelo, que con una inyección de prompt podría autoconfirmarse. Costo: el host debe implementar la función (en el módulo, si no la provee, cuenta solo `confirmado`, y está documentado).
3. **Reglas como funciones puras en código, no en el prompt.** Son deterministas, se prueban sin modelo y `demo.ts` las ejercita. *Descartado:* que el modelo aplique las reglas leyendo el conocimiento, porque no es determinista ni auditable.
4. **REST directo a Gemini en vez del SDK.** Dependencias de ejecución: `express`, `express-rate-limit`, `zod` (obligatorio), `pdf-lib` (evidencia PDF) y `tsx` (ejecutar TypeScript sin compilar). Menos dependencias, control total de timeout, 429 y cabeceras (la clave va en `x-goog-api-key`, nunca en la URL). *Descartado:* el SDK oficial, por su peso y porque oculta detalles de reintento.
5. **Sesiones en memoria y SAP mock en archivos.** Cumple el PRD (sin BD) y es simple. *Trade-off:* en Render gratis, un reinicio pierde sesiones y `out/` (disco efímero).
6. **Usuario y clave (HTTP Basic) en el link + límites.** *Descartado:* link abierto, porque cualquiera podría agotar la cuota del modelo.

## 9. Supuestos

- La OC se crea por el **valor de la solicitud** (lo aprobado). La cotización solo se contrasta (RC5).
- `solicitud_id` (`SOL-2026-001`) es la llave de idempotencia en SAP; la carpeta (`sol-001`) es el identificador del caso en el chat.
- "Aprobado" cuenta si aparece como palabra y no está negado.
- Las fechas de aprobación se comparan por día en la zona horaria del propio correo.
- RC6 y RC7 solo derivan si el proveedor existe; si no, ya hay bloqueo RC1.
- Unidad de la posición: `H` si el ítem habla de horas; si no, `UN`. `sociedad` y `organizacion_compras` = "1000" (constantes del PRD).
- La descripción se recorta a 40 caracteres en límite de palabra; la trazabilidad lo indica.
- RC3, cuando el aprobador no pertenece al centro: se reporta además de RC2 para dar la acción concreta (quién tiene tope suficiente).

## 10. Cobertura

| HU | Estado | Evidencia | Falta para producción |
|---|---|---|---|
| HU-1 Leer paquete | Hecho | `oc_leer_paquete`, pruebas L1–L4 | Leer `.xlsx` / PDF reales (P1) |
| HU-2 Validar | Hecho | RC1–RC10, `tests/reglas.test.ts` | Maestros en línea desde SAP |
| HU-3 Payload | Hecho | zod 7.4 + `trazabilidad.json` | Mapeo OData real |
| HU-4 Evidencia | Hecho | P0 `aprobacion.txt` + sha256; P1 `aprobacion.pdf` (`pdf-lib`) | Firma digital / PDF/A |
| HU-5 Crear OC | Hecho | SAP mock, idempotencia, `control.csv` | Adaptador SAP real (§6) |
| HU-6 Errores | Hecho | Pruebas de excepciones; 429, timeout | Alertas y monitoreo |
| Chat + API + topes | Hecho | `web/`, `/api/*`, `tests/ciclo.test.ts` | Autenticación por usuario y roles, sesiones persistentes |
| Bonus módulo | Hecho | `modulo/` + `tests/modulo.test.ts` | Publicarlo como paquete |

## 11. Uso de IA

- **Claude (Anthropic), en Claude Code:** leyó el PRD y los fixtures, redactó el borrador de `SPEC.md` y de las pruebas, generó el código (herramientas, reglas, adaptadores, ciclo, servidor, front), `demo.ts`, el README y el borrador de este documento. Yo efectué el trabajo de revisión realizada por el modelo de Inteligencia Artificial. Adicionalmente, revisé el despliegue en render para evaluar el modelo conversacional y validar que si funcionara respecto a lo que se esperaba.
- **Gemini:** es el modelo que usa la aplicación en ejecución.
- **Lo que descartamos de lo propuesto:** (1) el esqueleto inicial, que validaba en el prompt y usaba `/api/confirm` con 409: se reemplazó por reglas en código y confirmación en el siguiente mensaje; (2) tomar el tope de fvargas de CC-3030 para sol-003; (3) comparar la fecha de aprobación en UTC; (4) rechazar `oc_crear` cuando el payload del modelo difiere: se prefirió crear el payload reconstruido y advertir, para no romper la conversación sin necesidad; (5) usar el SDK de Anthropic, que se cambió a Gemini por costo.

## 12. Riesgos de llevar esto a producción y cómo los mitigaría

| Riesgo | Mitigación |
|---|---|
| El modelo inventa o altera valores | Las herramientas son la única fuente; se relee el caso; `oc_crear` reconstruye el payload; el prompt lo prohíbe. |
| Inyección de prompt para autoconfirmar o saltar bloqueos | Confirmación validada por el servidor; los bloqueos no se saltan ni con confirmación (probado). |
| Fuga de la clave del modelo | Solo en variables de entorno del backend, cabecera HTTP (no URL), nunca en logs, front ni respuestas; `/api/health` no la expone; probado en `tests/seguridad.test.ts`. Historial git revisado sin secretos. En producción: gestor de secretos y rotación. |
| Acceso no autorizado | HTTP Basic obligatorio en producción (clave ≥ 10, comparación en tiempo constante), límite por IP antes de autenticar contra fuerza bruta. En producción: SSO corporativo (OIDC) con roles. |
| Ataques desde el navegador (XSS, clickjacking) | CSP `script-src 'self'` sin scripts en línea, escape del texto del modelo, `X-Frame-Options: DENY`, sin CORS. |
| Entradas maliciosas (path traversal, cuerpos enormes) | zod en toda entrada; `caso` restringido a `sol-…`; cuerpo ≤ 16 kB; errores genéricos sin trazas. |
| Datos personales en registros | `out/log.jsonl` solo guarda argumentos simples y enmascara correos; los fixtures son ficticios. En producción: retención definida y cifrado en reposo. |
| Prompt injection desde los documentos | El prompt trata los documentos como datos; la creación depende de reglas en código y de la confirmación validada por el servidor, no del modelo. |
| Gasto descontrolado / cuota gratuita | Topes de iteraciones, tokens por sesión y por día, límite por IP, acceso con clave, reintento único ante 429. |
| Indisponibilidad o cambios del modelo gratuito | Reintentos con espera creciente, modelo de respaldo automático (`GEMINI_FALLBACK_MODEL`), `GEMINI_MODEL` configurable y proveedor `local` sin modelo. |
| Conexión SAP no viable | Plan B de §6 (archivo de carga / OC lista para pegar). |
| Concurrencia (doble OC) | Creación serializada e idempotente por `solicitud_id`; en real, llave de idempotencia y reconsulta. |
| Datos en disco efímero (Render) | En producción: BD o almacenamiento persistente para `control.csv`, log y sesiones. |
| Firma de la evidencia | El correo como evidencia puede no bastar para auditoría: firma digital o PDF/A con sello de tiempo. |
