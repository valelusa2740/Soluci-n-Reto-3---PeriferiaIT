# SOLUCIÓN — Agente de órdenes de compra (Reto 3)

## 1. Arquitectura
- **Frontend** (`public/index.html`): chat que muestra las llamadas a herramientas y resalta las confirmaciones humanas.
- **Backend** (`src/server.ts`): Express, acceso protegido (Basic), límite de peticiones, validación con zod, cabeceras de seguridad.
- **Agente** (`src/agent/loop.ts`) + **prompt** (`agent/prompt.md`): ciclo de herramientas con tope de iteraciones.
- **Herramientas** (`src/tools/oc.ts`): lógica determinista (controles, SAP simulado). El modelo solo orquesta.
- **Verificación**: `demo.ts` (sin LLM) y `tests/` (vitest).

(Incluir diagrama.)

## 2. Ciclo del agente
1. El usuario indica un caso. 2. El modelo llama `leer_caso`. 3. Llama `validar_controles` (decisión determinista). 4. Según la decisión: crear OC, pedir confirmación humana o explicar el rechazo. 5. La confirmación la registra el servidor; el modelo no puede autoaprobarse.

## 3. Matriz de controles implementada
(Copiar de SPEC.md, con el resultado real por caso.)

## 4. Decisiones de diseño
- Reglas en código, no en el prompt (reproducibles y auditables).
- Estado aislado por sesión/caso.
- Idempotencia en la creación de órdenes.
- (Agregar las demás.)

## 5. Seguridad
(Llaves en entorno, acceso protegido, validación de entrada, límite de peticiones, logs sin datos sensibles.)

## 6. Adaptador SAP real (diseño)
(Interfaz `SapGateway`, autenticación, idempotencia, manejo de errores y reintentos, trazabilidad, ambiente de pruebas.)

## 7. Análisis crítico: órdenes retroactivas
(Qué desvío del proceso se detecta, riesgo, causas probables, controles preventivos y detectivos, recomendaciones.)

## 8. Costos del modelo y puesta en producción
(Tokens por caso, costo estimado, límites, observabilidad, escalamiento.)

## 9. Cómo ejecutar y probar
`npm install` · `npm test` · `npm run demo` · `npm start`
