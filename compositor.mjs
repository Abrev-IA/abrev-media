#!/usr/bin/env node
// Compositor ABREV — gera as artes sociais no estilo oficial (fundo petróleo, barra
// colorida, logo oficial, pill, título com destaque, stat tiles ou imagem) e renderiza
// headless (Puppeteer) em 1080x1350. É o nosso motor: parametrizado por um "spec".
//
// spec = {
//   kind: "stats" | "image" | "cover" | "quote",
//   tagline?: "Logística Reversa do Varejo",
//   eyebrow?: "O CUSTO INVISÍVEL DA REVERSA",      // pill amarela (opcional)
//   title: "Quanto do seu faturamento volta pela porta",
//   highlight?: "dos fundos?",                      // trecho em amarelo (opcional)
//   subtitle?: "...",                               // abaixo do título (image/cover)
//   stats?: [{num:"12%", desc:"...", color:"sky|green|yellow|teal"}],  // kind stats
//   image?: "<path|dataURI>",                       // kind image (sujeito/foto)
//   quote?: "...", author?: "...",                  // kind quote
//   badge?: "02/05",                                // selo de página do carrossel
//   source?: "Levantamento ABREV · Estadão",        // rodapé (opcional)
// }
//
// Uso: import { render } from "./compositor.mjs"; await render(spec, "out.png");
//      CLI: node compositor.mjs sample [out.png]

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = dirname(fileURLToPath(import.meta.url));
let ICON = null;
async function icon() {
  if (!ICON) ICON = "data:image/png;base64," + (await readFile(join(DIR, "template_social/icon_transp.png"))).toString("base64");
  return ICON;
}
function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

async function resolveImage(src) {
  if (!src) return null;
  if (src.startsWith("data:")) return src;
  const buf = await readFile(src);
  const ext = src.toLowerCase().endsWith(".png") ? "png" : "jpeg";
  return `data:image/${ext};base64,${buf.toString("base64")}`;
}

// O feed e 1080x1350 e o Stories 1080x1920. Em vez de duplicar o CSS, a peca vertical
// usa a mesma folha com a altura maior e um respiro de topo/base proporcional.
const TAMANHOS = { post: { w: 1080, h: 1350 }, story: { w: 1080, h: 1920 } };
const medida = (spec) => TAMANHOS[spec.formato] || TAMANHOS.post;

// Texto longo em corpo fixo estoura a peca em silencio. Encolhe por faixa de tamanho:
// nao e tipografia fina, e a diferenca entre caber e vazar.
function corpoPara(texto, base, minimo) {
  const n = String(texto || "").length;
  if (n <= 90) return base;
  if (n <= 160) return Math.max(minimo, Math.round(base * 0.86));
  if (n <= 240) return Math.max(minimo, Math.round(base * 0.72));
  return minimo;
}

async function buildHtml(spec) {
  const ic = await icon();
  const tagline = esc(spec.tagline || "Logística Reversa do Varejo");
  const title = esc(spec.title || "");
  const hl = spec.highlight ? ` <span class="hl">${esc(spec.highlight)}</span>` : "";
  const img = await resolveImage(spec.image);
  const fundo = spec.kind === "foto" && img ? img : null;
  const dim = medida(spec);
  const vertical = dim.h > 1500;

  let body = "";
  if (spec.kind === "stats") {
    const tiles = (spec.stats || []).slice(0, 3).map((s) =>
      `<div class="tile"><div class="num n-${s.color || "teal"}">${esc(s.num)}</div><div class="desc">${esc(s.desc)}</div></div>`).join("");
    body = `<div class="stats">${tiles}</div>`;
  } else if (spec.kind === "image" && img) {
    body = `<div class="hero"><img src="${img}" alt=""></div>`;
  } else if (spec.kind === "foto" && img) {
    // A foto vai para o FUNDO da peça (ver .fundo/.veu), não para um painel no meio.
    // Antes era painel recortado, e a foto virava o assunto da peça — com uma cesta
    // básica ou um recorte 3D no lugar errado, o erro ficava em destaque. Como fundo
    // velado, ela dá textura sem disputar com o texto. Aqui fica só o respiro.
    body = `<div class="respiro"></div>`;
  } else if (spec.kind === "quote") {
    body = `<div class="quote">“${esc(spec.quote)}”${spec.author ? `<div class="author">${esc(spec.author)}</div>` : ""}</div>`;
  } else if (spec.kind === "texto") {
    // Mesmo bloco da citacao, sem as aspas: pagina de carrossel e narracao, nao fala de
    // alguem. Com aspas o texto da peca parecia citado de uma fonte que nao existe.
    body = `<div class="quote">${esc(spec.quote)}</div>`;
  }
  const subtitle = spec.subtitle ? `<p class="subtitle">${esc(spec.subtitle)}</p>` : "";
  const badge = spec.badge ? `<span class="badge">${esc(spec.badge)}</span>` : "";
  const source = spec.source
    ? `<div class="src">${esc(spec.source)}</div>`
    : `<div class="src">ABREV · Associação Brasileira de Reversa do Varejo</div>`;

  return `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700;800;900&display=swap">
<style>
  /* Paleta OFICIAL do Kit de Identidade Visual da ABREV (Drive, rev. 23/09/2026).
     Os valores antigos eram aproximacoes de olho e nenhum batia com o manual. */
  :root{--navy:#1B2F3F;--green:#A0C342;--teal:#08A2A9;--sky:#32B9EA;--yellow:#FEC915;
    --creme:#FEFBF5;--ink:#1B2F3F;
    --tile:rgba(255,255,255,.05);--line:rgba(255,255,255,.12)}
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{margin:0}
  #card{width:${dim.w}px;height:${dim.h}px;position:relative;overflow:hidden;color:var(--creme);
    font-family:"Montserrat",Gotham,Arial,sans-serif;
    background:radial-gradient(130% 80% at 15% -5%,#2A4760 0%,rgba(42,71,96,0) 55%),
      linear-gradient(158deg,#24405A 0%,#1B2F3F22 40%,#101D27 100%),var(--navy)}
  #topbar{position:absolute;top:0;left:0;right:0;height:12px;
    background:linear-gradient(90deg,var(--green),var(--teal) 38%,var(--sky) 66%,var(--yellow))}
  .pad{position:absolute;inset:0;padding:${vertical ? "150px 78px 160px" : "78px 76px 72px"};display:flex;flex-direction:column}
  .head{display:flex;align-items:center;gap:16px}
  .head img{width:88px;height:88px;object-fit:contain;background:#15242F;border:1px solid rgba(255,255,255,.08);border-radius:15px;padding:9px}
  .head .tag{font-weight:700;letter-spacing:.14em;font-size:23px;color:var(--creme);text-transform:uppercase}
  .pill{align-self:flex-start;margin-top:52px;background:var(--yellow);color:var(--ink);
    font-family:"Montserrat";font-weight:800;font-size:23px;letter-spacing:.03em;text-transform:uppercase;
    padding:13px 24px;border-radius:12px}
  h1{font-family:"Montserrat";font-weight:800;font-size:72px;line-height:1.04;margin-top:30px;letter-spacing:-.01em;max-width:17ch}
  h1 .hl{color:var(--yellow)}
  .subtitle{font-size:${corpoPara(spec.subtitle, vertical ? 34 : 30, 22)}px;line-height:1.35;color:rgba(254,251,245,.88);margin-top:24px;max-width:24ch}
  .badge{position:absolute;top:80px;right:76px;font-family:"Montserrat";font-weight:800;font-size:24px;
    color:var(--ink);background:#fff;opacity:.9;padding:6px 14px;border-radius:999px}
  /* corpo */
  .hero{flex:1;display:flex;align-items:center;justify-content:center;margin:34px 0 20px;min-height:0}
  .hero img{max-width:100%;max-height:100%;object-fit:contain;filter:drop-shadow(0 20px 40px rgba(0,0,0,.4))}
  .foto{flex:1;margin:34px 0 20px;min-height:0;position:relative;border-radius:22px;overflow:hidden;
    border:1px solid rgba(255,255,255,.10)}
  .foto img{width:100%;height:100%;object-fit:cover;display:block}
  .foto .fade{position:absolute;inset:0;
    background:linear-gradient(180deg,rgba(27,47,63,.18) 0%,rgba(27,47,63,0) 38%,rgba(16,29,39,.62) 100%)}
  .quote{flex:1;display:flex;flex-direction:column;justify-content:center;font-family:"Montserrat";font-weight:700;
    font-size:${corpoPara(spec.quote, vertical ? 56 : 50, 30)}px;line-height:1.25;color:var(--creme)}
  .quote .author{font-family:"Montserrat";font-weight:600;font-size:26px;color:var(--creme);margin-top:28px}
  /* auto nos dois lados: o bloco centraliza no espaço livre em vez de cair no rodapé,
     que deixava um vazio grande no meio quando a peça tem só um dado. */
  .stats{margin-top:auto;margin-bottom:auto;display:flex;gap:20px}
  .tile{flex:1;background:var(--tile);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:26px 24px}
  .tile .num{font-family:"Montserrat";font-weight:900;font-size:56px;line-height:1}
  .tile .desc{font-size:21px;line-height:1.28;color:rgba(255,255,255,.82);margin-top:14px}
  .n-teal{color:var(--teal)}.n-green{color:var(--green)}.n-yellow{color:var(--yellow)}.n-sky{color:var(--sky)}
  /* peça de um dado só: o bloco cresce para ocupar a peça, em vez de ficar uma faixa
     pequena perdida no meio do fundo */
  .stats:has(.tile:only-child) .tile{padding:52px 44px}
  .stats:has(.tile:only-child) .num{font-size:104px}
  .stats:has(.tile:only-child) .desc{font-size:27px;margin-top:20px;max-width:30ch}
  .foot{margin-top:auto;padding-top:26px;border-top:1px solid var(--line);display:flex;align-items:flex-end;justify-content:space-between}
  .foot .src{font-size:24px;line-height:1.35;color:rgba(255,255,255,.88);max-width:30ch}
  .foot img{width:80px;height:80px;object-fit:contain;background:#15242F;border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:8px}
  /* Foto como FUNDO da peça inteira, nunca como painel no meio. O véu navy cobre forte
     onde está o texto (topo e rodapé) e deixa a foto aparecer como textura no meio — é o
     padrão "foto como fundo, overlay navy" das especificações de template da ABREV. */
  .fundo{position:absolute;inset:0}
  .fundo img{width:100%;height:100%;object-fit:cover;display:block}
  .veu{position:absolute;inset:0;background:linear-gradient(180deg,
    rgba(16,29,39,.95) 0%,rgba(16,29,39,.86) 32%,rgba(16,29,39,.52) 56%,
    rgba(16,29,39,.62) 78%,rgba(16,29,39,.96) 100%)}
  .respiro{flex:1}
  .ring{position:absolute;right:-150px;bottom:120px;width:470px;height:470px;opacity:.028}
  .ring img{width:100%;height:100%;object-fit:contain}
</style></head>
<body>
<div id="card">
  ${fundo ? `<div class="fundo"><img src="${fundo}" alt=""><div class="veu"></div></div>` : ""}
  <div id="topbar"></div>
  <div class="ring"><img src="${ic}" alt=""></div>
  <div class="pad">
    ${badge}
    <div class="head"><img src="${ic}" alt="ABREV"><div class="tag">${tagline}</div></div>
    ${spec.eyebrow ? `<span class="pill">${esc(spec.eyebrow)}</span>` : ""}
    <h1>${title}${hl}</h1>
    ${subtitle}
    ${body}
    <div class="foot">${source}</div>
  </div>
</div>
</body></html>`;
}

export async function render(spec, outPath) {
  const { default: puppeteer } = await import("puppeteer");
  const html = await buildHtml(spec);
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    const dim = TAMANHOS[spec.formato] || TAMANHOS.post;
    await page.setViewport({ width: dim.w, height: dim.h, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.evaluate(async () => { try { await document.fonts.ready; } catch (e) {} });
    await new Promise((r) => setTimeout(r, 250));
    const el = await page.$("#card");
    await el.screenshot({ path: outPath, type: "png" });
    return outPath;
  } finally { await browser.close(); }
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const out = process.argv[3] || "template_social/compositor_sample.png";
  const sample = {
    kind: "stats",
    eyebrow: "O custo invisível da reversa",
    title: "Quanto do seu faturamento volta pela porta",
    highlight: "dos fundos?",
    stats: [
      { num: "12%", desc: "dos produtos comprados no e-commerce são devolvidos", color: "sky" },
      { num: "R$ 59 bi", desc: "em mercadorias devolvidas por ano no Brasil", color: "green" },
      { num: "3,6%", desc: "do faturamento pode ir para a logística reversa", color: "yellow" },
    ],
    source: "Levantamento ABREV · divulgado pelo Estadão · Coluna do Broadcast",
  };
  console.log("renderizando...");
  await render(sample, out);
  console.log("ok ->", out);
}
