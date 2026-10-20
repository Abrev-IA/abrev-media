#!/usr/bin/env node
// Disparo de aprovação do dia 20: monta o e-mail com o cronograma do mês seguinte e as
// artes já geradas pela esteira, e manda para a diretoria.
//
// É o passo 02 do ciclo (Geração → E-MAIL DE APROVAÇÃO → Aprovação → Publicação).
// A fonte da verdade é o Trello: cada card da lista Rascunho é uma pauta, com data,
// formato e tema no título (DD/MM · Formato · Tema), a legenda na descrição e as artes
// como anexo.
//
// As artes NÃO vão anexadas ao e-mail: 16 pautas de PNG 1024px passam de 20 MB e esbarram
// no limite do Gmail. Em vez disso cada arte sobe para o repositório público de mídia
// (o mesmo que o Instagram já usa) e entra no corpo como <img>, que é o que o cliente de
// e-mail mostra de imediato. O cache .aprovacao_midia.json evita subir a mesma arte duas
// vezes se a rotina rodar de novo.
//
// Env: TRELLO_KEY, TRELLO_TOKEN, GITHUB_TOKEN (host de mídia).
//      Para enviar: SMTP_USER, SMTP_PASS (senha de app do Gmail), APROVACAO_PARA.
//      Opcionais: SMTP_HOST (smtp.gmail.com), SMTP_PORT (465), APROVACAO_COPIA,
//                 TRELLO_LIST_RASCUNHO, APROVACAO_MES (1-12), APROVACAO_ANO.
//
// Uso: node --env-file=.env aprovacao.mjs            # monta e salva o HTML, NÃO envia
//      node --env-file=.env aprovacao.mjs --enviar   # monta e envia
//      node --env-file=.env aprovacao.mjs --mes=12   # força o mês

import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";
import { uploadMedia } from "./media_host.mjs";

const T = "https://api.trello.com/1";
const LIST_RASCUNHO = process.env.TRELLO_LIST_RASCUNHO || "6ad43ed930b50a2b6519bdf7";
const CACHE = new URL(".aprovacao_midia.json", import.meta.url);
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

function tauth() {
  const key = process.env.TRELLO_KEY, token = process.env.TRELLO_TOKEN;
  if (!key || !token) throw new Error("TRELLO_KEY/TRELLO_TOKEN ausentes (.env).");
  return { key, token };
}

async function trello(path, params = {}) {
  const { key, token } = tauth();
  const res = await fetch(`${T}${path}?${new URLSearchParams({ ...params, key, token })}`);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Trello ${path} ${res.status}: ${JSON.stringify(j)}`);
  return j;
}

// Anexo do Trello não sai por query string: o download exige o cabeçalho OAuth.
async function baixarAnexo(url) {
  const { key, token } = tauth();
  const res = await fetch(url, {
    headers: { Authorization: `OAuth oauth_consumer_key="${key}", oauth_token="${token}"` },
  });
  if (!res.ok) throw new Error(`anexo ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const dd = (n) => String(n).padStart(2, "0");

// A legenda é só o texto ANTES do primeiro marcador. Depois dele vem controle interno
// ([RASCUNHO], [VISUAL]) e nota de conferência da equipe ("CONFERÊNCIA DE ENTREGAS —
// 20/10/2026 ..."), que é recado de bastidor e não pode vazar para a diretoria.
// Marcador = linha entre colchetes, ou título em caixa alta terminando em data.
function legendaDoCard(desc) {
  const linhas = String(desc || "").split(/\r?\n/);
  const marcador = (l) => {
    const s = l.trim();
    return s.startsWith("[") || /^[^a-zà-ÿ]{6,}[—-]\s*\d{2}\/\d{2}\/\d{2,4}\s*$/.test(s);
  };
  const corte = linhas.findIndex(marcador);
  return (corte < 0 ? linhas : linhas.slice(0, corte)).join("\n").trim();
}

// Título do card: "DD/MM · Formato · Tema". O que não seguir o padrão fica de fora —
// melhor deixar uma pauta avulsa fora do e-mail do que mandar a data errada.
function lerCard(card) {
  const m = card.name.match(/^(\d{2})\/(\d{2})\s*·\s*([^·]+)·\s*(.+)$/);
  if (!m) return null;
  const [, dia, mes, formato, tema] = m;
  const legenda = legendaDoCard(card.desc);
  return {
    id: card.id,
    dia: Number(dia),
    mes: Number(mes),
    formato: formato.trim(),
    tema: tema.trim(),
    // Newsletter é artigo, não arte: a esteira pula esses cards de propósito, então a
    // ausência de PNG aqui é o esperado e não deve virar aviso de pendência.
    artigo: /newsletter/i.test(formato),
    legenda,
    artes: (card.attachments || []).filter((a) => a.isUpload && /\.png$/i.test(a.name || "")),
    urls: [],
  };
}

async function lerCache() {
  try { return JSON.parse(await readFile(CACHE, "utf8")); } catch { return {}; }
}

// Sobe as artes de cada pauta para o host público e guarda as URLs, reaproveitando o que
// já subiu antes (republicar a mesma arte toda vez só polui o repositório de mídia).
async function publicarArtes(pautas) {
  const cache = await lerCache();
  const dir = await mkdtemp(join(tmpdir(), "abrev-aprov-"));
  try {
    for (const p of pautas) {
      for (const a of p.artes) {
        if (cache[a.id]) { p.urls.push(cache[a.id]); continue; }
        try {
          const arq = join(dir, `${a.id}.png`);
          await writeFile(arq, await baixarAnexo(a.url));
          const { cdnUrl } = await uploadMedia(arq, a.name);
          cache[a.id] = cdnUrl;
          p.urls.push(cdnUrl);
          console.log(`  publicada: ${a.name}`);
        } catch (e) {
          console.error(`  ERRO ao publicar ${a.name}: ${e.message}`);
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  await writeFile(CACHE, JSON.stringify(cache, null, 2));
}

// HTML de e-mail é HTML de 2005: tabela, largura fixa e estilo na tag. Gmail e Outlook
// descartam <style> no head e não entendem flex, então nada de classe aqui.
function montarHtml(pautas, mes, ano) {
  const nome = MESES[mes - 1];
  const comArte = pautas.filter((p) => p.urls.length).length;
  const artigos = pautas.filter((p) => p.artigo).length;

  const blocos = pautas.map((p) => `
      <tr><td style="padding:0 0 26px">
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e3e8ec;border-radius:14px">
          <tr><td style="background:#15293a;padding:13px 20px;border-radius:13px 13px 0 0">
            <span style="color:#f4c01e;font:bold 13px Arial,sans-serif;letter-spacing:.08em">${dd(p.dia)}/${dd(p.mes)}</span>
            <span style="color:#36b7c6;font:bold 13px Arial,sans-serif;letter-spacing:.08em">&nbsp;&middot;&nbsp; ${esc(p.formato.toUpperCase())}</span>
          </td></tr>
          <tr><td style="padding:18px 20px 4px">
            <div style="font:bold 19px/1.3 Arial,sans-serif;color:#13293a">${esc(p.tema)}</div>
          </td></tr>
          ${p.urls.map((u) => u
            ? `<tr><td style="padding:12px 20px 0"><img src="${esc(u)}" width="520" style="width:100%;max-width:520px;border-radius:10px;display:block" alt="arte ${dd(p.dia)}/${dd(p.mes)}"></td></tr>`
            : `<tr><td style="padding:12px 20px 0"><div style="height:160px;background:#15293a;border-radius:10px;color:#36b7c6;font:bold 13px/160px Arial,sans-serif;text-align:center">ARTE (pr&eacute;via sem m&iacute;dia)</div></td></tr>`).join("")}
          ${p.artigo && !p.urls.length
            ? `<tr><td style="padding:10px 20px 0"><div style="font:italic 14px Arial,sans-serif;color:#9aa6b0">Newsletter: texto corrido, sem arte.</div></td></tr>`
            : ""}
          ${p.legenda
            ? `<tr><td style="padding:16px 20px 20px"><div style="font:14px/1.55 Arial,sans-serif;color:#44525e;white-space:pre-wrap">${esc(p.legenda)}</div></td></tr>`
            : `<tr><td style="padding:0 20px 18px"><div style="font:italic 14px Arial,sans-serif;color:#9aa6b0">(sem legenda no card)</div></td></tr>`}
        </table>
      </td></tr>`).join("");

  return `<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><title>Aprovação ${esc(nome)}/${ano}</title></head>
<body style="margin:0;background:#eef2f5">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f5;padding:28px 12px">
<tr><td align="center">
  <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:16px">
    <tr><td style="height:10px;background:#36b7c6;border-radius:15px 15px 0 0"></td></tr>
    <tr><td style="background:#15293a;padding:32px">
      <div style="font:bold 12px Arial,sans-serif;letter-spacing:.16em;color:#36b7c6;text-transform:uppercase">ABREV &middot; Log&iacute;stica Reversa do Varejo</div>
      <div style="font:bold 30px/1.15 Arial,sans-serif;color:#ffffff;padding-top:14px">Cronograma de ${esc(nome)}/${ano}</div>
      <div style="font:16px/1.5 Arial,sans-serif;color:#c3cfd8;padding-top:12px">
        ${pautas.length} publica&ccedil;${pautas.length === 1 ? "&atilde;o" : "&otilde;es"} &middot; ${comArte} com arte pronta${artigos ? ` &middot; ${artigos} newsletter${artigos > 1 ? "s" : ""} (texto, sem arte)` : ""}.<br>
        Responda este e-mail com o aval ou com os ajustes. O que for aprovado entra na fila e &eacute; publicado no dia e no hor&aacute;rio.
      </div>
    </td></tr>
    <tr><td style="padding:30px 32px 6px">
      <table width="100%" cellpadding="0" cellspacing="0">${blocos}</table>
    </td></tr>
    <tr><td style="padding:18px 32px 32px;border-top:1px solid #e3e8ec">
      <div style="font:13px/1.5 Arial,sans-serif;color:#7b8893">
        Gerado automaticamente pelo cockpit da ABREV em ${new Date().toLocaleDateString("pt-BR")}.<br>
        Associa&ccedil;&atilde;o Brasileira de Reversa do Varejo
      </div>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

// ---- SMTP sem dependência ----
// O workflow do GitHub não roda npm install, então nada de nodemailer: aqui é TLS direto
// na 465 com AUTH LOGIN, que é o que o Gmail aceita com senha de app.
//
// Resposta de SMTP pode vir em várias linhas ("250-PIPELINING" ... "250 OK"); só a linha
// com espaço depois do código fecha a resposta. Por isso o buffer é lido linha a linha.
function cliente(socket) {
  let buffer = "";
  const respostas = [];
  let espera = null;
  socket.setEncoding("utf8");

  const drenar = () => {
    for (;;) {
      const linhas = buffer.split("\r\n");
      const fim = linhas.findIndex((l) => /^\d{3} /.test(l));
      if (fim < 0) break;
      respostas.push(linhas.slice(0, fim + 1).join("\n"));
      buffer = linhas.slice(fim + 1).join("\r\n");
    }
    if (espera && respostas.length) { const e = espera; espera = null; e(respostas.shift()); }
  };
  socket.on("data", (c) => { buffer += c; drenar(); });

  const ler = () => new Promise((resolve) => {
    if (respostas.length) resolve(respostas.shift()); else espera = resolve;
  });

  return {
    ler,
    async cmd(texto, esperado, rotulo = texto.split(" ")[0]) {
      socket.write(texto + "\r\n");
      const r = await ler();
      if (!esperado.test(r)) throw new Error(`SMTP recusou ${rotulo}: ${r.trim()}`);
      return r;
    },
    bruto: (texto) => socket.write(texto),
  };
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

async function enviar({ para, copia, assunto, html }) {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER, pass = process.env.SMTP_PASS;
  if (!user || !pass) {
    throw new Error("SMTP_USER/SMTP_PASS ausentes — sem eles nada é enviado. Use uma senha de app do Gmail.");
  }
  const destinos = [...para, ...copia];

  const socket = connect({ host, port, servername: host });
  socket.setTimeout(60000, () => socket.destroy(new Error("SMTP sem resposta (timeout)")));
  await new Promise((ok, erro) => { socket.once("secureConnect", ok); socket.once("error", erro); });

  const c = cliente(socket);
  try {
    const saudacao = await c.ler();
    if (!/^220/.test(saudacao)) throw new Error(`SMTP recusou a conexão: ${saudacao.trim()}`);
    await c.cmd("EHLO abrev.org", /^250/);
    await c.cmd("AUTH LOGIN", /^334/);
    await c.cmd(b64(user), /^334/, "o usuário");
    await c.cmd(b64(pass), /^235/, "a senha");   // a senha nunca aparece em log
    await c.cmd(`MAIL FROM:<${user}>`, /^250/);
    for (const d of destinos) await c.cmd(`RCPT TO:<${d}>`, /^25[01]/, `o destinatário ${d}`);
    await c.cmd("DATA", /^354/);

    const corpo = [
      `From: ABREV <${user}>`,
      `To: ${para.join(", ")}`,
      copia.length ? `Cc: ${copia.join(", ")}` : null,
      `Subject: =?UTF-8?B?${b64(assunto)}?=`,
      `Date: ${new Date().toUTCString()}`,
      "MIME-Version: 1.0",
      'Content-Type: text/html; charset="utf-8"',
      "Content-Transfer-Encoding: base64",
      "",
      b64(html).replace(/(.{76})/g, "$1\r\n"),
    ].filter((l) => l !== null).join("\r\n");
    // Linha que começa com ponto encerraria o DATA no meio da mensagem.
    c.bruto(corpo.replace(/\r\n\./g, "\r\n..") + "\r\n.\r\n");

    const r = await c.ler();
    if (!/^250/.test(r)) throw new Error(`SMTP recusou a mensagem: ${r.trim()}`);
    await c.cmd("QUIT", /^221/).catch(() => {});
  } finally {
    socket.destroy();
  }
  return destinos;
}

async function run({ enviarAgora, semMidia, mes, ano }) {
  const cards = await trello(`/lists/${LIST_RASCUNHO}/cards`, {
    fields: "name,desc", attachments: "true", attachment_fields: "name,isUpload,url",
  });
  const pautas = cards.map(lerCard).filter((p) => p && p.mes === mes).sort((a, b) => a.dia - b.dia);
  console.log(`${pautas.length} pauta(s) de ${MESES[mes - 1]}/${ano} em Rascunho (de ${cards.length} card(s) na lista).`);
  if (!pautas.length) {
    throw new Error(`nenhuma pauta de ${MESES[mes - 1]} na lista Rascunho — gere o cronograma antes do disparo.`);
  }

  if (semMidia) {
    console.log("[--sem-midia] pulando o host: o HTML sai com moldura no lugar das artes.");
    for (const p of pautas) p.urls = p.artes.map(() => "");
  } else {
    console.log("publicando as artes no host de mídia...");
    await publicarArtes(pautas);
  }
  const semArte = pautas.filter((p) => !p.urls.length && !p.artigo);
  if (semArte.length) {
    console.log(`AVISO: ${semArte.length} pauta(s) sem arte: ${semArte.map((p) => `${dd(p.dia)}/${dd(p.mes)} ${p.tema}`).join("; ")}`);
  }

  const html = montarHtml(pautas, mes, ano);
  const arquivo = `aprovacao-${ano}-${dd(mes)}.html`;
  await writeFile(arquivo, html);
  console.log(`e-mail montado: ${arquivo} (${(html.length / 1024).toFixed(0)} KB)`);

  if (!enviarAgora) {
    console.log("\n[PRÉVIA] nada foi enviado. Abra o arquivo para conferir e rode com --enviar para disparar.");
    return;
  }

  const para = (process.env.APROVACAO_PARA || "").split(",").map((s) => s.trim()).filter(Boolean);
  // Cópia sempre para quem administra: o disparo nunca sai sem você receber o que saiu.
  const copia = (process.env.APROVACAO_COPIA || "administradorabrev@gmail.com")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (!para.length) throw new Error("APROVACAO_PARA vazio — defina os destinatários antes de enviar.");

  const destinos = await enviar({
    para, copia,
    assunto: `ABREV · cronograma de ${MESES[mes - 1]}/${ano} para aprovação`,
    html,
  });
  console.log(`enviado para: ${destinos.join(", ")}`);
}

const args = process.argv.slice(2);
const arg = (n) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? Number(a.split("=")[1]) : null;
};
// Sem --mes, o alvo é o mês SEGUINTE: o disparo do dia 20 aprova o cronograma do próximo mês.
const hoje = new Date();
const proximo = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 1);
run({
  enviarAgora: args.includes("--enviar"),
  // --sem-midia: monta o HTML sem subir nada para o repositório público. Serve para
  // conferir o texto e o layout sem deixar rastro no host de mídia.
  semMidia: args.includes("--sem-midia"),
  mes: arg("mes") || Number(process.env.APROVACAO_MES) || proximo.getMonth() + 1,
  ano: arg("ano") || Number(process.env.APROVACAO_ANO) || proximo.getFullYear(),
}).catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
