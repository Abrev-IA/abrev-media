#!/usr/bin/env node
// Host de mídia para publicação no Instagram via GitHub + jsDelivr ($0).
//
// O Instagram Graph API exige que a imagem/vídeo esteja numa URL PÚBLICA no
// momento de criar o container de mídia. Este módulo sobe o arquivo para um
// repositório público do GitHub (via API REST, sem git/gh) e devolve uma URL
// pública de CDN (jsDelivr) que o Instagram consegue buscar.
//
// Variáveis de ambiente (ex.: via `node --env-file=.env`):
//   GITHUB_TOKEN   PAT (fine-grained) com Contents: Read/Write no repo de mídia
//   MEDIA_REPO     "owner/repo" do repo público (default "Abrev-IA/abrev-media")
//   MEDIA_BRANCH   branch (default "main")
//
// Uso (CLI):
//   node --env-file=.env media_host.mjs upload <arquivo> [nomeDestino]
//        -> imprime JSON { cdnUrl, rawUrl, path, sha }
//   node --env-file=.env media_host.mjs delete <path> <sha>
//        -> remove o arquivo (chamar depois que a publicação terminar)
//
// Uso (import):
//   import { uploadMedia, deleteMedia } from "./media_host.mjs";

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

const API = "https://api.github.com";

function cfg() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.MEDIA_REPO || "Abrev-IA/abrev-media";
  const branch = process.env.MEDIA_BRANCH || "main";
  if (!token) throw new Error("GITHUB_TOKEN ausente (defina no .env).");
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`MEDIA_REPO inválido: ${repo}`);
  return { token, owner, name, branch };
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "abrev-media-host",
  };
}

// Sobe um arquivo local e devolve as URLs públicas.
export async function uploadMedia(localPath, destName) {
  const { token, owner, name, branch } = cfg();
  const data = await readFile(localPath);
  const safe = (destName || basename(localPath)).replace(/[^\w.\-]/g, "_");
  const path = `media/${Date.now()}-${safe}`;
  const url = `${API}/repos/${owner}/${name}/contents/${path}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `media: add ${path}`,
      content: data.toString("base64"),
      branch,
    }),
  });
  if (!res.ok) throw new Error(`GitHub upload falhou ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const sha = json.content.sha;
  // Caminho único (timestamp) evita cache obsoleto do jsDelivr.
  const cdnUrl = `https://cdn.jsdelivr.net/gh/${owner}/${name}@${branch}/${path}`;
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${name}/${branch}/${path}`;
  return { cdnUrl, rawUrl, path, sha };
}

// Remove um arquivo (limpeza pós-publicação).
export async function deleteMedia(path, sha) {
  const { token, owner, name, branch } = cfg();
  const url = `${API}/repos/${owner}/${name}/contents/${path}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify({ message: `media: remove ${path}`, sha, branch }),
  });
  if (!res.ok) throw new Error(`GitHub delete falhou ${res.status}: ${await res.text()}`);
  return true;
}

// CLI (só roda quando executado diretamente, não quando importado).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === "upload") {
      if (!a) throw new Error("uso: node --env-file=.env media_host.mjs upload <arquivo> [nomeDestino]");
      console.log(JSON.stringify(await uploadMedia(a, b), null, 2));
    } else if (cmd === "delete") {
      if (!a || !b) throw new Error("uso: node --env-file=.env media_host.mjs delete <path> <sha>");
      await deleteMedia(a, b);
      console.log("removido:", a);
    } else {
      throw new Error("comando inválido. use: upload | delete");
    }
  } catch (e) {
    console.error("ERRO:", e.message);
    process.exit(1);
  }
}
