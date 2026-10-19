#!/usr/bin/env node
// Rotina mensal de artes: para cada card do calendário (Trello, lista Rascunho), aciona
// o art_runner (esteira do cockpit) e ANEXA as artes aprovadas ao card. Idempotente:
// pula cards que já têm arte e os de newsletter (são artigo, não arte).
//
// Env: TRELLO_KEY, TRELLO_TOKEN, COCKPIT_* (art_runner). Opcional TRELLO_LIST_RASCUNHO.
// Uso: node --env-file=.env art_routine.mjs [listId]

import { mkdtemp, rm, readFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { produceArts } from "./art_runner.mjs";

const T = "https://api.trello.com/1";
const LIST_RASCUNHO = process.env.TRELLO_LIST_RASCUNHO || "6ad43ed930b50a2b6519bdf7";

function tauth() {
  const key = process.env.TRELLO_KEY, token = process.env.TRELLO_TOKEN;
  if (!key || !token) throw new Error("TRELLO_KEY/TRELLO_TOKEN ausentes (.env).");
  return { key, token };
}
async function trello(path, params = {}, method = "GET") {
  const { key, token } = tauth();
  const qs = new URLSearchParams({ ...params, key, token });
  const res = await fetch(`${T}${path}?${qs}`, { method });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Trello ${method} ${path} ${res.status}: ${JSON.stringify(j)}`);
  return j;
}

function parseFormat(name) {
  const n = name.toLowerCase();
  if (n.includes("newsletter")) return { skip: true, reason: "newsletter (artigo, sem arte)" };
  if (n.includes("carrossel")) return { formatos: ["Carrossel"], paginas: 3 };
  if (n.includes("reel")) return { formatos: ["Post estático"], paginas: 1, cover: true }; // capa do reel
  return { formatos: ["Post estático"], paginas: 1 };
}

function buildBriefing(card, fmt) {
  const caption = (card.desc || "").replace(/\[RASCUNHO[^\]]*\]/gi, "").trim();
  const tema = card.name.replace(/^\d{2}\/\d{2}\s*·\s*[^·]+·\s*/, "").trim();
  return {
    objetivo: `${tema}. ${caption}`.slice(0, 650),
    canais: ["Instagram", "LinkedIn"],
    formatos: fmt.formatos,
    fonte: "Posicionamento institucional da ABREV sobre logística reversa no varejo; custo setorial ~R$ 59 bi (cobertura Estadão/Brasil Inovador, set/2026). Só dados públicos; não inventar estatísticas/datas. Tom executivo B2B, editorial e cativante. Logo oficial ABREV. ARTE NO TEMA ESCURO: usar theme dark (fundo azul petróleo da identidade, texto claro, bloco de informações escuro). Não usar fundo branco.",
    dimensoes: "1024x1024",
    paginas: fmt.paginas,
  };
}

// Confere se a arte saiu mesmo no tema escuro, amostrando os quatro cantos (onde o fundo
// aparece limpo: a placa do logo e o bloco de informações começam a 64px da borda).
// É a guarda do lote: se o tema dark ainda não estiver publicado no cockpit, paramos no
// primeiro card em vez de gerar o mês inteiro em branco e queimar o crédito.
// Devolve true/false, ou null quando não dá para conferir (o workflow do cron não instala
// dependências, então lá o puppeteer não existe — nesse caso seguimos sem a guarda em vez
// de derrubar a rotina mensal inteira).
async function isDarkArt(file) {
  let puppeteer;
  try { puppeteer = (await import("puppeteer")).default; } catch { return null; }
  const uri = "data:image/png;base64," + (await readFile(file)).toString("base64");
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    return await page.evaluate(async (u) => {
      const img = new Image();
      img.src = u;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const pts = [[6, 6], [img.width - 6, 6], [6, img.height - 6], [img.width - 6, img.height - 6]];
      const escuros = pts.filter(([x, y]) => {
        const d = ctx.getImageData(x, y, 1, 1).data;
        return 0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2] < 110;
      });
      return escuros.length >= 3;
    }, uri);
  } finally { await browser.close(); }
}

async function attachToCard(cardId, filePath, name) {
  const { key, token } = tauth();
  const form = new FormData();
  form.set("file", new Blob([await readFile(filePath)], { type: "image/png" }), name);
  const res = await fetch(`${T}/cards/${cardId}/attachments?key=${key}&token=${token}`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`attach ${res.status}`);
}

async function run(listId = LIST_RASCUNHO, { dryRun = false, refazer = false } = {}) {
  const cards = await trello(`/lists/${listId}/cards`, { fields: "name,desc", attachments: "true", attachment_fields: "name,isUpload" });
  console.log(`${cards.length} card(s) em Rascunho.${dryRun ? "  [DRY-RUN: nada é gerado, nenhum crédito gasto]" : ""}${refazer ? "  [REFAZER: substitui a arte existente]" : ""}`);
  const summary = [];
  let temaConferido = false, interrompido = null;

  for (const card of cards) {
    const fmt = parseFormat(card.name);
    const artesAntigas = (card.attachments || []).filter((a) => a.isUpload && /\.png$/i.test(a.name || ""));
    if (fmt.skip) { console.log("PULA:", card.name, "—", fmt.reason); summary.push(`SKIP  ${card.name}`); continue; }
    // Retomada: card que já tem arte foi feito numa execução anterior.
    if (artesAntigas.length && !refazer) { console.log("JÁ TEM ARTE:", card.name); summary.push(`TEM   ${card.name}`); continue; }
    if (dryRun) {
      const troca = artesAntigas.length ? ` (substitui ${artesAntigas.length} arte(s) atual(is))` : "";
      console.log("GERARIA:", card.name, `— ${fmt.formatos.join("/")}, ${fmt.paginas} pág.${troca}`);
      summary.push(`FARIA ${card.name}${troca}`);
      continue;
    }

    console.log("GERANDO:", card.name);
    const dir = await mkdtemp(join(tmpdir(), "abrev-art-"));
    try {
      const { runId, files } = await produceArts(buildBriefing(card, fmt), dir);
      // Guarda do tema: confere a primeira arte do lote ANTES de anexar qualquer coisa.
      if (!temaConferido && files.length) {
        temaConferido = true;
        const escuro = await isDarkArt(files[0].file);
        if (escuro === null) console.log("  (puppeteer indisponível: guarda do tema desativada)");
        else if (!escuro) {
          await copyFile(files[0].file, "arte-clara-abortada.png").catch(() => {});
          interrompido = "A primeira arte saiu com FUNDO CLARO: o tema dark ainda não está publicado no cockpit. Lote interrompido antes de anexar nada (amostra em arte-clara-abortada.png).";
          break;
        } else console.log("  tema escuro confirmado.");
      }
      for (let i = 0; i < files.length; i++) {
        await attachToCard(card.id, files[i].file, `${card.name.replace(/[^\w]+/g, "_").slice(0, 40)}_dark_p${String(i + 1).padStart(2, "0")}.png`);
      }
      // Só agora remove a arte antiga: o card nunca fica sem arte no meio do caminho.
      let removidas = 0;
      if (refazer) {
        for (const a of artesAntigas) {
          await trello(`/cards/${card.id}/attachments/${a.id}`, {}, "DELETE").then(() => removidas++).catch(() => {});
        }
      }
      await trello(`/cards/${card.id}/actions/comments`, { text: `🎨 ${files.length} arte(s) no tema escuro geradas pela esteira do cockpit (run ${runId}).${removidas ? ` Versão anterior removida (${removidas}).` : ""}` }, "POST");
      console.log("  OK —", files.length, "arte(s) anexada(s)." + (removidas ? ` ${removidas} antiga(s) removida(s).` : ""));
      summary.push(`OK(${files.length}) ${card.name}`);
    } catch (e) {
      // Crédito esgotado é terminal: insistir nos próximos cards só gera erro em série.
      if (/[Cc]rédito da API|credit_balance_exhausted|HTTP 429/.test(e.message)) {
        interrompido = "Crédito da API do cockpit esgotado. Recarregue e rode de novo — os cards já prontos são pulados automaticamente.";
        break;
      }
      console.error("  ERRO:", e.message);
      await trello(`/cards/${card.id}/actions/comments`, { text: `⚠️ Falha ao gerar arte: ${e.message.slice(0, 200)}` }, "POST").catch(() => {});
      summary.push(`ERRO  ${card.name} :: ${e.message.slice(0, 80)}`);
    } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
  }

  console.log("\n=== RESUMO ===");
  for (const s of summary) console.log(s);
  if (interrompido) {
    console.log("\n*** LOTE INTERROMPIDO ***\n" + interrompido);
    process.exitCode = 2;
  }
}

// --dry-run: lista o que faria, sem gerar nada nem gastar crédito.
// --refazer: regera mesmo nos cards que já têm arte e remove a versão antiga DEPOIS
//            de anexar a nova (usado para trocar o mês inteiro para o tema escuro).
const args = process.argv.slice(2);
run(args.find((a) => !a.startsWith("--")), {
  dryRun: args.includes("--dry-run"),
  refazer: args.includes("--refazer"),
}).catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
