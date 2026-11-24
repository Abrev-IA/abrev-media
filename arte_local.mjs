#!/usr/bin/env node
// Compõe as artes AQUI, sem passar pela esteira do cockpit: pega o texto que já está no
// card do Trello, a foto do banco, e renderiza com o compositor.
//
// POR QUE EXISTE: a esteira custa crédito por peça e é ela quem decide o visual. Aqui o
// custo é zero e a identidade é determinística — mesma paleta, mesma fonte, sempre.
// O que se perde é o copywriter e a auditoria visual da esteira. Por isso este caminho
// só reaproveita texto JÁ ESCRITO no card; ele não inventa frase nenhuma.
//
// Mapa de uma pauta para páginas:
//   Stories        -> 1 peça 9:16 com a chamada curta
//   Reel / estático-> 1 peça 4:5 com tema e primeira frase
//   Carrossel      -> capa com foto + uma página por parágrafo do texto
//
// Uso (import): import { paginasDoCard } from "./arte_local.mjs";
//       (CLI):  node --env-file=.env arte_local.mjs "03/12" saida/

import { render } from "./compositor.mjs";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

// A legenda é só o texto antes do primeiro marcador — igual ao art_routine. Depois dele
// vem [RASCUNHO], [VISUAL] e nota de conferência, que são bastidor.
export function legendaDoCard(desc) {
  const linhas = String(desc || "").split(/\r?\n/);
  const marcador = (l) => {
    const s = l.trim();
    return s.startsWith("[") || /^[^a-zà-ÿ]{6,}[—-]\s*\d{2}\/\d{2}\/\d{2,4}\s*$/.test(s);
  };
  const corte = linhas.findIndex(marcador);
  return (corte < 0 ? linhas : linhas.slice(0, corte)).join("\n").trim();
}

// Parágrafos de verdade, sem a linha de hashtags (ela é para o caption, não para a arte).
function paragrafos(legenda) {
  return legenda
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p && !/^#\w/.test(p));
}

// O amarelo cai no fecho do título, que é onde está a carga da frase. Duas palavras erra
// menos que tentar adivinhar "a palavra importante".
function partirTitulo(tema) {
  const partes = tema.split(/\s+/);
  if (partes.length <= 3) return { title: tema, highlight: "" };
  return { title: partes.slice(0, -2).join(" "), highlight: partes.slice(-2).join(" ") };
}

const frases = (texto) => String(texto || "").split(/(?<=[.!?])\s/).map((f) => f.trim()).filter(Boolean);
const primeiraFrase = (texto) => frases(texto)[0] || String(texto || "").trim();

// Parágrafo comprido vira corpo minúsculo no autofit e ninguém lê no feed. Acima de 200
// caracteres a página fica com as duas primeiras frases; o resto já está na legenda.
function paraPagina(paragrafo) {
  if (paragrafo.length <= 200) return paragrafo;
  const f = frases(paragrafo);
  let saida = f[0];
  if (f[1] && (saida + " " + f[1]).length <= 240) saida += " " + f[1];
  return saida;
}

export function temaDoCard(nome) {
  return nome.replace(/^\d{2}\/\d{2}\s*·\s*[^·]+·\s*/, "").trim();
}


// Card de Stories não traz legenda: traz um briefing. O cabeçalho é instrução operacional
// ("STORY DE APOIO ... NÃO mover para Agendado"), e o texto da peça está entre aspas,
// dentro de um beat numerado — tipicamente "1) TEASER". Renderizar a descrição inteira
// poria "NÃO mover para Agendado" dentro da arte.
//
// Devolve o texto do primeiro beat, ou null quando o card não segue o formato.
export function textoDeStory(desc) {
  const texto = String(desc || "");
  const beat = texto.match(/\n\s*1\)[^\n]*\n\s*["“]([^"”]{10,400})["”]/);
  if (beat) return beat[1].replace(/\s+/g, " ").trim();
  const solta = texto.match(/["“]([^"”]{20,400})["”]/);
  return solta ? solta[1].replace(/\s+/g, " ").trim() : null;
}

// Quantos beats o card descreve e o que cada um é. Serve para avisar o que a API não
// consegue publicar: enquete e caixa de perguntas são figurinhas interativas, e a
// Graph API publica só a imagem.
export function beatsDeStory(desc) {
  const beats = [];
  for (const l of String(desc || "").split(/\r?\n/)) {
    const m = l.match(/^\s*(\d)\)\s*(.+)$/);
    if (m) {
      beats.push({
        n: Number(m[1]),
        rotulo: m[2].trim(),
        interativo: /enquete|pergunta|quiz|caixa de/i.test(m[2]),
      });
    }
  }
  return beats;
}

// Devolve a lista de specs prontos para o compositor. `foto` é o caminho da imagem do
// banco (pode faltar: a peça então sai tipográfica, que é melhor que peça sem arte).
// Rodízio de fundos. `variante` é um número estável da peça (o dia do mês serve): a mesma
// peça sai sempre igual, e peças vizinhas saem diferentes. Antes tudo era navy ou foto.
//   stories        → tipográfico em fundo claro, girando creme/lima/celeste/amarelo
//   capa e post    → foto com véu navy ou teal, alternando
//   miolo carrossel→ creme na 1ª página interna, depois teal/lima/celeste
const CLAROS = ["creme", "lima", "celeste", "amarelo"];
const temaFoto = (v) => (v % 2 ? "teal" : "navy");
const temaMiolo = (v, i) => (i === 0 ? "creme" : ["teal", "lima", "celeste"][(v + i) % 3]);

export function paginasDoCard(card, { formato = "post", paginas = 3, foto = null, variante = 0 } = {}) {
  const tema = temaDoCard(card.name);
  const { title, highlight } = partirTitulo(tema);
  const partes = paragrafos(legendaDoCard(card.desc));
  const assinatura = "ABREV · Associação Brasileira de Reversa do Varejo";

  if (formato === "story") {
    // O "tema" do titulo de um card de story e anotacao interna — "apoio ao Carrossel
    // tal". Nao serve de manchete. A manchete sai do proprio texto da story: primeira
    // frase no titulo, o resto no subtitulo.
    const linha = textoDeStory(card.desc) || primeiraFrase(partes[0] || "") || tema;
    const f = frases(linha);
    const manchete = f[0] || linha;
    const resto = f.slice(1).join(" ").trim();
    const corte = partirTitulo(manchete);
    // Story sai tipográfica em cor clara: é a peça que mais aparece em sequência, e com
    // foto+véu toda story ficava igual ao post que ela apoia.
    return [{
      formato: "story", kind: resto ? "quote" : "respiro", tema: CLAROS[variante % CLAROS.length],
      eyebrow: "ABREV",
      title: corte.title, highlight: corte.highlight,
      quote: resto ? paraPagina(resto) : undefined,
      source: assinatura,
    }];
  }

  if (paginas <= 1) {
    return [{
      formato: "post", kind: foto ? "foto" : "quote", tema: foto ? temaFoto(variante) : "creme",
      title, highlight,
      image: foto || undefined,
      subtitle: foto ? primeiraFrase(partes[0] || "") : undefined,
      quote: foto ? undefined : (partes[0] || tema),
      source: assinatura,
    }];
  }

  // Carrossel: capa com a foto, depois uma página por parágrafo. Se o texto tiver menos
  // parágrafos que as páginas pedidas, a peça encurta — melhor três páginas boas que
  // cinco com enchimento.
  const corpo = partes.slice(1, paginas);
  const total = 1 + corpo.length;
  const selo = (i) => `${String(i + 1).padStart(2, "0")}/${String(total).padStart(2, "0")}`;

  const capa = {
    formato: "post", kind: foto ? "foto" : "cover", tema: foto ? temaFoto(variante) : "navy",
    title, highlight,
    image: foto || undefined,
    subtitle: primeiraFrase(partes[0] || ""),
    badge: selo(0), source: assinatura,
  };
  return [capa, ...corpo.map((p, i) => ({
    formato: "post", kind: "texto", tema: temaMiolo(variante, i),
    quote: paraPagina(p),
    badge: selo(i + 1),
    source: i === corpo.length - 1 ? assinatura : undefined,
  }))];
}

// Renderiza as páginas de um card em disco e devolve os caminhos.
export async function renderizarCard(card, opcoes = {}, destino = ".") {
  await mkdir(destino, { recursive: true });
  const specs = paginasDoCard(card, opcoes);
  const base = card.name.replace(/[^\w]+/g, "_").slice(0, 40);
  const saidas = [];
  for (let i = 0; i < specs.length; i++) {
    const arquivo = join(destino, `${base}_p${String(i + 1).padStart(2, "0")}.png`);
    await render(specs[i], arquivo);
    saidas.push(arquivo);
  }
  return saidas;
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const [filtro, destino = "artes_local"] = process.argv.slice(2);
  const T = "https://api.trello.com/1";
  const k = process.env.TRELLO_KEY, t = process.env.TRELLO_TOKEN;
  const lista = process.env.TRELLO_LIST_RASCUNHO || "6ad43ed930b50a2b6519bdf7";
  const cards = await (await fetch(`${T}/lists/${lista}/cards?fields=name,desc&key=${k}&token=${t}`)).json();
  const alvo = cards.filter((c) => !filtro || c.name.includes(filtro));
  const { buscarImagem, imagemPadrao } = await import("./image_bank.mjs");
  const usadas = [];
  for (const card of alvo) {
    if (/newsletter/i.test(card.name)) { console.log("PULA (newsletter):", card.name); continue; }
    const story = /stories/i.test(card.name);
    const paginas = /carrossel/i.test(card.name) ? 3 : 1;
    const linha = (card.desc || "").split(/\r?\n/).find((l) => l.trim().toUpperCase().startsWith("[VISUAL]"));
    const visual = linha ? linha.replace(/\[VISUAL\]/i, "").trim() : null;
    const achado = (visual ? await buscarImagem(visual, { minimo: 1, excluir: usadas }) : null)
      || await imagemPadrao({ excluir: usadas }) || await imagemPadrao();
    if (achado) usadas.push(achado.meta.arquivo);
    const saidas = await renderizarCard(card, { formato: story ? "story" : "post", paginas, foto: achado?.arquivo, variante: Number(card.name.slice(0, 2)) || 0 }, destino);
    console.log(`${card.name.slice(0, 44).padEnd(46)} ${saidas.length} pág.  ${achado ? achado.meta.arquivo.slice(0, 22) : "sem foto"}`);
  }
}
