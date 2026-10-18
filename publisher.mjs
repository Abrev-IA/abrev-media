#!/usr/bin/env node
// Publisher autônomo: lê o calendário no Trello e publica no Instagram.
//
// Para cada card na lista "Agendado" com due <= agora:
//   baixa os anexos de mídia → re-hospeda (GitHub/jsDelivr) → publica no IG
//   (formato detectado: 1 vídeo=reel, 1 imagem=imagem, vários=carrossel) →
//   move o card para "Publicado" (ou "Erro") e comenta o resultado.
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
import { publishImage, publishReel, publishCarousel } from "./ig_publish.mjs";

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

async function publishCard(card) {
  const media = (card.attachments || [])
    .filter((a) => a.isUpload && (isVideo(a) || isImage(a)))
    .sort((a, b) => (a.pos || 0) - (b.pos || 0));
  if (!media.length) throw new Error("card sem anexo de mídia");
  const caption = card.desc || "";

  const dir = await mkdtemp(join(tmpdir(), "abrev-pub-"));
  const hosted = [];
  try {
    for (const m of media) {
      const file = await downloadAttachment(m, dir);
      const up = await uploadMedia(file, m.name);
      hosted.push({ up, video: isVideo(m) });
    }
    let mediaId;
    if (hosted.length === 1) {
      mediaId = hosted[0].video
        ? await publishReel({ videoUrl: hosted[0].up.cdnUrl, caption })
        : await publishImage({ imageUrl: hosted[0].up.cdnUrl, caption });
    } else {
      mediaId = await publishCarousel({ items: hosted.map((h) => h.up.cdnUrl), caption });
    }
    return mediaId;
  } finally {
    for (const h of hosted) await deleteMedia(h.up.path, h.up.sha).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function run(dry) {
  const cards = await trello(`/lists/${LISTS.agendado}/cards`, {
    params: { fields: "name,desc,due", attachments: "true", attachment_fields: "url,name,mimeType,bytes,isUpload,pos" },
  });
  const now = Date.now();
  const due = cards.filter((c) => c.due && new Date(c.due).getTime() <= now);
  console.log(`${cards.length} card(s) em Agendado; ${due.length} vencido(s).`);

  for (const card of due) {
    const n = card.name || card.id;
    const media = (card.attachments || []).filter((a) => a.isUpload && (isVideo(a) || isImage(a)));
    const fmt = media.length > 1 ? "carrossel" : media.length === 1 ? (isVideo(media[0]) ? "reel" : "imagem") : "SEM MÍDIA";
    if (dry) { console.log(`DRY: publicaria "${n}" (${fmt}, ${media.length} anexo(s))`); continue; }
    try {
      const mediaId = await publishCard(card);
      const permalink = await igPermalink(mediaId);
      await trello(`/cards/${card.id}`, { method: "PUT", params: { idList: LISTS.publicado } });
      await trello(`/cards/${card.id}/actions/comments`, { method: "POST", params: { text: `✅ Publicado automaticamente: ${permalink}` } });
      console.log(`OK: "${n}" -> ${permalink}`);
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
