#!/usr/bin/env node
// Gerador de Reels da ABREV: pega vídeo de banco gratuito, aplica a identidade por cima
// e entrega um MP4 9:16 pronto para o Instagram.
//
// POR QUE NÃO SAI DA ESTEIRA: a esteira do cockpit gera IMAGEM. Reel precisa de vídeo, e
// gerar vídeo por IA custa caro (ordem de dólares por peça, contra US$ 0,13 de uma
// imagem). O caminho barato é o mesmo que já usamos para foto: banco gratuito de
// terceiros (Pixabay, uso comercial liberado, sem exigir atribuição) com a arte da ABREV
// sobreposta. O custo é zero e o visual é nosso.
//
// O que entra no vídeo:
//   fundo   = footage do Pixabay, recortado para 1080x1920
//   escurecimento = degradê sobre o footage, senão o texto branco some no fundo claro
//   frente  = PNG transparente com topbar, logo, pill, título e rodapé da ABREV
//   áudio   = faixa silenciosa (o Instagram engasga com vídeo sem trilha de áudio)
//
// O footage baixado fica em banco_videos/ e é reaproveitado: o mesmo tema não baixa duas
// vezes, e a escolha evita o clipe menos usado para os reels não ficarem todos iguais.
//
// Uso (CLI):  node --env-file=.env reel.mjs "Tema do post" "caixa devolucao esteira" saida.mp4
// Uso (import): import { gerarReel } from "./reel.mjs";

import { readFile, writeFile, mkdir, rm, stat, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const exec = promisify(execFile);
const DIR = dirname(fileURLToPath(import.meta.url));
const BANCO = join(DIR, "banco_videos");
const INDICE = join(BANCO, "index.json");
const DURACAO = 10;      // segundos; reel institucional curto segura melhor a retenção
const LARGURA = 1080, ALTURA = 1920;

async function ffmpeg() {
  const m = await import("ffmpeg-static").catch(() => null);
  if (!m?.default) throw new Error("ffmpeg-static não instalado: rode `npm install ffmpeg-static`.");
  return m.default;
}

// ---- banco de footage ----
// Índice próprio, separado do banco_imagens: lá o contrato combinado com o ChatGPT é de
// PNG de sujeito recortado, e servir um .mp4 naquele índice quebraria quem o consome.
async function lerIndice() {
  try { return JSON.parse(await readFile(INDICE, "utf8")); } catch { return []; }
}

async function gravarIndice(itens) {
  await mkdir(BANCO, { recursive: true });
  const tmp = INDICE + ".tmp" + process.pid;
  await writeFile(tmp, JSON.stringify(itens, null, 2));
  await rename(tmp, INDICE);
}

const semAcento = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const palavras = (s) => semAcento(s).split(/[^a-z0-9]+/).filter((w) => w.length > 2);

function pontuar(consulta, tags) {
  const alvo = new Set(palavras(consulta));
  const t = new Set(palavras(tags));
  let score = 0;
  for (const p of alvo) if (t.has(p)) score++;
  return score;
}

// Procura no que já foi baixado. Desempate pelo menos usado, para não repetir o mesmo
// clipe em todos os reels do mês.
// Recebe a consulta JÁ traduzida: o índice guarda tags em inglês, e comparar com as
// palavras do card em português não casava nunca — o banco existia e não era usado.
async function buscarLocal(consulta, excluir = []) {
  const itens = await lerIndice();
  let melhor = null;
  for (const it of itens) {
    if (excluir.includes(it.arquivo)) continue;
    const score = pontuar(consulta, `${it.tags} ${it.consulta || ""}`);
    // Limiar 2: com o banco pequeno, UMA tag em comum casa com tudo e os quatro reels
    // do mes saem com dois clipes repetidos. Match fraco vai buscar footage novo, e o
    // acervo cresce variado em vez de reciclar o mesmo plano.
    if (score >= 2 && (!melhor || score > melhor.score ||
        (score === melhor.score && (it.usos || 0) < (melhor.item.usos || 0)))) {
      melhor = { item: it, score };
    }
  }
  if (!melhor) return null;
  const arquivo = join(BANCO, melhor.item.arquivo);
  try { await stat(arquivo); } catch { return null; }   // índice apontando para o vazio
  return { arquivo, score: melhor.score, meta: melhor.item };
}

async function registrarUso(nome) {
  const itens = await lerIndice();
  const i = itens.findIndex((x) => x.arquivo === nome);
  if (i >= 0) { itens[i].usos = (itens[i].usos || 0) + 1; await gravarIndice(itens); }
}

// Busca no Pixabay e baixa. As palavras visuais do card são em português e o acervo é
// indexado em inglês, então a consulta passa por um dicionário dos termos que o nosso
// assunto usa. O que não estiver no dicionário vai como está — tag em português às vezes
// acerta, e errar aqui só significa cair no termo genérico.
const TRADUZ = {
  // Termo ambíguo em inglês vira expressão: "box" sozinho traz boxeador, "return" traz
  // tecla de teclado. O acervo é indexado em inglês, então a tradução é o que decide.
  caixa: "cardboard box", caixas: "cardboard boxes", devolucao: "parcel return",
  devolucoes: "parcel returns",
  pacote: "parcel", pacotes: "parcels", encomenda: "package", entrega: "delivery",
  estoque: "warehouse inventory", armazem: "warehouse", esteira: "conveyor",
  triagem: "sorting", caminhao: "truck", transporte: "transport", logistica: "logistics",
  loja: "store", varejo: "retail", cliente: "customer", compra: "shopping",
  ecommerce: "ecommerce", computador: "laptop", celular: "smartphone",
  reciclagem: "recycling", sustentabilidade: "sustainability", descarte: "waste",
  calendario: "calendar", dinheiro: "money", custo: "cost", alerta: "warning",
  atendimento: "customer service", reparo: "repair", revenda: "resale",
  presente: "gift", natal: "christmas", balanco: "analytics", grafico: "chart",
  entregador: "courier", motorista: "driver", galpao: "warehouse", prateleira: "shelf",
  embalagem: "packaging", etiqueta: "label", jornada: "journey", pico: "peak season",
};

// Tags que reprovam o clipe de cara. O acervo é generalista e as palavras do nosso
// assunto são ambíguas em inglês: "delivery" + "ecommerce" trouxe uma cena de cozinha,
// "box" trouxe um boxeador. Nenhuma dessas combina com logística reversa do varejo.
const VETO = new Set(("cooking cook food meal recipe kitchen restaurant grocery diet drink "
  + "boxer boxing fighting mma athlete sport fitness gym workout "
  + "wedding baby child pet dog cat animal nature flower beach party dance music "
  + "medical hospital surgery blood weapon military").split(" "));

function consultaEmIngles(visual) {
  const termos = palavras(visual).map((p) => TRADUZ[p] || p);
  return [...new Set(termos)].slice(0, 4).join(" ");
}


// Quantos pixels reais do clipe sobrevivem ao recorte vertical: a altura manda, e a
// largura só conta até a fatia 9:16 que vamos usar. É o que separa um 4K deitado nítido
// de um 720p que chega borrado.
function nitidez({ width, height }) {
  const larguraUtil = Math.min(width, height * (LARGURA / ALTURA));
  return Math.min(height, ALTURA) * larguraUtil;
}

async function baixarDoPixabay(q, excluir = []) {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) throw new Error("PIXABAY_API_KEY ausente (.env).");
  const url = `https://pixabay.com/api/videos/?key=${key}&q=${encodeURIComponent(q)}`
    + `&per_page=20&safesearch=true&order=popular`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pixabay ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const { hits = [] } = await res.json();

  const indice = await lerIndice();
  const jaTem = new Set(indice.map((i) => i.pixabayId));
  for (const nome of excluir) {
    const it = indice.find((i) => i.arquivo === nome);
    if (it) jaTem.add(it.pixabayId);
  }
  // Clipe curto demais vira loop visível; o grande demais só gasta banda, porque de
  // qualquer forma cortamos em DURACAO segundos.
  // A ordem que o Pixabay devolve É a relevância. Ordenar por tamanho aqui, como fiz
  // antes, trocava o clipe certo pelo arquivo mais leve e trazia qualquer coisa.
  // Então: mantém a ordem deles e só exige que as tags encostem na consulta.
  const termos = new Set(palavras(q));
  // Resolução importa mais do que parece: recortar 9:16 de um clipe 16:9 aproveita só um
  // terço da largura original, então um 1280x720 chega borrado em 1080x1920. Pegamos
  // sempre a maior versão, e um clipe já vertical vale mais que um deitado maior.
  const melhorArquivo = (v) => [v.large, v.medium, v.small]
    .filter((x) => x?.url)
    .sort((a, b) => b.width * b.height - a.width * a.height)[0];
  // Ordenar por nitidez primeiro trouxe um boxeador em 4K para um post sobre caixa de
  // devolução: "box" sozinho é ambíguo demais. Então relevância manda — quantos termos
  // da consulta a tag encosta, e a ordem do próprio Pixabay como segundo critério — e a
  // nitidez só desempata entre os finalistas.
  const candidatos = hits
    .filter((h) => h.duration >= 5 && !jaTem.has(h.id))
    .map((h, rank) => {
      const tags = new Set(palavras(h.tags));
      let acertos = 0;
      for (const t of termos) if (tags.has(t)) acertos++;
      return { hit: h, rank, acertos, arquivo: melhorArquivo(h.videos) };
    })
    .filter((x) => x.arquivo?.url && x.acertos > 0)
    // O veto só vale para palavra que a consulta NÃO pediu: se o card pedir "comida",
    // comida deixa de ser motivo de reprovação.
    .filter((x) => !palavras(x.hit.tags).some((t) => VETO.has(t) && !termos.has(t)))
    .sort((a, b) => b.acertos - a.acertos || a.rank - b.rank);

  // Dois acertos, sempre. Com "pelo menos o melhor que houver" entrou um clipe de três
  // tags chamado "presentation" que casou só em "cardboard" e chegou no feed como uma
  // tela branca. Um acerto único numa consulta de vários termos é homônimo, não acerto.
  const bom = candidatos
    .filter((x) => x.acertos >= 2)
    .slice(0, 5)
    .sort((a, b) => nitidez(b.arquivo) - nitidez(a.arquivo));
  // Falhar aqui é melhor que servir qualquer coisa: o card fica com a capa, o resumo
  // mostra o reel que não saiu, e as palavras do [VISUAL] podem ser ajustadas.
  if (!bom.length) throw new Error(`nenhum footage casou com "${q}" em dois termos; ajuste o [VISUAL] do card.`);

  await mkdir(BANCO, { recursive: true });
  const escolhido = bom[0];
  const nome = `pixabay-${escolhido.hit.id}.mp4`;
  const destino = join(BANCO, nome);
  const bin = await fetch(escolhido.arquivo.url);
  if (!bin.ok) throw new Error(`download do vídeo ${bin.status}`);
  await writeFile(destino, Buffer.from(await bin.arrayBuffer()));

  const itens = await lerIndice();
  itens.push({
    arquivo: nome,
    pixabayId: escolhido.hit.id,
    tags: escolhido.hit.tags,
    consulta: q,
    duracao: escolhido.hit.duration,
    w: escolhido.arquivo.width,
    h: escolhido.arquivo.height,
    origem: "pixabay",
    credito: escolhido.hit.user,
    criadoEm: new Date().toISOString().slice(0, 10),
    usos: 0,
  });
  await gravarIndice(itens);
  return { arquivo: destino, meta: itens[itens.length - 1], novo: true };
}

// excluir: clipes ja usados nesta rodada. Sem isso, o desempate "menos usado" revezava
// entre os mesmos dois videos e o mes inteiro ficava com cara de repetido.
export async function acharFootage(visual, { excluir = [] } = {}) {
  const q = consultaEmIngles(visual);
  const local = await buscarLocal(q, excluir);
  if (local) return { ...local, novo: false };
  return baixarDoPixabay(q, excluir);
}

// ---- camada da ABREV ----
// PNG transparente de 1080x1920 renderizado no Chrome, pelo mesmo caminho do compositor
// das artes. O degradê escuro vai aqui dentro, e não num filtro do ffmpeg, para o texto
// ter sempre o mesmo contraste independente do footage.
async function montarOverlay(spec, saida) {
  const { default: puppeteer } = await import("puppeteer");
  const icone = "data:image/png;base64," +
    (await readFile(join(DIR, "template_social/icon_transp.png"))).toString("base64");
  const esc = (s) => String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const destaque = spec.highlight ? ` <span class="hl">${esc(spec.highlight)}</span>` : "";

  const html = `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700;800;900&display=swap">
<style>
  /* Paleta OFICIAL do Kit de Identidade Visual da ABREV (Drive, rev. 23/09/2026).
     Os valores antigos eram aproximacoes de olho e nenhum batia com o manual. */
  :root{--navy:#1B2F3F;--green:#A0C342;--teal:#08A2A9;--sky:#32B9EA;--yellow:#FEC915;
    --creme:#FEFBF5;--ink:#1B2F3F;
    --petroleo:#1B2F3F}
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{background:transparent}
  #reel{width:${LARGURA}px;height:${ALTURA}px;position:relative;overflow:hidden;color:var(--creme);
    font-family:"Montserrat",Gotham,Arial,sans-serif}
  /* escurece topo e base, que é onde fica o texto; o meio do footage continua limpo */
  .scrim{position:absolute;inset:0;background:
    linear-gradient(180deg,rgba(16,29,39,.90) 0%,rgba(16,29,39,.84) 26%,
    rgba(16,29,39,.12) 46%,rgba(16,29,39,.18) 58%,rgba(16,29,39,.80) 76%,
    rgba(16,29,39,.96) 100%)}
  #topbar{position:absolute;top:0;left:0;right:0;height:14px;
    background:linear-gradient(90deg,var(--green),var(--teal) 38%,var(--sky) 66%,var(--yellow))}
  .pad{position:absolute;inset:0;padding:120px 84px 150px;display:flex;flex-direction:column}
  .head{display:flex;align-items:center;gap:20px}
  .head img{width:104px;height:104px;object-fit:contain;background:rgba(15,34,52,.82);
    border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:11px}
  .head .tag{font-weight:700;letter-spacing:.14em;font-size:28px;color:var(--creme);text-transform:uppercase;line-height:1.2;white-space:nowrap}
  .pill{align-self:flex-start;margin-top:64px;background:var(--yellow);color:var(--ink);
    font-family:"Montserrat";font-weight:800;font-size:27px;letter-spacing:.03em;text-transform:uppercase;
    padding:16px 28px;border-radius:14px}
  h1{font-family:"Montserrat";font-weight:800;font-size:86px;line-height:1.05;margin-top:36px;
    letter-spacing:-.01em;max-width:15ch;text-shadow:0 4px 28px rgba(0,0,0,.45)}
  h1 .hl{color:var(--yellow)}
  /* sub e rodapé viajam juntos para a base. Com o margin-top:auto solto no .sub, a peça
     sem subtítulo jogava o rodapé para debaixo do título e deixava meia tela vazia. */
  .base{margin-top:auto}
  .sub{font-size:34px;line-height:1.35;color:rgba(255,255,255,.92);max-width:20ch;
    text-shadow:0 2px 18px rgba(0,0,0,.5)}
  .foot{margin-top:40px;padding-top:30px;border-top:1px solid rgba(255,255,255,.22);
    display:flex;align-items:flex-end;justify-content:space-between}
  .foot .src{font-size:26px;line-height:1.35;color:rgba(255,255,255,.9);max-width:24ch}
  .foot img{width:92px;height:92px;object-fit:contain;background:rgba(15,34,52,.82);
    border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:9px}
</style></head>
<body><div id="reel">
  <div class="scrim"></div>
  <div id="topbar"></div>
  <div class="pad">
    <div class="head"><img src="${icone}" alt="ABREV"><div class="tag">Logística Reversa do Varejo</div></div>
    ${spec.eyebrow ? `<span class="pill">${esc(spec.eyebrow)}</span>` : ""}
    <h1>${esc(spec.title)}${destaque}</h1>
    <div class="base">
      ${spec.subtitle ? `<p class="sub">${esc(spec.subtitle)}</p>` : ""}
      <div class="foot">
        <div class="src">${esc(spec.source || "ABREV · Associação Brasileira de Reversa do Varejo")}</div>
        <img src="${icone}" alt="">
      </div>
    </div>
  </div>
</div></body></html>`;

  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: LARGURA, height: ALTURA, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.evaluate(async () => { try { await document.fonts.ready; } catch {} });
    await new Promise((r) => setTimeout(r, 250));
    await (await page.$("#reel")).screenshot({ path: saida, type: "png", omitBackground: true });
  } finally { await browser.close(); }
  return saida;
}

// ---- montagem ----
export async function gerarReel(spec, saida, { duracao = DURACAO, excluir = [] } = {}) {
  const visual = spec.visual || spec.title;
  const footage = await acharFootage(visual, { excluir });
  console.log(`  footage: ${footage.novo ? "baixado do Pixabay" : "reaproveitado do banco"} — ${footage.meta.arquivo} (${footage.meta.tags.split(",")[0]})`);

  const dir = join(tmpdir(), `abrev-reel-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  try {
    const overlay = join(dir, "overlay.png");
    await montarOverlay(spec, overlay);

    // -stream_loop -1 repete o footage curto até fechar a duração; o crop pega o centro
    // depois de ampliar, que é o enquadramento menos pior para passar de 16:9 a 9:16.
    const bin = await ffmpeg();
    const args = [
      "-y",
      "-stream_loop", "-1", "-i", footage.arquivo,
      "-i", overlay,
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-t", String(duracao),
      "-filter_complex",
      `[0:v]scale=${LARGURA}:${ALTURA}:force_original_aspect_ratio=increase,` +
      `crop=${LARGURA}:${ALTURA},setsar=1,fps=30[bg];[bg][1:v]overlay=0:0[v]`,
      "-map", "[v]", "-map", "2:a",
      "-c:v", "libx264", "-preset", "medium", "-crf", "21", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      saida,
    ];
    await exec(bin, args, { maxBuffer: 1024 * 1024 * 32 });
    if (!footage.novo) await registrarUso(footage.meta.arquivo);
    const { size } = await stat(saida);
    console.log(`  reel: ${saida} (${(size / 1e6).toFixed(1)} MB, ${duracao}s, ${LARGURA}x${ALTURA})`);
    return { arquivo: saida, footage: footage.meta };
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [tema, visual, saida] = process.argv.slice(2);
  if (!tema) {
    console.error('uso: node --env-file=.env reel.mjs "Tema do post" "palavras visuais" [saida.mp4]');
    process.exit(1);
  }
  await gerarReel({ title: tema, visual: visual || tema }, saida || "reel.mp4");
}
