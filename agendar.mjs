#!/usr/bin/env node
// Agendamento: move as pautas aprovadas de "Rascunho" para "Agendado", que é a única
// lista que o publisher olha. PÕE A DATA E A HORA de cada uma. Inclui as STORIES junto
// do post que elas apoiam.
//
// POR QUE EXISTE: este passo não existia. O cronograma criava os cards, a esteira fazia
// as artes, o e-mail pedia aprovação — e aí alguém tinha que arrastar card a card no
// Trello. Ninguém arrastou em novembro/2026, e o mês inteiro não publicou pelo pipeline
// (as 7 publicações que saíram foram agendadas na mão pelo Business Suite, fora dele).
//
// POR QUE ELE PÕE A DATA: o cronograma.mjs cria os cards SEM `due`, de propósito —
// "cartão sem data em Rascunho é a trava que impede este script de publicar nada". A
// etapa que põe a data é a aprovação. Antes ela era à mão (36 datas digitadas por mês);
// agora é aqui, e SÓ para card com a etiqueta de aprovação. A trava continua: nada ganha
// data sem aprovação. O que mudou é quem digita.
//
// A STORY VIAJA COM O POST. Um card "DD/MM · Stories · apoio ao X" não é peça solta: é
// apoio do post do mesmo dia. Ou os dois vão, ou nenhum vai — story publicada sem o post
// que ela anuncia manda a pessoa para um feed onde não há nada novo. A exceção é a story
// que anuncia a newsletter: newsletter não vai ao feed, então a story vai sozinha.
//
// Uso: node --env-file=.env agendar.mjs --dry-run     # mostra o que faria
//      node --env-file=.env agendar.mjs               # agenda
//      node --env-file=.env agendar.mjs --mes=12      # só dezembro
//      node --env-file=.env agendar.mjs --sem-portao --dry-run   # confere ignorando o prazo

import { parseArgs } from "node:util";
import { HORARIO_PECA, HORARIO_STORY, BRT_PARA_UTC, PRAZO_OBJECAO_DIA, ETIQUETA_OBJECAO, ETIQUETA_APROVADO } from "./calendario_regras.mjs";

const T = "https://api.trello.com/1";
const LISTS = {
  rascunho: process.env.TRELLO_LIST_RASCUNHO || "6ad43ed930b50a2b6519bdf7",
  agendado: process.env.TRELLO_LIST_AGENDADO || "6ad43edadd2cc201e4b79182",
};

// Horários vêm do módulo único de regras, compartilhado com o feed do calendário. Ver
// calendario_regras.mjs — mudou a regra? Muda lá.
function tauth() {
  const key = process.env.TRELLO_KEY, token = process.env.TRELLO_TOKEN;
  if (!key || !token) throw new Error("TRELLO_KEY/TRELLO_TOKEN ausentes (.env).");
  return { key, token };
}

async function trello(path, { method = "GET", params = {} } = {}) {
  const { key, token } = tauth();
  const res = await fetch(`${T}${path}?${new URLSearchParams({ ...params, key, token })}`, { method });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Trello ${method} ${path} ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

// APROVAÇÃO TÁCITA (decisão do Alan, 22/11/2026). Sem manifestação, a pauta está
// aprovada. O que segura uma pauta é a OBJEÇÃO, não a falta de aval:
//   - etiqueta "Ajustar"  -> segurada, sempre (alguém discordou)
//   - etiqueta "Aprovado" -> liberada já, antes do prazo (atalho opcional)
//   - nenhuma das duas    -> liberada quando o prazo de manifestação acaba
// O prazo é o que torna "silêncio aprova" seguro: sem ele, a pauta estaria aprovada no
// instante em que o card existe, e ninguém teria tempo de discordar.
const temEtiqueta = (c, nome) => (c.labels || []).some((l) => (l.name || "").trim().toLowerCase() === nome.toLowerCase());

// Fim do prazo para as pautas do mês M: fim do dia PRAZO_OBJECAO_DIA do mês M-1, em
// Brasília. "Até o dia 25" inclui o dia 25 inteiro; a liberação é a 00h do dia 26.
function fimDoPrazo(card, agora = new Date()) {
  const m = (card.name || "").match(/^\d{2}\/(\d{2})/);
  if (!m) return null;
  const mm = Number(m[1]);
  const mesAtual = agora.getUTCMonth() + 1;
  const ano = agora.getUTCFullYear() + (mm < mesAtual - 6 ? 1 : 0);
  // mês anterior ao da pauta (janeiro -> dezembro do ano anterior)
  const anoPrazo = mm === 1 ? ano - 1 : ano;
  const mesPrazo = mm === 1 ? 12 : mm - 1;
  return new Date(Date.UTC(anoPrazo, mesPrazo - 1, PRAZO_OBJECAO_DIA + 1, BRT_PARA_UTC, 0));
}

// Devolve null quando a pauta está liberada, ou o motivo de estar segurada.
function segura(card, { semPrazo = false } = {}) {
  if (temEtiqueta(card, ETIQUETA_OBJECAO)) return `objeção registrada (etiqueta "${ETIQUETA_OBJECAO}")`;
  if (temEtiqueta(card, ETIQUETA_APROVADO)) return null;
  if (semPrazo) return null;
  const fim = fimDoPrazo(card);
  if (fim && Date.now() < fim.getTime()) {
    return `prazo de manifestação aberto até ${String(PRAZO_OBJECAO_DIA).padStart(2, "0")}/${fim.toISOString().slice(5, 7)}`;
  }
  return null;
}

const ehStory = (c) => /·\s*stories\s*·/i.test(c.name || "");
// O formato é o SEGUNDO campo do título ("DD/MM · Formato · Tema"). Procurar no nome
// inteiro confundia a story que ANUNCIA a newsletter com a newsletter.
const formatoDoCard = (c) => ((c.name || "").split("·")[1] || "").trim();
const temaDoCard = (c) => ((c.name || "").split("·").slice(2).join("·") || "").trim();
const ehNewsletter = (c) => /newsletter/i.test(formatoDoCard(c));
const temArte = (c) => (c.attachments || []).some((a) => a.isUpload && /\.(png|jpe?g|mp4)$/i.test(a.name || ""));
const diaDoCard = (c) => (c.name.match(/^(\d{2}\/\d{2})/) || [])[1] || null;

// "reel+card" antes de "reel": senão todo Reel+Card vira Reel.
function tipoBase(texto) {
  const t = String(texto || "").toLowerCase();
  if (/reel\s*\+\s*card/.test(t)) return "reel+card";
  if (/\breel\b/.test(t)) return "reel";
  if (/carrossel/.test(t)) return "carrossel";
  if (/newsletter/.test(t)) return "newsletter";
  return null;
}

// O que a story apoia está no tema: "apoio ao Carrossel ...", "apoio à Newsletter ...".
const apoiaQue = (story) => tipoBase(temaDoCard(story));

// DD/MM do título + horário da tabela, em UTC. O ano é o corrente, exceto quando o mês do
// card fica muito para trás do atual — é a virada: cards de janeiro montados em dezembro.
// Mês passado NÃO vira o ano seguinte; vira data vencida, e o card é reprovado por isso.
function dueDaTabela(card, agora = new Date()) {
  const dia = diaDoCard(card);
  if (!dia) return null;
  const [dd, mm] = dia.split("/").map(Number);
  const hora = ehStory(card) ? HORARIO_STORY[apoiaQue(card)] : HORARIO_PECA[tipoBase(formatoDoCard(card))];
  if (!hora) return null;
  const [h, m] = hora.split(":").map(Number);
  const mesAtual = agora.getUTCMonth() + 1;
  const ano = agora.getUTCFullYear() + (mm < mesAtual - 6 ? 1 : 0);
  return new Date(Date.UTC(ano, mm - 1, dd, h + BRT_PARA_UTC, m)).toISOString();
}

// Data manual no card vence a tabela: se alguém pôs um horário específico, ele manda.
function horarioDe(card) {
  if (card.due) return { due: card.due, origem: "card" };
  const due = dueDaTabela(card);
  return due ? { due, origem: "tabela" } : { due: null, origem: null };
}

// O que impede um card de ser agendado. Devolve null quando está pronto.
function reprova(card, parceiro, opcoes) {
  const motivo = segura(card, opcoes);
  if (motivo) return motivo;
  if (ehNewsletter(card)) return "newsletter não publica no Instagram";
  if (!temArte(card)) return "sem arte anexada";
  const { due } = horarioDe(card);
  if (!due) return `formato sem horário na tabela ("${formatoDoCard(card)}")`;
  if (new Date(due).getTime() <= Date.now()) return `horário já passou (${due.slice(0, 16).replace("T", " ")} UTC)`;
  if (ehStory(card) && !parceiro && apoiaQue(card) !== "newsletter") return "story sem o post do mesmo dia";
  return null;
}

const brt = (iso) => {
  const d = new Date(new Date(iso).getTime() - BRT_PARA_UTC * 3600e3);
  return `${d.toISOString().slice(8, 10)}/${d.toISOString().slice(5, 7)} ${d.toISOString().slice(11, 16)} BRT`;
};

async function run({ dryRun, mes, semPortao }) {
  const cards = await trello(`/lists/${LISTS.rascunho}/cards`, {
    params: { fields: "name,due,desc,labels", attachments: "true", attachment_fields: "name,isUpload" },
  });

  if (semPortao) console.log("[SEM-PRAZO] ignorando o prazo de manifestação — use só para conferência.");

  let alvo = mes ? cards.filter((c) => (diaDoCard(c) || "").endsWith(`/${String(mes).padStart(2, "0")}`)) : cards;
  console.log(`${alvo.length} card(s)${mes ? ` do mês ${mes}` : ""} em avaliação.${dryRun ? "  [DRY-RUN: nada é movido]" : ""}`);

  // Posts por dia, para a story achar o par. Story não entra: ela é o apoio.
  const posts = new Map();
  for (const c of alvo) if (!ehStory(c) && !ehNewsletter(c)) posts.set(diaDoCard(c), c);

  const vai = [], fica = [];
  for (const card of alvo) {
    const parceiro = ehStory(card) ? posts.get(diaDoCard(card)) : null;
    const motivo = reprova(card, parceiro, { semPrazo: semPortao });
    if (motivo) { fica.push({ card, motivo }); continue; }
    // Story só vai se o post dela também for, pelos mesmos critérios.
    const doPost = parceiro && reprova(parceiro, null, { semPrazo: semPortao });
    if (doPost) {
      fica.push({ card, motivo: `o post do dia está segurado (${doPost})` });
      continue;
    }
    vai.push({ card, ...horarioDe(card) });
  }
  vai.sort((a, b) => a.due.localeCompare(b.due));

  console.log(`\n=== AGENDA (${vai.length}) ===`);
  for (const { card, due, origem } of vai) {
    console.log(`  ${brt(due)}  ${card.name.slice(0, 54)}${origem === "tabela" ? "" : "  [horário manual do card]"}`);
  }
  console.log(`\n=== FICA EM RASCUNHO (${fica.length}) ===`);
  for (const { card, motivo } of fica) console.log(`  ${card.name.slice(0, 52).padEnd(54)} ${motivo}`);

  if (dryRun || !vai.length) {
    if (!dryRun && !vai.length) console.log("\nNada pronto para agendar.");
    return;
  }

  console.log("");
  for (const { card, due, origem } of vai) {
    // Data e lista na MESMA chamada: card em Agendado sem due nunca venceria, e o
    // publisher o ignoraria para sempre.
    await trello(`/cards/${card.id}`, { method: "PUT", params: { idList: LISTS.agendado, due } });
    await trello(`/cards/${card.id}/actions/comments`, {
      method: "POST",
      params: { text: `📅 Agendado para ${brt(due)}${origem === "tabela" ? " (horário da tabela da ABREV)" : " (horário definido no card)"}. A partir daqui o publisher assume.` },
    }).catch(() => {});
    console.log(`movido: ${card.name.slice(0, 56)}`);
  }
  console.log(`\n${vai.length} card(s) agendado(s). O publisher publica cada um no horário.`);
}

const { values } = parseArgs({
  options: { "dry-run": { type: "boolean" }, mes: { type: "string" }, "sem-portao": { type: "boolean" } },
  strict: false,
});
run({ dryRun: !!values["dry-run"], mes: values.mes ? Number(values.mes) : null, semPortao: !!values["sem-portao"] })
  .catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
