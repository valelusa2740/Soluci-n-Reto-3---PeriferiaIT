# SPEC — Agente de órdenes de compra (Reto 3)

> Metodología SDD: primero la especificación, luego las pruebas, luego el código. Completar al recibir `docs/PRD.md`.

## 1. Objetivo
(Resumir en 2–3 líneas el objetivo de negocio según el PRD.)

## 2. Alcance
- Dentro: lectura de solicitudes, validación de controles, creación de OC en SAP simulado.
- Fuera: (completar).

## 3. Matriz de controles
| ID | Control | Fuente de datos (maestro) | Condición | Si falla | Justificación |
|----|---------|---------------------------|-----------|----------|---------------|
| C1 | Proveedor existe y está activo | proveedores.json | | RECHAZAR / CONFIRMAR | |
| C2 | Centro de costo y subárea válidos | centros-costo.json | | | |
| C3 | Monto dentro del tope del líder aprobador | centros-costo.json + aprobacion.json | | | |
| C4 | Indicador de IVA coherente | indicadores-iva.json | | | |
| C5 | Condición de pago válida | condiciones-pago.json | | | |
| C6 | Compra retroactiva (factura previa a la OC) | factura.txt | | | |

## 4. Criterios de aceptación (formato Dado / Cuando / Entonces)
- **CA-01** Dado un proveedor inactivo, cuando se valida el caso, entonces la decisión es RECHAZAR y no se crea OC.
- (Agregar uno por control y por escenario: positivo, negativo y excepción.)

## 5. Escenarios por caso
| Caso | Descripción | Decisión esperada | Controles clave | Prueba |
|------|-------------|-------------------|-----------------|--------|
| sol-001 | | | | |
| sol-002 | | | | |
| sol-003 | | | | |
| sol-004 | | | | |
| sol-005 | | | | |
| sol-006 | | | | |

## 6. Requisitos no funcionales
- Seguridad: llaves solo en variables de entorno; acceso protegido; validación de entrada con zod; sin datos sensibles en logs.
- Aislamiento: el estado se crea por caso/sesión; ningún dato se comparte entre casos.
- Determinismo: `demo.ts` y las pruebas no usan modelo de lenguaje.
- Confirmación humana: la registra el servidor, no el modelo.

## 7. Trazabilidad
| Regla del PRD | Control | Criterio de aceptación | Prueba |
|---------------|---------|------------------------|--------|
