#!/usr/bin/env node
// Publicação no Instagram (@abrev_org) via Graph API — 2 passos: container → publish.
// Suporta imagem única, carrossel (imagens/vídeos) e reel.
//
// Env (via `node --env-file=.env`):
//   IG_ACCESS_TOKEN   token com escopo instagram_business_content_publish
//   IG_USER_ID        id numérico da conta (17841435126695944)
//
// ⚠️ As funções publish* POSTAM DE VERDADE na conta (post público). Use createImageContainer/
//    waitFinished para validar o pipeline sem publicar. A CLI com `--dry-run` cria o
//    container e NÃO publica.
//
// CLI (publica de verdade, sem --dry-run):
//   node --env-file=.env ig_publish.mjs image  <imageUrl> "<legenda>" [--dry-run]
//   node --env-file=.env ig_publish.mjs reel   <videoUrl> "<legenda>" [--dry-run]
//   node --env-file=.env ig_publish.mjs carousel "<legenda>" <url1> <url2> ... [--dry-run]
//        (cada url é imagem por extensão .jpg/.png/.webp; vídeo por .mp4/.mov)
//
// Import:
//   import { publishImage, publishReel, publishCarousel } from "./ig_publish.mjs";

import { pathToFileURL } from "node:url";

const API = "https://graph.instagram.com/v23.0";

function cfg() {
  const token = process.env.IG_ACCESS_TOKEN;
  const igId = process.env.IG_USER_ID;
  if (!token) throw new Error("IG_ACCESS_TOKEN ausente (.env).");
  if (!igId) throw new Error("IG_USER_ID ausente (.env).");
  return { token, igId };
}

async function gpost(path, params) {
  const { token } = cfg();
  const body = new URLSearchParams({ ...params, access_token: token });
  const res = await fetch(`${API}${path}`, { method: "POST", body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`POST ${path} falhou ${res.status}: ${JSON.stringify(json.error || json)}`);
  return json;
}

async function gget(path, params = {}) {
  const { token } = cfg();
  const qs = new URLSearchParams({ ...params, access_token: token });
  const res = await fetch(`${API}${path}?${qs}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET ${path} falhou ${res.status}: ${JSON.stringify(json.error || json)}`);
  return json;
}

// Cria um container de mídia e devolve o creation_id.
export async function createContainer(params) {
  const { igId } = cfg();
  const { id } = await gpost(`/${igId}/media`, params);
  if (!id) throw new Error("container sem id");
  return id;
}

// Aguarda o processamento do container (reel/vídeo). Imagens já vêm FINISHED.
export async function waitFinished(containerId, { timeoutMs = 300000, intervalMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { status_code, status } = await gget(`/${containerId}`, { fields: "status_code,status" });
    if (status_code === "FINISHED") return true;
    if (status_code === "ERROR" || status_code === "EXPIRED") {
      throw new Error(`container ${containerId} status ${status_code}: ${status || ""}`);
    }
    if (Date.now() > deadline) throw new Error(`timeout aguardando container ${containerId} (último: ${status_code})`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// Publica um container já pronto. Devolve o id da mídia publicada.
export async function publishContainer(creationId) {
  const { igId } = cfg();
  const { id } = await gpost(`/${igId}/media_publish`, { creation_id: creationId });
  return id;
}

function isVideo(url) {
  return /\.(mp4|mov|m4v)(\?|$)/i.test(url);
}

// ---- Imagem única ----
export async function publishImage({ imageUrl, caption = "" }) {
  const creationId = await createContainer({ image_url: imageUrl, caption });
  await waitFinished(creationId, { timeoutMs: 120000 });
  return publishContainer(creationId);
}

// ---- Reel ----
export async function publishReel({ videoUrl, caption = "", coverUrl, shareToFeed = true }) {
  const params = { media_type: "REELS", video_url: videoUrl, caption, share_to_feed: String(shareToFeed) };
  if (coverUrl) params.cover_url = coverUrl;
  const creationId = await createContainer(params);
  await waitFinished(creationId); // reels levam alguns segundos/minutos
  return publishContainer(creationId);
}

// ---- Carrossel (2 a 10 itens, imagens e/ou vídeos) ----
export async function publishCarousel({ items, caption = "" }) {
  if (!Array.isArray(items) || items.length < 2 || items.length > 10) {
    throw new Error("carrossel precisa de 2 a 10 itens");
  }
  const childIds = [];
  for (const it of items) {
    const url = typeof it === "string" ? it : it.url;
    const p = isVideo(url)
      ? { media_type: "VIDEO", video_url: url, is_carousel_item: "true" }
      : { image_url: url, is_carousel_item: "true" };
    const id = await createContainer(p);
    childIds.push(id);
  }
  // Aguarda cada item ficar pronto (vídeos precisam).
  for (const id of childIds) await waitFinished(id);
  const parentId = await createContainer({ media_type: "CAROUSEL", children: childIds.join(","), caption });
  await waitFinished(parentId);
  return publishContainer(parentId);
}

// ---- CLI ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry-run");
  const rest = args.filter((a) => a !== "--dry-run");
  const [cmd, ...params] = rest;

  async function run() {
    if (cmd === "image") {
      const [imageUrl, caption = ""] = params;
      if (!imageUrl) throw new Error("uso: image <imageUrl> \"<legenda>\" [--dry-run]");
      const id = await createContainer({ image_url: imageUrl, caption });
      await waitFinished(id, { timeoutMs: 120000 });
      if (dry) return console.log("DRY-RUN: container pronto, NÃO publicado. creation_id=" + id);
      console.log("publicado media_id=" + (await publishContainer(id)));
    } else if (cmd === "reel") {
      const [videoUrl, caption = ""] = params;
      if (!videoUrl) throw new Error("uso: reel <videoUrl> \"<legenda>\" [--dry-run]");
      const p = { media_type: "REELS", video_url: videoUrl, caption, share_to_feed: "true" };
      const id = await createContainer(p);
      await waitFinished(id);
      if (dry) return console.log("DRY-RUN: reel pronto, NÃO publicado. creation_id=" + id);
      console.log("publicado media_id=" + (await publishContainer(id)));
    } else if (cmd === "carousel") {
      const [caption = "", ...urls] = params;
      if (urls.length < 2) throw new Error("uso: carousel \"<legenda>\" <url1> <url2> ... [--dry-run]");
      if (dry) {
        const ids = [];
        for (const url of urls) {
          const p = isVideo(url)
            ? { media_type: "VIDEO", video_url: url, is_carousel_item: "true" }
            : { image_url: url, is_carousel_item: "true" };
          ids.push(await createContainer(p));
        }
        for (const id of ids) await waitFinished(id);
        return console.log("DRY-RUN: itens prontos, NÃO publicado. children=" + ids.join(","));
      }
      console.log("publicado media_id=" + (await publishCarousel({ items: urls, caption })));
    } else {
      throw new Error("comando: image | reel | carousel");
    }
  }

  run().catch((e) => {
    console.error("ERRO:", e.message);
    process.exit(1);
  });
}
