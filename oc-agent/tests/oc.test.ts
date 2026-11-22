import { describe, expect, it } from "vitest";
import { createCtx, runTool } from "../src/tools/oc.js";

/**
 * Pruebas de la estructura. Las pruebas por control y por caso (it.todo) se escriben a partir de SPEC.md
 * cuando se reciba el PRD: positivas, negativas y de excepción.
 */
describe("seguridad de entrada (zod)", () => {
  it("rechaza caso_id con path traversal", async () => {
    const r = await runTool("leer_caso", { caso_id: "../../etc/passwd" }, createCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Entrada inválida");
  });
  it("rechaza herramienta desconocida", async () => {
    const r = await runTool("borrar_todo", {}, createCtx());
    expect(r.ok).toBe(false);
  });
});

describe("crear_orden_compra: reglas de bloqueo", () => {
  it("no crea orden sin validación previa", async () => {
    const r = await runTool("crear_orden_compra", { caso_id: "sol-001" }, createCtx());
    expect(r.ok).toBe(false);
  });
  it("no crea orden si la decisión fue RECHAZAR", async () => {
    const ctx = createCtx();
    ctx.validated.set("sol-001", { decision: "RECHAZAR", controls: [], reason: "x" });
    expect((await runTool("crear_orden_compra", { caso_id: "sol-001" }, ctx)).ok).toBe(false);
  });
  it("CONFIRMAR sin aprobación humana no crea orden; con aprobación sí", async () => {
    const ctx = createCtx();
    ctx.validated.set("sol-002", { decision: "CONFIRMAR", controls: [], reason: "x" });
    expect((await runTool("crear_orden_compra", { caso_id: "sol-002" }, ctx)).ok).toBe(false);
    ctx.confirmed.add("sol-002");
    expect((await runTool("crear_orden_compra", { caso_id: "sol-002" }, ctx)).ok).toBe(true);
  });
  it("es idempotente: no duplica la orden", async () => {
    const ctx = createCtx();
    ctx.validated.set("sol-003", { decision: "APROBAR", controls: [], reason: "x" });
    expect((await runTool("crear_orden_compra", { caso_id: "sol-003" }, ctx)).ok).toBe(true);
    expect((await runTool("crear_orden_compra", { caso_id: "sol-003" }, ctx)).ok).toBe(false);
  });
});

describe("aislamiento entre casos/sesiones", () => {
  it("el estado de un contexto no afecta a otro", async () => {
    const a = createCtx();
    const b = createCtx();
    a.validated.set("sol-004", { decision: "APROBAR", controls: [], reason: "x" });
    await runTool("crear_orden_compra", { caso_id: "sol-004" }, a);
    expect(a.orders.size).toBe(1);
    expect(b.orders.size).toBe(0);
    expect((await runTool("crear_orden_compra", { caso_id: "sol-004" }, b)).ok).toBe(false);
  });
});

describe("matriz de controles (pendiente del PRD)", () => {
  it.todo("C1 proveedor activo: positivo / negativo / excepción");
  it.todo("C2 centro de costo y subárea válidos");
  it.todo("C3 tope de aprobación del líder");
  it.todo("C4 indicador de IVA coherente con la cotización");
  it.todo("C5 condición de pago del proveedor");
  it.todo("C6 compra retroactiva (factura anterior a la orden)");
  it.todo("sol-001 … sol-006: decisión esperada por caso");
});
