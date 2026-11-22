import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Ctx, runTool, toolSpecs } from "../tools/oc.js";

export type AgentEvent =
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; result: unknown }
  | { type: "confirmation_required"; caso_id: string; motivo: string };

export interface Session {
  ctx: Ctx;
  history: Anthropic.MessageParam[];
}

const MAX_TURNS = 10; // tope de iteraciones del ciclo para evitar bucles
const MAX_HISTORY = 40;

let cachedPrompt: string | null = null;
async function systemPrompt(): Promise<string> {
  cachedPrompt ??= await readFile(path.resolve("agent/prompt.md"), "utf8");
  return cachedPrompt;
}

/**
 * Ciclo del agente: el modelo propone llamadas a herramientas, el servidor las ejecuta (con zod),
 * devuelve los resultados y repite hasta que el modelo responde con texto o se pide confirmación humana.
 */
export async function runAgent(
  session: Session,
  userText: string,
  onEvent: (e: AgentEvent) => void,
): Promise<string> {
  const client = new Anthropic(); // usa ANTHROPIC_API_KEY del entorno
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";
  const system = await systemPrompt();
  const tools = toolSpecs() as Anthropic.Tool[];

  session.history.push({ role: "user", content: userText });
  if (session.history.length > MAX_HISTORY) session.history.splice(0, session.history.length - MAX_HISTORY);

  let finalText = "";
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await client.messages.create({
      model,
      max_tokens: 2000,
      system,
      tools,
      messages: session.history,
    });
    session.history.push({ role: "assistant", content: res.content });

    finalText = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (calls.length === 0) return finalText;

    const results: Anthropic.ToolResultBlockParam[] = [];
    let waitingHuman = false;
    for (const c of calls) {
      onEvent({ type: "tool_call", id: c.id, name: c.name, input: c.input });
      const r = await runTool(c.name, c.input, session.ctx);
      onEvent({ type: "tool_result", id: c.id, name: c.name, result: r });
      if (r.requiresConfirmation && session.ctx.pending) {
        waitingHuman = true;
        onEvent({ type: "confirmation_required", ...session.ctx.pending });
      }
      results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(r), is_error: !r.ok });
    }
    session.history.push({ role: "user", content: results });
    if (waitingHuman) return finalText || "Necesito la confirmación de un humano para continuar.";
  }
  return finalText || "Se alcanzó el límite de pasos del agente.";
}
