#!/usr/bin/env node
// Publisher autônomo: lê o calendário no Trello e publica no Instagram.
//
// Para cada card na lista "Agendado" com due <= agora:
//   baixa os anexos de mídia → re-hospeda (GitHub/jsDelivr) → publica no IG
//   (formato detectado: 1 vídeo=reel, 1 imagem=imagem, vários=carrossel) →
//   move o card para "Publicado" (ou "Erro") e comenta o resultado.
//
// Card de STORY é exceção: reconhecido pelo nome ("· Stories ·"), publica cada anexo
// como uma story separada, na ordem, e nunca manda legenda — o desc desse card é
// briefing interno. Story entrou aqui porque o agendamento do Business Suite nunca
// funcionou nesta conta (8 falhas em novembro/2026); pela API funciona.
//
// Env (.env local ou secrets do GitHub Actions):
//   IG_ACCESS_TOKEN, IG_USER_ID                  (publicação no IG)
//   GITHUB_TOKEN, MEDIA_REPO, MEDIA_BRANCH       (host de mídia)
//   TRELLO_KEY, TRELLO_TOKEN                     (API do Trello)
//   TRELLO_LIST_AGENDADO / _PUBLICADO / _ERRO    (ids das listas; há defaults)
//
// Uso:
//   node --env-file=.env publisher.mjs            # publica de verdade
//   node --env-file=.env publisher.mjs --dry-run  # só mostra o que faria

import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadMedia, deleteMedia } from "./media_host.mjs";
import { publishImage, publishReel, publishStory, publishCarousel } from "./ig_publish.mjs";
import { ETIQUETA_OBJECAO } from "./calendario_regras.mjs";

const T = "https://api.trello.com/1";
const IG = "https://graph.instagram.com/v23.0";

const LISTS = {
  agendado: process.env.TRELLO_LIST_AGENDADO || "6ad43edadd2cc201e4b79182",
  publicado: process.env.TRELLO_LIST_PUBLICADO || "6ad43edb9afef04caf753a9b",
  erro: process.env.TRELLO_LIST_ERRO || "6ad43edce846312907225b94",
};

function tauth() {
  const key = process.env.TRELLO_KEY, token = process.env.TRELLO_TOKEN;
  if (!key || !token) throw new Error("TRELLO_KEY/TRELLO_TOKEN ausentes (.env).");
  return { key, token };
}

async function trello(path, { method = "GET", params = {} } = {}) {
  const { key, token } = tauth();
  const qs = new URLSearchParams({ ...params, key, token });
  const res = await fetch(`${T}${path}?${qs}`, { method });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Trello ${method} ${path} ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

// Baixa um anexo do Trello (precisa do header OAuth para uploads privados).
async function downloadAttachment(att, dir) {
  const { key, token } = tauth();
  const res = await fetch(att.url, {
    headers: { Authorization: `OAuth oauth_consumer_key="${key}", oauth_token="${token}"` },
  });
  if (!res.ok) throw new Error(`download anexo ${att.name} ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const safe = (att.name || "midia").replace(/[^\w.\-]/g, "_");
  const file = join(dir, `${att.id}-${safe}`);
  await writeFile(file, buf);
  return file;
}

function isVideo(att) {
  return (att.mimeType || "").startsWith("video/") || /\.(mp4|mov|m4v)$/i.test(att.name || "");
}
function isImage(att) {
  return (att.mimeType || "").startsWith("image/") || /\.(jpe?g|png|webp)$/i.test(att.name || "");
}

async function igPermalink(mediaId) {
  const { token } = { token: process.env.IG_ACCESS_TOKEN };
  const res = await fetch(`${IG}/${mediaId}?fields=permalink&access_token=${token}`);
  const j = await res.json().catch(() => ({}));
  return j.permalink || `(media_id ${mediaId})`;
}

// O quadro nomeia todo card de apoio como "DD/MM · Stories · ...". É essa convenção
// que marca o card, e não o desc: o desc é briefing e muda de card para card.
// LinkedIn via Make (cenário "ABREV - publicar no LinkedIn"): enquanto a API própria do
// LinkedIn não é liberada, o post vai para um webhook do Make, que publica na página da
// ABREV com a conexão já aprovada dele. O módulo do Make publica UMA imagem; num carrossel
// vai a capa. Sem LINKEDIN_WEBHOOK_URL, o passo é pulado.
//
// O texto do LinkedIn usa o "little text format": ( ) [ ] { } < > @ | ~ _ * \ são reservados
// e, sem escape, cortam o post. Hashtag vira o elemento {hashtag|\#|tag}.
function textoLinkedIn(t) {
  return String(t || "")
    .replace(/[\\|{}@[\]()<>*_~]/g, (c) => "\\" + c)
    .replace(/#([\p{L}\p{N}_]+)/gu, (_, tag) => `{hashtag|\\#|${tag}}`);
}

async function postLinkedIn(card, caption, imagemUrl) {
  const url = process.env.LINKEDIN_WEBHOOK_URL;
  if (!url) return "LinkedIn: pulado (LINKEDIN_WEBHOOK_URL ausente)";
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tipo: "imagem", texto: textoLinkedIn(caption), imagem_url: imagemUrl,
      documento_url: "", titulo: (card.name || "").split("·").pop().trim(), card_id: card.id, data: card.due }) });
  if (!r.ok) throw new Error(`LinkedIn (Make) recusou: HTTP ${r.status}`);
  // O Make responde "Accepted" e roda o cenário em seguida, baixando a imagem pela URL.
  // Espera antes de a imagem temporária ser apagada no finally.
  await new Promise((res) => setTimeout(res, 90000));
  return "LinkedIn: enviado ao Make";
}

// A legenda é a descrição até o primeiro marcador ([VISUAL], [RASCUNHO]...). O resto é
// anotação interna e não pode ir ao ar.
function legenda(desc) {
  const linhas = String(desc || "").split(/\r?\n/);
  const i = linhas.findIndex((l) => /^\s*\[[A-ZÁÉÍÓÚÇ]+\]/.test(l));
  return (i < 0 ? linhas : linhas.slice(0, i)).join("\n").trim();
}

function isStoryCard(card) {
  return /·\s*stories\s*·/i.test(card.name || "");
}

async function publishCard(card) {
  const media = (card.attachments || [])
    .filter((a) => a.isUpload && (isVideo(a) || isImage(a)))
    .sort((a, b) => (a.pos || 0) - (b.pos || 0));
  if (!media.length) throw new Error("card sem anexo de mídia");
  const story = isStoryCard(card);
  const caption = story ? "" : legenda(card.desc);

  const dir = await mkdtemp(join(tmpdir(), "abrev-pub-"));
  const hosted = [];
  try {
    for (const m of media) {
      const file = await downloadAttachment(m, dir);
      const up = await uploadMedia(file, m.name);
      hosted.push({ up, video: isVideo(m) });
    }
    // Story: cada anexo é uma story própria, publicada na ordem do card. Não é
    // carrossel — o Instagram não tem carrossel de story, tem sequência.
    if (story) {
      const ids = [];
      for (const h of hosted) {
        ids.push(await publishStory(h.video ? { videoUrl: h.up.cdnUrl } : { imageUrl: h.up.cdnUrl }));
      }
      return ids;
    }
    const ids = hosted.length === 1
      ? [hosted[0].video
        ? await publishReel({ videoUrl: hosted[0].up.cdnUrl, caption })
        : await publishImage({ imageUrl: hosted[0].up.cdnUrl, caption })]
      : [await publishCarousel({ items: hosted.map((h) => h.up.cdnUrl), caption })];
    // LinkedIn depois do Instagram: falha aqui não desfaz o post do Instagram; vira aviso.
    const capa = hosted.find((h) => !h.video);
    if (capa) {
      try { ids.linkedin = await postLinkedIn(card, caption, capa.up.cdnUrl); }
      catch (e) { ids.linkedin = `LinkedIn: FALHOU (${e.message})`; }
    } else ids.linkedin = "LinkedIn: pulado (só vídeo)";
    return ids;
  } finally {
    for (const h of hosted) await deleteMedia(h.up.path, h.up.sha).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function run(dry) {
  const cards = await trello(`/lists/${LISTS.agendado}/cards`, {
    params: { fields: "name,desc,due,labels", attachments: "true", attachment_fields: "url,name,mimeType,bytes,isUpload,pos" },
  });
  const now = Date.now();
  // OBJEÇÃO TARDIA. Com aprovação tácita, alguém pode discordar depois que a pauta já foi
  // para Agendado. Basta pôr a etiqueta de objeção no card: o publisher não a publica, sem
  // ninguém precisar arrastar card de volta. É a última trava antes do ar.
  const objetado = (c) => (c.labels || []).some((l) => (l.name || "").trim().toLowerCase() === ETIQUETA_OBJECAO.toLowerCase());
  const segurados = cards.filter(objetado);
  for (const c of segurados) console.log(`SEGURADO (objeção "${ETIQUETA_OBJECAO}"): ${c.name}`);
  const due = cards.filter((c) => !objetado(c) && c.due && new Date(c.due).getTime() <= now);
  console.log(`${cards.length} card(s) em Agendado; ${due.length} vencido(s); ${segurados.length} segurado(s) por objeção.`);

  for (const card of due) {
    const n = card.name || card.id;
    const media = (card.attachments || []).filter((a) => a.isUpload && (isVideo(a) || isImage(a)));
    const fmt = isStoryCard(card)
      ? `story x${media.length}`
      : media.length > 1 ? "carrossel" : media.length === 1 ? (isVideo(media[0]) ? "reel" : "imagem") : "SEM MÍDIA";
    if (dry) { console.log(`DRY: publicaria "${n}" (${fmt}, ${media.length} anexo(s))`); continue; }
    try {
      const mediaIds = await publishCard(card);
      // Story não tem permalink público; igPermalink cai no fallback de media_id.
      const permalink = (await Promise.all(mediaIds.map(igPermalink))).join(" · ");
      await trello(`/cards/${card.id}`, { method: "PUT", params: { idList: LISTS.publicado } });
      await trello(`/cards/${card.id}/actions/comments`, { method: "POST", params: { text: `✅ Publicado automaticamente: ${permalink}${mediaIds.linkedin ? `
${mediaIds.linkedin}` : ""}` } });
      console.log(`OK: "${n}" -> ${permalink}${mediaIds.linkedin ? ` | ${mediaIds.linkedin}` : ""}`);
    } catch (e) {
      await trello(`/cards/${card.id}`, { method: "PUT", params: { idList: LISTS.erro } }).catch(() => {});
      await trello(`/cards/${card.id}/actions/comments`, { method: "POST", params: { text: `❌ Falha ao publicar: ${e.message}` } }).catch(() => {});
      console.error(`ERRO: "${n}": ${e.message}`);
    }
  }
}

run(process.argv.includes("--dry-run")).catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
