#!/usr/bin/env node
// Agendamento: move as pautas aprovadas de "Rascunho" para "Agendado", que é a única
// lista que o publisher olha. Inclui as STORIES junto do post que elas apoiam.
//
// POR QUE EXISTE: este passo não existia. O cronograma criava os cards, a esteira fazia
// as artes, o e-mail pedia aprovação — e aí alguém tinha que arrastar card a card no
// Trello. Ninguém arrastou em novembro/2026, e o mês inteiro não publicou pelo pipeline
// (as 7 publicações que saíram foram agendadas na mão pelo Business Suite, fora dele).
//
// A STORY VIAJA COM O POST. Um card "DD/MM · Stories · apoio ao X" não é peça solta: é
// apoio do post do mesmo dia. Então ou os dois vão, ou nenhum vai — story publicada sem
// o post que ela anuncia manda a pessoa para um feed onde não há nada novo.
//
// Nada é agendado sem passar pelas conferências: precisa de arte, de horário, e o horário
// precisa estar no futuro. Card reprovado é relatado, não agendado.
//
// Uso: node --env-file=.env agendar.mjs --dry-run     # mostra o que faria
//      node --env-file=.env agendar.mjs               # agenda
//      node --env-file=.env agendar.mjs --mes=12      # só dezembro

import { parseArgs } from "node:util";

const T = "https://api.trello.com/1";
const LISTS = {
  rascunho: process.env.TRELLO_LIST_RASCUNHO || "6ad43ed930b50a2b6519bdf7",
  agendado: process.env.TRELLO_LIST_AGENDADO || "6ad43edadd2cc201e4b79182",
};

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

const ehStory = (c) => /·\s*stories\s*·/i.test(c.name || "");
// O formato e o SEGUNDO campo do titulo ("DD/MM · Formato · Tema"). Procurar
// "newsletter" no nome inteiro reprovava a story que ANUNCIA a newsletter, que e peca
// legitima de Instagram.
const formatoDoCard = (c) => ((c.name || "").split("·")[1] || "").trim();
const ehNewsletter = (c) => /newsletter/i.test(formatoDoCard(c));
const temArte = (c) => (c.attachments || []).some((a) => a.isUpload && /\.(png|jpe?g|mp4)$/i.test(a.name || ""));
const diaDoCard = (c) => (c.name.match(/^(\d{2}\/\d{2})/) || [])[1] || null;

// O que impede um card de ser agendado. Devolve null quando está pronto.
function reprova(card, parceiro) {
  if (ehNewsletter(card)) return "newsletter não publica no Instagram";
  if (!temArte(card)) return "sem arte anexada";
  const due = card.due || parceiro?.due;
  if (!due) return "sem horário de publicação (due)";
  if (new Date(due).getTime() <= Date.now()) return `horário já passou (${due.slice(0, 16).replace("T", " ")})`;
  // Story sem post do mesmo dia e permitida quando tem horario proprio: e o caso da
  // story que anuncia a newsletter, que nao tem contraparte no feed. O pareamento existe
  // para nao anunciar um post que nao vai sair — nao para proibir story solta.
  if (ehStory(card) && !parceiro && !card.due) return "story sem post do dia e sem horário próprio";
  return null;
}

async function run({ dryRun, mes }) {
  const cards = await trello(`/lists/${LISTS.rascunho}/cards`, {
    params: { fields: "name,due,desc", attachments: "true", attachment_fields: "name,isUpload" },
  });

  const alvo = mes ? cards.filter((c) => (diaDoCard(c) || "").endsWith(`/${String(mes).padStart(2, "0")}`)) : cards;
  console.log(`${alvo.length} card(s) em Rascunho${mes ? ` no mês ${mes}` : ""}.${dryRun ? "  [DRY-RUN: nada é movido]" : ""}`);

  // Índice dos posts por dia, para a story achar o par. Story não entra no índice: ela
  // é o apoio, não o apoiado.
  const posts = new Map();
  for (const c of alvo) if (!ehStory(c) && !ehNewsletter(c)) posts.set(diaDoCard(c), c);

  const vai = [], fica = [];
  for (const card of alvo) {
    const parceiro = ehStory(card) ? posts.get(diaDoCard(card)) : null;
    const motivo = reprova(card, parceiro);
    if (motivo) { fica.push({ card, motivo }); continue; }
    // Story só vai se o post dela também for. Checa o post pelos mesmos critérios.
    if (ehStory(card) && reprova(parceiro, null)) {
      fica.push({ card, motivo: `o post do dia não está pronto (${reprova(parceiro, null)})` });
      continue;
    }
    vai.push({ card, due: card.due || parceiro?.due, herdou: !card.due });
  }

  console.log(`\n=== AGENDA (${vai.length}) ===`);
  for (const { card, due, herdou } of vai) {
    console.log(`  ${due.slice(0, 16).replace("T", " ")}  ${card.name.slice(0, 52)}${herdou ? "  [horário herdado do post]" : ""}`);
  }
  console.log(`\n=== FICA EM RASCUNHO (${fica.length}) ===`);
  for (const { card, motivo } of fica) console.log(`  ${card.name.slice(0, 52).padEnd(54)} ${motivo}`);

  if (dryRun || !vai.length) {
    if (!dryRun && !vai.length) console.log("\nNada pronto para agendar.");
    return;
  }

  console.log("");
  for (const { card, due, herdou } of vai) {
    // O horário vai junto na mesma chamada quando foi herdado: card sem due em Agendado
    // nunca venceria, e o publisher o ignoraria para sempre.
    const params = { idList: LISTS.agendado, ...(herdou ? { due } : {}) };
    await trello(`/cards/${card.id}`, { method: "PUT", params });
    await trello(`/cards/${card.id}/actions/comments`, {
      method: "POST",
      params: { text: `📅 Agendado para ${due.slice(0, 16).replace("T", " ")} UTC.${herdou ? " Horário herdado do post do mesmo dia." : ""} A partir daqui o publisher assume.` },
    }).catch(() => {});
    console.log(`movido: ${card.name.slice(0, 56)}`);
  }
  console.log(`\n${vai.length} card(s) agendado(s). O publisher publica cada um no horário.`);
}

const { values } = parseArgs({
  options: { "dry-run": { type: "boolean" }, mes: { type: "string" } },
  strict: false,
});
run({ dryRun: !!values["dry-run"], mes: values.mes ? Number(values.mes) : null })
  .catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
