# Proceso de órdenes de compra (conocimiento del agente)

## El paquete de cada solicitud
Cada compra llega por correo con: solicitud (Excel normalizado a `solicitud.json`), cotización del proveedor (`cotizacion.txt`), correo de aprobación del líder (`aprobacion.json`) y, a veces, la factura (`factura.txt`). Los casos viven en `fixtures/reto-03/solicitudes/<caso>/` (`sol-001` … `sol-006`). El `solicitud_id` (p. ej. `SOL-2026-001`) es la referencia en SAP.

## Maestros
- **Proveedores**: código SAP, NIT (sin puntos ni dígito de verificación), condiciones de pago e indicador de IVA por defecto, activo/inactivo.
- **Centros de costo**: subáreas y aprobadores con su tope. El tope de un aprobador vale **solo** en su centro.
- **Indicadores de IVA**: C0 excluido, C1 19 %, C2 5 %.
- **Condiciones de pago**: Z000 inmediato, Z015, Z030, Z060 días fecha factura.

## Reglas de control
| Regla | Qué verifica | Si falla |
|---|---|---|
| RC1 | Proveedor existe (por NIT; sin NIT, por nombre) y está activo | Bloqueo: crear proveedor en datos maestros o cambiarlo |
| RC2 | Hay aprobación, dice "Aprobado" y la envía un aprobador del centro de costo | Bloqueo: pedir aprobación al aprobador correcto |
| RC3 | Valor total ≤ tope del aprobador en ese centro | Bloqueo: escalar a quien tenga tope suficiente |
| RC4 | La subárea pertenece al centro | Bloqueo: corregir la solicitud |
| RC5 | Cotización y solicitud difieren ≤ 2 % | Confirmación (se muestran ambos valores); la OC usa el valor de la solicitud |
| RC6 | Falta indicador de IVA | Se deriva del proveedor y se pide confirmación |
| RC7 | Faltan condiciones de pago | Se derivan del proveedor; solo se informa |
| RC8 | Factura con fecha anterior a la solicitud | OC **retroactiva**: confirmación y marca en `out/control.csv` |
| RC9 | Aprobación con fecha ≥ solicitud (día local) | Confirmación |
| RC10 | Cantidad × valor unitario = total (±1) | Bloqueo: corregir montos |

## Por qué importa la OC retroactiva
La OC debe crearse antes de recibir la factura (cotización → aprobación → OC → factura). Cuando la factura llega primero, la cotización y el control previo se saltan. La dirección quiere medir cuántas OC son retroactivas, por eso cada una queda marcada en el control.

## Salidas
- `out/control.csv`: una fila por intento de creación (creada, idempotente, bloqueada, pendiente_confirmacion).
- `out/log.jsonl`: cada llamada a herramienta.
- `out/sap/ordenes.jsonl`: OC creadas en el SAP simulado (números desde 4500000001; crear dos veces la misma solicitud devuelve el mismo número).
- `out/<caso>/trazabilidad.json` y `out/<caso>/aprobacion.txt`.
