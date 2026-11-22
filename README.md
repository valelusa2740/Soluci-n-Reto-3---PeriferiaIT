# Agente "Órdenes de Compra SAP" — Reto 03 (Periferia IT Group)

Agente conversacional en TypeScript que lee el paquete de una solicitud de compra, lo valida contra los maestros (reglas RC1–RC10), arma la OC tal como quedaría en SAP, genera la evidencia de aprobación y la crea en un SAP simulado. Lo que no cumple control se bloquea; las dudas se convierten en confirmaciones humanas.

## Link de prueba y acceso

- **URL:** `PENDIENTE (Render)`
- **Usuario:** `PENDIENTE` · **Clave:** `PENDIENTE` (el navegador los pide al abrir el link; protegen la cuota del modelo)
- El plan gratuito de Render se duerme tras 15 minutos sin uso: el primer acceso puede tardar ~1 minuto.

Documentos: especificación [`SPEC.md`](SPEC.md) · Planteamiento: [`SOLUCION.md`](SOLUCION.md) · PRD: [`docs/PRD.md`](docs/PRD.md)

## Levantar en local (un comando)

Requisitos: Node 20+ (o Bun).

```bash
npm install && npm run dev        # http://localhost:3000
```

Sin variables de entorno arranca con el proveedor `local` (determinista, sin modelo ni clave). Para usar Gemini, define las variables (ver `.env.example`).

## Variables de entorno

| Variable | Para qué | Ejemplo |
|---|---|---|
| `LLM_PROVIDER` | `gemini` o `local` | `gemini` |
| `GEMINI_API_KEY` | Clave de Google AI Studio. **Solo en el entorno del backend.** | — |
| `GEMINI_MODEL` | Modelo de Gemini | `gemini-3.8-flash` |
| `ACCESS_USER` / `ACCESS_PASS` | Usuario y clave del link (obligatorios en producción) | — |
| `MAX_ITERACIONES` | Tope de pasos modelo→herramientas por turno | `25` |
| `MAX_TOKENS_SESION` / `MAX_TOKENS_DIA` | Topes de costo por sesión y global diario | `150000` / `2000000` |
| `LLM_TIMEOUT_MS` | Timeout al proveedor | `60000` |
| `MAX_PETICIONES_MINUTO` | Límite de peticiones por IP | `10` |

## Cómo correr demo.ts (verificación sin modelo)

```bash
npm run demo          # o: bun run demo.ts
```

Limpia `out/`, procesa los 6 casos llamando directo a las herramientas e imprime `apta`, bloqueos, confirmaciones, `retroactiva` y número de OC o motivo. Muestra la idempotencia (sol-001 dos veces → mismo número) y la confirmación explícita de sol-004.

| Caso | Resultado |
|---|---|
| sol-001 | OC creada sin intervención; 2.ª ejecución idempotente |
| sol-002 | Bloqueada RC1 (proveedor no existe) |
| sol-003 | Bloqueada RC2 + RC3 (aprobador de otro centro, sin tope en CC-2020) |
| sol-004 | Confirmación RC5 (25.000.000 vs 26.500.000, 6 %) → OC tras "confirmo" |
| sol-005 | Confirmación RC8, **retroactiva** → OC marcada en `out/control.csv` |
| sol-006 | Proveedor por nombre; IVA C1 derivado (confirmación RC6); pago Z030 derivado (RC7) |

## Pruebas

```bash
npm test              # 71 pruebas: por regla, por caso, ciclo del agente, adaptador Gemini, módulo
npm run typecheck     # TypeScript estricto, sin any
```

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId (uuid), message }` → `{ reply, toolCalls[], needsConfirmation, pendiente }` |
| `GET` | `/api/sessions/:id` | Historial visible (mensajes y llamadas a herramientas), tokens usados y confirmación pendiente |
| `GET` | `/api/health` | `{ ok, provider, model }` (sin claves; público para el health check) |

**Confirmación humana:** cuando una OC tiene confirmaciones (RC5, RC6, RC8, RC9), el agente termina su turno con una pregunta y `needsConfirmation=true`. Solo el **siguiente** mensaje de la persona puede confirmar ("confirmo", "sí, créala" o el botón del chat). El servidor valida esa confirmación; el modelo no puede confirmar por su cuenta.

## Estructura

```
agent/prompt.md                 comportamiento (system prompt)
src/knowledge/ordenes-compra.md conocimiento del proceso
src/tools/oc.ts                 herramientas oc_* (zod) — ejecución
src/tools/registro.ts           nombres oc_<export>, validación zod, log
src/core/                       lectura del paquete, reglas RC1–RC10, payload, salidas
src/sap/adapter.ts · mock.ts    interfaz SapAdapter y SAP simulado (out/sap/)
src/llm/adapter.ts              interfaz propia del proveedor LLM
src/llm/gemini.ts · local.ts    Gemini (function calling) y proveedor local sin modelo
src/agente/ciclo.ts             ciclo del agente (topes, confirmación, errores)
src/server.ts                   API HTTP, acceso, límites
web/index.html                  chat
modulo/                         bonus: agente empaquetado (mismas piezas, ver tests/modulo.test.ts)
fixtures/                       entregados por Periferia (sin modificar)
out/                            generado en ejecución (no se versiona)
```

## Despliegue (Render)

`render.yaml` define el servicio (plan gratuito): build `npm ci --include=dev && npm run typecheck && npm test`, start `npm start`, health check `/api/health`. Las variables secretas (`GEMINI_API_KEY`, `ACCESS_USER`, `ACCESS_PASS`) se cargan en el panel de Render, nunca en el repositorio. El plan gratuito se duerme tras 15 minutos sin tráfico: abrir el link unos minutos antes de usarlo. `out/` vive en el disco efímero del servicio.
