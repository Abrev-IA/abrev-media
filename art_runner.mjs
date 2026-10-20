#!/usr/bin/env node
// art_runner — aciona a esteira do cockpit (Conteúdo e Publicação) via API e traz as
// artes auditadas (PNG). É a ponte que deixa a criação das artes automática: a rotina
// chama produceArts(briefing) por card do calendário, sem UI.
//
// Esteira no cockpit: cria run (conteudo) -> start (Conteúdo -> Auditor -> Arte ->
// Auditoria visual) -> se a composição interromper ("sem espaço seguro"), revise com
// "encurtar/consolidar" -> baixa os PNGs aprovados.
//
// Env (.env local ou secrets do GitHub Actions):
//   COCKPIT_BASE      default https://abrev-cockpit.administradorabrev.workers.dev
//   COCKPIT_USER      usuário do cockpit
//   COCKPIT_PASSWORD  senha do cockpit
//
// Uso (CLI de teste — roda 1 peça e salva os PNGs):
//   node --env-file=.env art_runner.mjs sample [pastaSaida]
//   node --env-file=.env art_runner.mjs run '<briefing JSON>' [pastaSaida]
// briefing JSON: {objetivo, canais:[], formatos:[], fonte, dimensoes?, paginas?}

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const BASE = (process.env.COCKPIT_BASE || "https://abrev-cockpit.administradorabrev.workers.dev").replace(/\/$/, "");

function cfg() {
  const user = process.env.COCKPIT_USER, password = process.env.COCKPIT_PASSWORD;
  if (!user || !password) throw new Error("COCKPIT_USER/COCKPIT_PASSWORD ausentes (.env).");
  return { user, password };
}

// ---- Auth: devolve o header Cookie da sessão ----
export async function login() {
  const { user, password } = cfg();
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user, password }),
  });
  if (!res.ok) throw new Error(`login ${res.status}: ${JSON.stringify(await res.json().catch(() => ({})))}`);
  const set = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith("abrev_cockpit_session="))
    || res.headers.get("set-cookie");
  if (!set) throw new Error("login sem cookie de sessão.");
  return set.split(";")[0]; // "abrev_cockpit_session=...."
}

// ---- Briefing -> payload do cockpit (índices do fluxo conteudo) ----
// 0 Objetivo · 1 Canais · 2 Formatos · 3 Fonte técnica · 4 Mídia · 5 Dimensões · 6 Páginas
// Orientação de composição embutida em todo briefing: a arte tem espaço limitado, então
// o Copywriter já entrega textos enxutos. É DIRECIONAL de propósito — com limites numéricos
// ("no máximo 45 caracteres") o Auditor passa a medir a arte contra eles e reprova peças boas,
// e cada reprovação gera uma imagem nova (crédito). Sem números, ele julga legibilidade.
const COMPOSITION_HINT =
  " ORIENTAÇÃO DE REDAÇÃO (guia de escrita, não é critério de reprovação): o espaço da arte é" +
  " limitado, então escreva enxuto — título curto e forte, subtítulo direto, e no máximo duas" +
  " informações por página, preservando os fatos (ex.: R$ 59 bi). Priorize legibilidade e respiro;" +
  " o Designer ajusta a quebra de linhas conforme a composição.";

// Quando sobe uma foto do banco, o Designer precisa saber que ela e PARA USAR, nao uma
// referencia de composicao a imitar. Sem isso ele tende a gerar imagem nova do zero.
const REFERENCE_HINT =
  " IMAGEM ANEXADA: a foto enviada como midia de apoio e o conteudo grafico desta peca." +
  " Use graphicMode 'reference' e preserve essa fotografia; NAO gere imagem nova." +
  " Componha o texto ao redor dela e escolha o tema de fundo que melhor a valoriza.";

function toPayload(b) {
  const payload = {
    0: (b.objetivo || "") + COMPOSITION_HINT + (b.midia ? REFERENCE_HINT : ""),
    1: (b.canais || ["Instagram", "LinkedIn"]).join("\n"),
    2: (b.formatos || ["Carrossel"]).join("\n"),
    3: (b.fonte || "") + COMPOSITION_HINT,
  };
  if (["1024x1024", "1024x1536", "1536x1024"].includes(b.dimensoes)) payload[5] = b.dimensoes;
  if (b.paginas) payload[6] = String(b.paginas);
  return payload;
}

// Resposta padrão para a triagem — mantém a autonomia sem inventar dados.
const AUTO_ANSWER =
  "Use o próprio tema/objetivo deste briefing como base e derive daí o título (curto) e a mensagem. " +
  "Dados: apenas os já públicos da ABREV citados no briefing (logística reversa no varejo; custo setorial ~R$ 59 bilhões/ano no e-commerce); " +
  "NÃO inventar números, datas ou fatos novos — se um dado específico não estiver no briefing, omita. " +
  "Escopo: logística reversa no varejo, tom executivo B2B. O Designer decide a composição e a imagem.";

async function createRun(cookie, briefing) {
  let answers = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const payload = toPayload(briefing);
    if (answers) payload[99] = answers;
    const form = new FormData();
    form.set("flowKey", "conteudo");
    form.set("payload", JSON.stringify(payload));
    // Midia de apoio: quando o briefing traz uma foto do banco local, ela sobe junto
    // com o run. O Designer entao usa graphicMode "reference" e a esteira NAO gera
    // imagem nova — e a economia, sem abrir mao da auditoria.
    if (briefing.midia) {
      const buf = await readFile(briefing.midia);
      const ext = briefing.midia.toLowerCase().split(".").pop();
      const tipo = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      const nome = briefing.midia.split(/[\/]/).pop();
      form.set("file", new Blob([buf], { type: tipo }), nome);
    }
    const res = await fetch(`${BASE}/api/workflows`, { method: "POST", headers: { cookie }, body: form });
    const json = await res.json().catch(() => ({}));
    if (res.status === 422 && json.needsInformation) {
      // responde a triagem e reenvia (campo 99 = respostas complementares)
      answers += (answers ? "\n" : "") + json.questions.map((q) => `P: ${q.question}\nR: ${AUTO_ANSWER}`).join("\n");
      continue;
    }
    if (!res.ok) throw new Error(`createRun ${res.status}: ${JSON.stringify(json)}`);
    return json.run.id;
  }
  throw new Error("Triagem continuou pedindo esclarecimentos após respostas automáticas.");
}

// Roda um PATCH (start|revise) lendo o stream ndjson até o resultado final.
async function runStream(cookie, id, body, timeoutMs = 900000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/api/workflows/${id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok && res.headers.get("content-type")?.includes("json")) {
      throw new Error(`run ${res.status}: ${JSON.stringify(await res.json())}`);
    }
    let buf = "", result = null;
    const dec = new TextDecoder();
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === "result") result = ev;
      }
    }
    return result;
  } finally { clearTimeout(t); }
}

async function getRun(cookie, id) {
  const res = await fetch(`${BASE}/api/workflows/${id}`, { headers: { cookie } });
  if (!res.ok) throw new Error(`getRun ${res.status}`);
  return res.json();
}

// Crédito esgotado é terminal: reenviar só queima chamadas sem chance de sucesso.
function creditError(events) {
  return (events || []).some((e) => /credit_balance_exhausted|HTTP 429/i.test(e.detail || ""));
}

// Motivo real da reprovação: sai do parecer do Auditor visual, NUNCA do texto dos eventos.
// Ler os eventos fazia o runner reencontrar o próprio feedback que acabara de escrever
// (ele cita "espaço seguro") e reiniciar o fluxo em cascata, gerando imagens a cada volta.
function lastVisualRejection(artifacts) {
  for (const a of [...(artifacts || [])].reverse()) {
    if (a.artifactType !== "AUDITOR_VISUAL") continue;
    try {
      const p = JSON.parse(a.content);
      if (p.approved === false) return p.reason || null;
    } catch {}
  }
  return null;
}

// Garante a aprovação: start e, se o Auditor visual devolver, uma única revisão.
// O limite é curto de propósito — cada revise refaz o fluxo inteiro e gera imagens novas,
// e a esteira já tenta 3 versões internamente antes de devolver.
async function ensureApproved(cookie, id, maxRevise = 1) {
  await runStream(cookie, id, { action: "start" });
  for (let i = 0; i <= maxRevise; i++) {
    const { run, events, artifacts } = await getRun(cookie, id);
    if (run.status === "APROVADO") return true;
    if (creditError(events)) throw new Error("Crédito da API do cockpit esgotado (HTTP 429) — recarregue antes de rodar de novo.");
    if (i === maxRevise) return false;
    const reason = lastVisualRejection(artifacts);
    if (run.status !== "ERRO" || !reason) return false;
    const feedback =
      "O Auditor visual devolveu a peça com este parecer: " +
      reason.replace(/\s+/g, " ").slice(0, 300) +
      " Reescreva o texto mais enxuto para caber com folga, preservando os fatos essenciais " +
      "(ex.: o dado de R$ 59 bi). Mantenha o tom executivo.";
    await runStream(cookie, id, { action: "revise", feedback });
  }
  return false;
}

// Lista as artes aprovadas (ARTE_PNG com approved=true), em ordem de página.
export async function listApprovedArts(cookie, id) {
  const { artifacts } = await getRun(cookie, id);
  return artifacts
    .filter((a) => a.artifactType === "ARTE_PNG")
    .map((a) => ({ artifactId: a.id, title: a.title, meta: JSON.parse(a.content) }))
    .filter((a) => a.meta.approved === true)
    .sort((a, b) => (a.title || "").localeCompare(b.title || "", "pt"));
}

export async function downloadArt(cookie, id, artifactId, outPath) {
  const res = await fetch(`${BASE}/api/workflows/${id}/artifacts/${artifactId}?download=1`, { headers: { cookie } });
  if (!res.ok) throw new Error(`downloadArt ${res.status}`);
  await writeFile(outPath, Buffer.from(await res.arrayBuffer()));
  return outPath;
}

// Pipeline completo: loga, cria, roda (com loop de ajuste), baixa os PNGs aprovados.
export async function produceArts(briefing, outDir = ".") {
  const cookie = await login();
  const id = await createRun(cookie, briefing);
  const ok = await ensureApproved(cookie, id);
  if (!ok) throw new Error(`run ${id} não foi aprovado pela esteira (veja o protocolo no cockpit).`);
  const arts = await listApprovedArts(cookie, id);
  await mkdir(outDir, { recursive: true });
  const files = [];
  for (let i = 0; i < arts.length; i++) {
    const out = join(outDir, `${id}-p${String(i + 1).padStart(2, "0")}.png`);
    await downloadArt(cookie, id, arts[i].artifactId, out);
    files.push({ title: arts[i].title, file: out });
  }
  return { runId: id, files };
}

// Modo teste barato: 1 peça, 1 página, SEM o loop externo de revise — baixa o que saiu
// (aprovado ou não) só para validar o visual. Não dá para garantir exatamente 1 imagem:
// a esteira tenta até 3 versões internamente antes de devolver. O que isso corta é o
// multiplicador externo (cada revise reiniciava o fluxo e gerava imagens de novo).
export async function produceOne(briefing, outDir = ".") {
  const cookie = await login();
  const id = await createRun(cookie, { ...briefing, formatos: ["Post estático"], paginas: 1 });
  await runStream(cookie, id, { action: "start" });
  const { run, events, artifacts } = await getRun(cookie, id);
  if (creditError(events)) throw new Error("Crédito da API do cockpit esgotado (HTTP 429) — recarregue antes de rodar de novo.");
  const arts = (artifacts || []).filter((a) => a.artifactType === "ARTE_PNG");
  if (!arts.length) throw new Error(`run ${id} não gerou nenhuma arte (status ${run.status}).`);
  await mkdir(outDir, { recursive: true });
  const files = [];
  for (let i = 0; i < arts.length; i++) {
    let approved = false;
    try { approved = JSON.parse(arts[i].content).approved === true; } catch {}
    const out = join(outDir, `${id}-v${String(i + 1).padStart(2, "0")}${approved ? "-ok" : ""}.png`);
    await downloadArt(cookie, id, arts[i].id, out);
    files.push({ file: out, approved });
  }
  return { runId: id, status: run.status, files };
}

// ---- CLI ----
if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const [cmd, a, b] = process.argv.slice(2);
  const sample = {
    objetivo: "Abrir novembro posicionando a logística reversa como parte do planejamento do varejo antes do pico (Black Friday). Devoluções e trocas precisam entrar no calendário agora.",
    canais: ["Instagram", "LinkedIn"],
    formatos: ["Carrossel"],
    fonte: "Posicionamento ABREV sobre logística reversa; custo setorial ~R$ 59 bi (cobertura Estadão/Brasil Inovador, set/2026). Só dados públicos; não inventar. Tom executivo B2B, editorial e cativante.",
    dimensoes: "1024x1024",
    paginas: 3,
  };
  try {
    const brief = cmd === "run" ? JSON.parse(a) : sample;
    const outDir = (cmd === "run" ? b : a) || "./artes_teste";
    console.log("Acionando a esteira do cockpit...");
    const r = await produceArts(brief, outDir);
    console.log("OK run " + r.runId + " — artes:");
    for (const f of r.files) console.log(" -", f.title, "->", f.file);
  } catch (e) {
    console.error("ERRO:", e.message);
    process.exit(1);
  }
}
