"use strict"
const hilo = document.getElementById("hilo"), log = document.getElementById("log")
const input = document.getElementById("input"), enviarBtn = document.getElementById("enviar")
let sessionId = localStorageGet() || nuevaId()

function nuevaId() { const id = crypto.randomUUID(); try { localStorage.setItem("oc-session", id) } catch {} return id }
function localStorageGet() { try { return localStorage.getItem("oc-session") } catch { return null } }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[c])

// Markdown mínimo (tablas, negrita, código, listas). Se escapa el HTML antes: el texto del modelo nunca se inyecta como HTML.
function md(texto) {
  const lineas = esc(texto).split("\n"); let html = "", i = 0
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>")
  while (i < lineas.length) {
    const l = lineas[i]
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const filas = []; while (i < lineas.length && /^\s*\|.*\|\s*$/.test(lineas[i])) filas.push(lineas[i++])
      const celdas = (f) => f.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()))
      const cuerpo = filas.filter((f) => !/^\s*\|[\s:|-]+\|\s*$/.test(f))
      html += "<table>" + cuerpo.map((f, k) => "<tr>" + celdas(f).map((c) => k === 0 ? `<th>${c}</th>` : `<td>${c}</td>`).join("") + "</tr>").join("") + "</table>"
      continue
    }
    if (/^\s*[-*] /.test(l)) {
      html += "<ul>"; while (i < lineas.length && /^\s*[-*] /.test(lineas[i])) html += `<li>${inline(lineas[i++].replace(/^\s*[-*] /, ""))}</li>`; html += "</ul>"; continue
    }
    if (/^#{1,4} /.test(l)) { html += `<p><strong>${inline(l.replace(/^#+ /, ""))}</strong></p>`; i++; continue }
    if (l.trim()) html += `<p>${inline(l)}</p>`
    i++
  }
  return html
}

function agregar(el) { hilo.appendChild(el); log.scrollTop = log.scrollHeight; return el }
function div(cls, html) { const d = document.createElement("div"); d.className = cls; d.innerHTML = html; return d }

function resumen(r) {
  if (!r || typeof r !== "object") return ""
  if (!r.ok) return "✗ " + String(r.error || "").slice(0, 140)
  const d = r.data || {}
  if ("apta" in d) return `apta=${d.apta} · bloqueos=${(d.bloqueos||[]).map((b)=>b.regla).join(",")||"—"} · confirmaciones=${(d.confirmaciones||[]).map((c)=>c.regla).join(",")||"—"} · retroactiva=${d.retroactiva}`
  if ("numero_oc" in d) return `OC ${d.numero_oc}${d.idempotente ? " (idempotente)" : ""}`
  if ("orden" in d) return `payload listo · ${d.ruta_trazabilidad}`
  if ("sha256" in d) return `${d.ruta} · sha256 ${String(d.sha256).slice(0, 12)}…`
  if ("solicitud" in d) return `${d.solicitud.solicitud_id} · faltantes: ${(d.faltantes||[]).join(",")||"—"}`
  return "ok"
}

function pintarHerramienta(t) {
  const d = document.createElement("details"); d.className = "tool " + (t.ok ? "ok" : "err")
  d.innerHTML = `<summary>🔧 <strong>${esc(t.nombre)}</strong> — ${esc(resumen(t.resultado))} <small>(${t.ms} ms)</small></summary><pre>args: ${esc(JSON.stringify(t.args, null, 2))}</pre><pre>resultado: ${esc(JSON.stringify(t.resultado, null, 2))}</pre>`
  agregar(d)
}

function pintarAgente(texto, needs, pendiente) {
  agregar(div("msg bot" + (needs ? " confirm" : ""), md(texto)))
  if (needs) {
    const caso = pendiente && pendiente.caso ? pendiente.caso : "este caso"
    const b = agregar(div("banner", `<strong>⚠️ Confirmación humana requerida para ${esc(caso)}.</strong> La OC no se crea hasta que confirmes en tu siguiente mensaje.<div class="acciones"><button type="button" data-r="si">Confirmo, créala</button><button type="button" class="no" data-r="no">No, no la crees</button></div>`))
    b.querySelectorAll("button").forEach((btn) => btn.addEventListener("click", () => {
      b.querySelectorAll("button").forEach((x) => (x.disabled = true))
      enviar(btn.dataset.r === "si" ? `Confirmo, crea la OC de ${caso}.` : `No, no crees la OC de ${caso}.`)
    }))
  }
}

async function enviar(texto) {
  if (!texto.trim()) return
  agregar(div("msg user", esc(texto)))
  const pensando = agregar(div("thinking", "El agente está pensando…"))
  input.disabled = enviarBtn.disabled = true
  try {
    const r = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, message: texto }) })
    const data = await r.json().catch(() => ({ error: "Respuesta inválida del servidor" }))
    pensando.remove()
    if (!r.ok) return void agregar(div("msg bot confirm", "⚠️ " + esc(data.error || "Error " + r.status)))
    ;(data.toolCalls || []).forEach(pintarHerramienta)
    pintarAgente(data.reply, data.needsConfirmation, data.pendiente)
  } catch (e) {
    pensando.remove(); agregar(div("msg bot confirm", "⚠️ No pude contactar al servidor. Revisa tu conexión e intenta de nuevo."))
  } finally { input.disabled = enviarBtn.disabled = false; input.focus() }
}

document.getElementById("form").addEventListener("submit", (e) => { e.preventDefault(); const t = input.value; input.value = ""; enviar(t) })
document.querySelectorAll(".chips button").forEach((b) => b.addEventListener("click", () => enviar(b.dataset.p)))
document.getElementById("nueva").addEventListener("click", () => { sessionId = nuevaId(); location.reload() })

async function restaurar() {
  try {
    const h = await (await fetch("/api/health")).json()
    document.getElementById("estado").textContent = `Modelo: ${h.provider} / ${h.model} · SAP simulado`
  } catch { document.getElementById("estado").textContent = "Servidor no disponible" }
  const r = await fetch(`/api/sessions/${sessionId}`); if (!r.ok) return
  const s = await r.json()
  for (const ev of s.eventos) {
    if (ev.tipo === "usuario") agregar(div("msg user", esc(ev.texto)))
    if (ev.tipo === "herramienta") pintarHerramienta(ev.llamada)
    if (ev.tipo === "agente") agregar(div("msg bot" + (ev.needsConfirmation ? " confirm" : ""), md(ev.texto)))
  }
}
restaurar()
