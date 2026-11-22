#!/usr/bin/env node
// Feed do calendário para o cockpit: um JSON com o planejado (Trello), o que de fato foi
// ao ar (Graph API do Instagram) e as regras que geram o mês.
//
// POR QUE UM ARQUIVO, E NÃO UMA ROTA NO COCKPIT LENDO O TRELLO: o cockpit não pode ser
// publicado desta máquina, e ensiná-lo a ler Trello e Instagram exigiria dar a ele as
// credenciais dos dois e reimplementar a reconciliação lá dentro. Assim, a lógica fica
// num lugar só (aqui), e o cockpit só precisa ler um arquivo público e desenhar a grade.
//
// POR QUE RECONCILIAR: em novembro/2026 o Trello dizia que nada tinha publicado, e 7
// peças tinham ido ao ar — agendadas à mão no Business Suite, fora do pipeline. Um
// calendário que lê só o Trello repetiria esse erro.
//
// O QUE NÃO ENTRA, DE PROPÓSITO: o arquivo é público (repositório de mídia). Por isso
// não leva legenda, briefing, nota interna nem arte de peça que ainda não saiu. Leva o
// que já é público ou inofensivo: data, hora, formato, tema e estado. Peça publicada
// leva o link do Instagram.
//
// Uso: node --env-file=.env calendario_feed.mjs            # gera e publica
//      node --env-file=.env calendario_feed.mjs --local    # só gera em calendario/

import { writeFile, mkdir } from "node:fs/promises";
import { HORARIO_PECA, HORARIO_STORY, BRT_PARA_UTC, REGRAS } from "./calendario_regras.mjs";

const T = "https://api.trello.com/1";
const IG = "https://graph.instagram.com/v23.0";
const REPO = process.env.MEDIA_REPO || "Abrev-IA/abrev-media";
const BRANCH = process.env.MEDIA_BRANCH || "main";
const CAMINHO = "calendario/calendario.json";

const LISTAS = {
  [process.env.TRELLO_LIST_RASCUNHO || "6ad43ed930b50a2b6519bdf7"]: "rascunho",
  [process.env.TRELLO_LIST_AGENDADO || "6ad43edadd2cc201e4b79182"]: "agendado",
  [process.env.TRELLO_LIST_PUBLICADO || "6ad43edb9afef04caf753a9b"]: "publicado",
  [process.env.TRELLO_LIST_ERRO || "6ad43edce846312907225b94"]: "erro",
};

async function trello(path, params = {}) {
  const key = process.env.TRELLO_KEY, token = process.env.TRELLO_TOKEN;
  if (!key || !token) throw new Error("TRELLO_KEY/TRELLO_TOKEN ausentes.");
  const res = await fetch(`${T}${path}?${new URLSearchParams({ ...params, key, token })}`);
  if (!res.ok) throw new Error(`Trello ${path} ${res.status}`);
  return res.json();
}

const ehStory = (nome) => /·\s*stories\s*·/i.test(nome);
const campo = (nome, i) => (nome.split("·")[i] || "").trim();

function tipoBase(texto) {
  const t = String(texto || "").toLowerCase();
  if (/reel\s*\+\s*card/.test(t)) return "reel+card";
  if (/\breel\b/.test(t)) return "reel";
  if (/carrossel/.test(t)) return "carrossel";
  if (/newsletter/.test(t)) return "newsletter";
  if (/stories/.test(t)) return "stories";
  return null;
}

// Data e hora em BRT. Do `due` quando o card já tem; senão, a hora que a tabela daria —
// marcada como prevista, para o cockpit não confundir plano com agendamento.
function quando(card, agora) {
  if (card.due) {
    const d = new Date(new Date(card.due).getTime() - BRT_PARA_UTC * 3600e3).toISOString();
    return { data: d.slice(0, 10), hora: d.slice(11, 16), hora_fonte: "agendada" };
  }
  const m = card.name.match(/^(\d{2})\/(\d{2})/);
  if (!m) return { data: null, hora: null, hora_fonte: null };
  const [dd, mm] = [Number(m[1]), Number(m[2])];
  const mesAtual = agora.getUTCMonth() + 1;
  const ano = agora.getUTCFullYear() + (mm < mesAtual - 6 ? 1 : 0);
  const story = ehStory(card.name);
  const hora = story ? HORARIO_STORY[tipoBase(campo(card.name, 2))] : HORARIO_PECA[tipoBase(campo(card.name, 1))];
  return {
    data: `${ano}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`,
    hora: hora || null,
    hora_fonte: hora ? "prevista pela tabela" : null,
  };
}

// Tipo do Instagram que corresponde a cada formato. Story não aparece em /media (a API
// só expõe story das últimas 24h, por outro endpoint), então não é reconciliado.
const COMPATIVEL = { carrossel: ["CAROUSEL_ALBUM"], reel: ["VIDEO"], "reel+card": ["VIDEO", "CAROUSEL_ALBUM"] };

async function publicadas() {
  const t = process.env.IG_ACCESS_TOKEN, u = process.env.IG_USER_ID;
  if (!t || !u) return { itens: [], aviso: "sem credencial do Instagram: reconciliação desligada" };
  const res = await fetch(`${IG}/${u}/media?fields=id,media_type,timestamp,permalink&limit=60&access_token=${t}`);
  const j = await res.json();
  if (j.error) return { itens: [], aviso: `Graph API: ${j.error.message}` };
  return {
    itens: (j.data || []).map((m) => {
      const d = new Date(new Date(m.timestamp).getTime() - BRT_PARA_UTC * 3600e3).toISOString();
      return { tipo: m.media_type, data: d.slice(0, 10), hora: d.slice(11, 16), link: m.permalink };
    }),
    aviso: null,
  };
}

async function montar() {
  const agora = new Date();
  const listas = await trello(`/boards/${await quadro()}/lists`, { fields: "name" });
  const pecas = [];
  for (const lista of listas) {
    const estado = LISTAS[lista.id];
    if (!estado) continue;
    const cards = await trello(`/lists/${lista.id}/cards`, { fields: "name,due", attachments: "true", attachment_fields: "name,isUpload" });
    for (const c of cards) {
      const formato = ehStory(c.name) ? "Stories" : campo(c.name, 1);
      pecas.push({
        id: c.id,
        ...quando(c, agora),
        formato,
        tema: campo(c.name, 2),
        estado,
        tem_arte: (c.attachments || []).some((a) => a.isUpload && /\.(png|jpe?g|mp4)$/i.test(a.name || "")),
        link: null,
      });
    }
  }

  // Reconciliação: cada peça de feed é casada por dia e tipo compatível. Texto não é
  // comparado — a legenda publicada costuma divergir da do card, e comparar erra.
  const ig = await publicadas();
  const usados = new Set();
  for (const p of pecas) {
    const tipos = COMPATIVEL[tipoBase(p.formato)];
    if (!tipos || !p.data) continue;
    const i = ig.itens.findIndex((m, k) => !usados.has(k) && m.data === p.data && tipos.includes(m.tipo));
    if (i < 0) continue;
    usados.add(i);
    p.link = ig.itens[i].link;
    if (p.estado !== "publicado") p.estado = "publicado_fora_do_pipeline";
  }
  // O que foi ao ar sem card nenhum — o caso de novembro, ao contrário.
  ig.itens.forEach((m, k) => {
    if (usados.has(k)) return;
    pecas.push({ id: null, data: m.data, hora: m.hora, hora_fonte: "publicada", formato: m.tipo, tema: null, estado: "publicado_sem_card", tem_arte: true, link: m.link });
  });

  pecas.sort((a, b) => `${a.data}${a.hora}`.localeCompare(`${b.data}${b.hora}`));
  const conta = {};
  for (const p of pecas) conta[p.estado] = (conta[p.estado] || 0) + 1;

  return {
    gerado_em: agora.toISOString(),
    fonte: "Trello (Calendário ABREV) + Graph API do Instagram",
    aviso: ig.aviso,
    resumo: conta,
    estados: {
      rascunho: "planejado, ainda sem aprovação",
      agendado: "aprovado, com data — o publisher publica no horário",
      publicado: "publicado pelo pipeline",
      publicado_fora_do_pipeline: "tem card, mas foi ao ar por fora (ex.: Business Suite)",
      publicado_sem_card: "foi ao ar sem card no Trello",
      erro: "o publisher tentou e falhou",
    },
    regras: REGRAS,
    pecas,
  };
}

let _quadro;
async function quadro() {
  if (_quadro) return _quadro;
  const rascunho = Object.keys(LISTAS)[0];
  _quadro = (await trello(`/lists/${rascunho}`, { fields: "idBoard" })).idBoard;
  return _quadro;
}

// Caminho FIXO no repositório (o host de mídia usa caminho com carimbo de hora; aqui o
// cockpit precisa de um endereço que não mude).
async function publicar(conteudo) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN ausente.");
  const H = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "abrev-calendario" };
  const url = `https://api.github.com/repos/${REPO}/contents/${CAMINHO}`;
  const atual = await fetch(`${url}?ref=${BRANCH}`, { headers: H });
  const sha = atual.ok ? (await atual.json()).sha : undefined;
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ message: "calendario: atualiza feed", content: Buffer.from(conteudo).toString("base64"), branch: BRANCH, ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) throw new Error(`publicar ${res.status}: ${(await res.text()).slice(0, 160)}`);
}

const feed = await montar();
const texto = JSON.stringify(feed, null, 2);
await mkdir("calendario", { recursive: true });
await writeFile(CAMINHO, texto);
console.log(`${feed.pecas.length} peça(s) | ${Object.entries(feed.resumo).map(([k, v]) => `${k}: ${v}`).join(" | ")}`);
if (feed.aviso) console.log("AVISO:", feed.aviso);
console.log(`gravado em ${CAMINHO} (${(texto.length / 1024).toFixed(0)} KB)`);

if (!process.argv.includes("--local")) {
  await publicar(texto);
  console.log(`\npublicado. O cockpit lê de:`);
  console.log(`  https://raw.githubusercontent.com/${REPO}/${BRANCH}/${CAMINHO}   (atualiza em ~5 min)`);
  console.log(`  https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/${CAMINHO}          (cache de até 12h)`);
}
