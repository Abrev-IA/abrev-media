#!/usr/bin/env node
// Rotina mensal de artes: para cada card do calendário (Trello, lista Rascunho), aciona
// o art_runner (esteira do cockpit) e ANEXA as artes aprovadas ao card. Idempotente:
// pula cards que já têm arte e os de newsletter (são artigo, não arte).
//
// Env: TRELLO_KEY, TRELLO_TOKEN, COCKPIT_* (art_runner). Opcional TRELLO_LIST_RASCUNHO.
// Uso: node --env-file=.env art_routine.mjs [listId]

import { mkdtemp, rm, readFile, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { produceArts } from "./art_runner.mjs";
import { buscarImagem, registrarUso } from "./image_bank.mjs";

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

// Palavras visuais do card: linha "[VISUAL] caminhao, estrada, volume" na descricao.
// Existe porque o titulo do card descreve o ASSUNTO, nao a imagem — e o banco e indexado
// por objeto. Sem isso, a busca compara "5 sinais de alerta" com "caminhao" e erra.
// Ficou na descricao, e nao em campo personalizado, porque o power-up Custom Fields
// esta desabilitado no quadro (a API devolve 403 ao criar o campo e ao habilitar o power-up).
function palavrasVisuais(card) {
  const linha = String(card.desc || "")
    .split(/\r?\n/)
    .find((l) => l.trim().toUpperCase().startsWith("[VISUAL]"));
  return linha ? linha.trim().slice("[VISUAL]".length).trim() : null;
}

function buildBriefing(card, fmt) {
  const caption = (card.desc || "")
    .replace(/\[RASCUNHO[^\]]*\]/gi, "")
    .split(/\r?\n/)
    .filter((l) => !l.trim().toUpperCase().startsWith("[VISUAL]"))
    .join("\n")
    .trim();
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

// ---- Orçamento diário e ritmo até a entrega ----
//
// A cota gratuita da OpenAI é de 250 mil tokens/dia no gpt-4.1, que é o modelo da
// auditoria visual — e ela manda a imagem dentro do prompt, então cada página auditada
// pesa muito em tokens de entrada. Estourar a cota volta a ser cobrado.
//
// IMPORTANTE: esta rotina NÃO mede tokens. Quem gasta é o Worker do cockpit, que não
// devolve consumo. O controle aqui é por ESTIMATIVA de tokens por página, calibrada
// pelo consumo real observado (~669 mil tokens num dia de 50 imagens, ou seja ~13 mil
// por página). Arredondamos para cima: sobrar cota não custa nada, estourar custa.
// Ajuste por variável de ambiente se o consumo real divergir.
const TOKENS_POR_PAGINA = Number(process.env.TOKENS_POR_PAGINA || 15000);
const COTA_DIARIA = Number(process.env.COTA_DIARIA_TOKENS || 250000);
const DIA_ENTREGA = Number(process.env.DIA_ENTREGA || 20);
const ESTADO = new URL(".estado_diario.json", import.meta.url);

const hojeISO = () => new Date().toISOString().slice(0, 10);

async function lerEstado() {
  try {
    const e = JSON.parse(await readFile(ESTADO, "utf8"));
    if (e.dia === hojeISO()) return e;
  } catch { /* primeiro uso ou dia virou: começa zerado */ }
  return { dia: hojeISO(), tokens: 0, paginas: 0 };
}

async function gravarEstado(e) {
  await writeFile(ESTADO, JSON.stringify(e, null, 2));
}

// Quantas páginas fazer hoje: divide o que falta pelos dias que restam até a entrega,
// e nunca passa do que ainda cabe na cota do dia. O ritmo evita dois extremos — fazer
// tudo hoje e estourar a cota, ou fazer de menos e não ficar pronto no dia 20.
function planoDoDia(paginasRestantes, estado) {
  const hoje = new Date().getDate();
  const diasRestantes = Math.max(1, DIA_ENTREGA - hoje);
  const porRitmo = Math.ceil(paginasRestantes / diasRestantes);
  const porCota = Math.max(0, Math.floor((COTA_DIARIA - estado.tokens) / TOKENS_POR_PAGINA));
  return { permitido: Math.min(porRitmo, porCota), porRitmo, porCota, diasRestantes, hoje };
}

async function run(listId = LIST_RASCUNHO, { dryRun = false, refazer = false } = {}) {
  const cards = await trello(`/lists/${listId}/cards`, { fields: "name,desc", attachments: "true", attachment_fields: "name,isUpload" });
  console.log(`${cards.length} card(s) em Rascunho.${dryRun ? "  [DRY-RUN: nada é gerado, nenhum crédito gasto]" : ""}${refazer ? "  [REFAZER: substitui a arte existente]" : ""}`);
  const summary = [];
  let temaConferido = false, interrompido = null;

  // Páginas que ainda faltam, para o ritmo saber o tamanho do que resta.
  const paginasPendentes = cards.reduce((total, c) => {
    const f = parseFormat(c.name);
    if (f.skip) return total;
    const temArte = (c.attachments || []).some((a) => a.isUpload && /.png$/i.test(a.name || ""));
    if (temArte && !refazer) return total;
    return total + f.paginas;
  }, 0);
  const estado = await lerEstado();
  const plano = planoDoDia(paginasPendentes, estado);
  let paginasHoje = 0;
  console.log(
    `ritmo: ${plano.permitido} pág. hoje (faltam ${paginasPendentes} em ${plano.diasRestantes} dia(s) até o dia ${DIA_ENTREGA}; ` +
    `cota deixa ${plano.porCota}, ritmo pede ${plano.porRitmo}). Já usados hoje: ${estado.paginas} pág. ~${estado.tokens} tokens.`,
  );
  if (!dryRun && plano.permitido <= 0) {
    console.log("Cota do dia esgotada. Rode de novo amanhã — os cards prontos são pulados.");
    return;
  }

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

    // Para quando o ritmo do dia se esgota. Não é falha: o lote continua amanhã,
    // e os cards já prontos são pulados automaticamente.
    if (paginasHoje + fmt.paginas > plano.permitido) {
      interrompido = `Ritmo do dia cumprido (${paginasHoje} de ${plano.permitido} página(s)). `
        + `Faltam ${paginasPendentes - paginasHoje} página(s) para ${plano.diasRestantes} dia(s) até o dia ${DIA_ENTREGA}. `
        + `Rode de novo amanhã — os cards prontos são pulados.`;
      break;
    }
    console.log("GERANDO:", card.name);
    const dir = await mkdtemp(join(tmpdir(), "abrev-art-"));
    try {
      // Limiar 2 de proposito: o titulo do card quase nao tem palavra que descreva
      // imagem, entao uma palavra em comum e coincidencia, nao acerto. Servir imagem
      // errada e pior que gerar uma nova.
      // Camada 1: banco local. Se acharmos foto do tema, ela sobe como midia de apoio
      // e a esteira usa em vez de gerar — mesma auditoria, sem custo de imagem.
      // Camada 2 (dentro do cockpit): banco no R2 com os sujeitos ja pagos.
      // Camada 3: geracao nova, que e a unica que custa.
      const briefing = buildBriefing(card, fmt);
      const visual = palavrasVisuais(card);
      const consulta = visual || `${card.name} ${briefing.objetivo}`;
      const achado = await buscarImagem(consulta, { minimo: visual ? 1 : 2 }).catch(() => null);
      if (achado) {
        briefing.midia = achado.arquivo;
        console.log(`  banco: reaproveitando ${achado.meta.arquivo} (score ${achado.score}, por ${visual ? "palavras visuais" : "titulo"})`);
      } else {
        console.log(`  banco: nada no tema${visual ? "" : " (card sem [VISUAL])"}, a esteira vai gerar`);
      }
      const { runId, files } = await produceArts(briefing, dir);
      if (achado) await registrarUso(achado.arquivo).catch(() => {});
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
      paginasHoje += fmt.paginas;
      estado.paginas += fmt.paginas;
      estado.tokens += fmt.paginas * TOKENS_POR_PAGINA;
      await gravarEstado(estado);
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
