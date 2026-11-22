# Agente de órdenes de compra (Reto 3)

Agente conversacional en TypeScript (Node 20+) que lee solicitudes de compra, valida controles y crea órdenes en un SAP simulado.

## Ejecutar local
```bash
npm install
cp .env.example .env      # completa ANTHROPIC_API_KEY (no subir .env)
npm test                  # pruebas automatizadas
npm run demo              # casos sin modelo de lenguaje
npm start                 # http://localhost:3000
```

## Variables de entorno
| Variable | Descripción |
|---|---|
| `ANTHROPIC_API_KEY` | Llave del modelo (solo en el servidor) |
| `ANTHROPIC_MODEL` | Modelo (por defecto `claude-sonnet-5-5`) |
| `ACCESS_USER` / `ACCESS_PASS` | Acceso protegido al chat (obligatorio en producción) |

## Despliegue en Render
Servicio web Node: build `npm ci`, start `npm start`, health check `/health`. Configurar las variables de arriba en el panel de Render.

## Estructura
`agent/prompt.md` · `src/tools/oc.ts` · `src/agent/loop.ts` · `src/server.ts` · `public/` · `demo.ts` · `tests/` · `SPEC.md` · `SOLUCION.md`
