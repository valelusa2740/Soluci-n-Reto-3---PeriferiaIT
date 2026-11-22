/**
 * Verificación determinista: procesa cada caso llamando a las herramientas directamente,
 * SIN modelo de lenguaje. Cada caso usa su propio contexto (no se cruza información entre casos).
 *
 * Uso: npm run demo
 */
import { createCtx, listarCasos, runTool } from "./src/tools/oc.js";

const casos = await listarCasos();
if (casos.length === 0) {
  console.log("No se encontraron casos en fixtures/reto-03/solicitudes. Copia aquí el contenido del ZIP.");
  process.exit(1);
}

const filas: Array<Record<string, string>> = [];
for (const caso_id of casos) {
  const ctx = createCtx(); // estado aislado por caso
  const lectura = await runTool("leer_caso", { caso_id }, ctx);
  const val = await runTool("validar_controles", { caso_id }, ctx);
  const v = (val.data ?? {}) as { decision?: string; reason?: string; controls?: Array<{ passed: boolean }> };

  let orden = "-";
  if (v.decision === "APROBAR") {
    const r = await runTool("crear_orden_compra", { caso_id }, ctx);
    orden = r.ok ? (r.data as { numero: string }).numero : `ERROR: ${r.error}`;
  } else if (v.decision === "CONFIRMAR") {
    orden = "pendiente de confirmación humana";
  }

  filas.push({
    caso: caso_id,
    lectura: lectura.ok ? "OK" : "FALLA",
    decision: v.decision ?? "?",
    controles_fallidos: String(v.controls?.filter((c) => !c.passed).length ?? "?"),
    orden,
    motivo: v.reason ?? "",
  });
}
console.table(filas);
