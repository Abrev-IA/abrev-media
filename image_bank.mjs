// CONTRATO: banco_imagens/LEIA-ME.md — mais de um agente escreve aqui. Nunca mexa no
// index.json nem nos arquivos direto; a trava so vale para quem passa por este modulo.
// Banco de imagens da ABREV — acervo de sujeitos recortados (PNG com fundo transparente)
// reaproveitáveis nas artes.
//
// A regra do fluxo é: PROCURE AQUI PRIMEIRO. Só gere imagem nova quando o banco não tiver
// nada que sirva — e, ao gerar, grave aqui. Cada geração custa crédito (~US$ 0,13); cada
// reaproveitamento custa zero. Com o tempo o acervo satura e o custo tende a desaparecer.
//
// Estrutura: banco_imagens/<arquivo>.png + banco_imagens/index.json
//   index.json: [{ arquivo, tags: [], origem, criadoEm, w, h, usos }]
//
// Uso: node image_bank.mjs listar
//      node image_bank.mjs buscar "devolucao caixa varejo"

import { readFile, writeFile, mkdir, copyFile, rename, rm, stat } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Relativo ao módulo, não caminho absoluto desta máquina: o mesmo arquivo roda no runner
// do GitHub, onde "C:/Users/Projeto" não existe.
const RAIZ = dirname(fileURLToPath(import.meta.url));
const DIR = join(RAIZ, "banco_imagens");
const INDEX = join(DIR, "index.json");

// O acervo completo são 146 MB e fica só aqui. Para o cron, viaja uma pasta pequena com
// as fotos institucionais — as que entram quando a busca não acha o tema. Sem isso o
// padrão não existiria lá justamente onde ele mais importa, que é a geração automática.
const INSTITUCIONAL = join(RAIZ, "banco_institucional");

const semAcento = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const palavras = (s) => semAcento(s).split(/[^a-z0-9]+/).filter((w) => w.length > 2);

export async function lerIndice() {
  try { return JSON.parse(await readFile(INDEX, "utf8")); } catch { return []; }
}

// Trava de arquivo. Mais de um agente mexe neste banco (eu e o ChatGPT), e sem isso
// dois processos fazem ler-alterar-gravar ao mesmo tempo e um apaga o trabalho do outro.
// A gravacao tambem e atomica: escreve num temporario e renomeia.
async function travarIndice(timeoutMs = 10000) {
  const lock = INDEX + '.lock';
  const ate = Date.now() + timeoutMs;
  for (;;) {
    try { await writeFile(lock, String(process.pid), { flag: 'wx' }); return async () => { try { await rm(lock); } catch {} }; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // trava orfa de processo morto nao pode bloquear para sempre
      try { const st = await stat(lock); if (Date.now() - st.mtimeMs > 30000) { await rm(lock); continue; } } catch {}
      if (Date.now() > ate) throw new Error('banco de imagens travado por outro processo; tente de novo');
      await new Promise((r) => setTimeout(r, 120));
    }
  }
}

async function gravarIndice(itens) {
  await mkdir(DIR, { recursive: true });
  const tmp = INDEX + '.tmp' + process.pid;
  await writeFile(tmp, JSON.stringify(itens, null, 2));
  await rename(tmp, INDEX);
}

// O que a foto MOSTRA, quando já foi olhada: tags_visuais + descricao. As tags antigas são
// as palavras da busca que trouxe a foto, não o conteúdo dela — foi assim que "esteira"
// virou fivela de cinto e "devolução" virou cesta de comida (passada visual de 22/11/2026).
// Foto ainda não anotada cai nas tags antigas.
const palavrasDaFoto = (it) => it.tags_visuais
  ? [it.tags_visuais, it.descricao || ""].flatMap(palavras)
  : (it.tags || []).flatMap(palavras);

// Busca por sobreposição de palavras entre o pedido e as tags. Devolve o melhor item
// acima do limiar, ou null — e null é o sinal de que vale gerar uma imagem nova.
export async function buscarImagem(texto, { minimo = 1, excluir = [] } = {}) {
  const alvo = new Set(palavras(texto));
  if (!alvo.size) return null;
  const itens = await lerIndice();
  const candidatos = [];
  for (const it of itens) {
    if (excluir.includes(it.arquivo)) continue;
    if (it.adequada === false) continue;
    const tags = new Set(palavrasDaFoto(it));
    let score = 0;
    for (const p of alvo) if (tags.has(p)) score++;
    if (score >= minimo) candidatos.push({ item: it, score });
  }
  // desempate: prefere o menos usado, para o acervo não repetir sempre a mesma imagem
  candidatos.sort((a, b) => b.score - a.score || (a.item.usos || 0) - (b.item.usos || 0));
  // Confere o arquivo antes de devolver: índice e pasta podem desencontrar, e um caminho
  // que não existe só estouraria lá na frente, na hora de compor a arte.
  for (const c of candidatos) {
    const caminho = join(DIR, c.item.arquivo);
    try { await stat(caminho); } catch { continue; }
    return { arquivo: caminho, score: c.score, meta: c.item };
  }
  return null;
}

// Grava uma imagem no acervo. Chame isto SEMPRE que gerar uma imagem nova, para que a
// próxima peça com o mesmo tema não precise gastar crédito de novo.
export async function salvarImagem(origemArquivo, tags, { origem = "gerada", w = null, h = null, nome = null, credito = null, fonte = null } = {}) {
  await mkdir(DIR, { recursive: true });
  const destravar = await travarIndice();
  try {
  const arquivo = nome || basename(origemArquivo);
  const destino = join(DIR, arquivo);
  if (origemArquivo !== destino) await copyFile(origemArquivo, destino);
  const itens = await lerIndice();
  const existente = itens.findIndex((i) => i.arquivo === arquivo);
  const registro = {
    arquivo,
    tags: [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))],
    origem,
    criadoEm: new Date().toISOString().slice(0, 10),
    w, h, credito, fonte,
    usos: existente >= 0 ? itens[existente].usos || 0 : 0,
  };
  if (existente >= 0) itens[existente] = registro; else itens.push(registro);
  await gravarIndice(itens);
  return registro;
  } finally { await destravar(); }
}

// Tira uma imagem do acervo SEM apagar: move para _descartadas/ e remove do indice,
// tudo sob trava. Mexer no arquivo na mao deixa o indice apontando para o vazio.
export async function descartarImagem(arquivo, motivo = "") {
  const nome = basename(arquivo);
  const destravar = await travarIndice();
  try {
    const itens = await lerIndice();
    const i = itens.findIndex((x) => x.arquivo === nome);
    if (i < 0) return { ok: false, motivo: "nao esta no indice" };
    await mkdir(join(DIR, "_descartadas"), { recursive: true });
    try { await rename(join(DIR, nome), join(DIR, "_descartadas", nome)); } catch {}
    const [removido] = itens.splice(i, 1);
    await gravarIndice(itens);
    return { ok: true, removido, motivo };
  } finally { await destravar(); }
}

// Marca (ou desmarca) uma foto como padrão institucional: é a que entra quando a busca
// não acha nada do tema. Antes disso, "não achou" caía na geração por IA, e era de lá que
// vinham os desenhos — um deles virou a mesa de reunião renderizada do card do Jantar.
export async function marcarPadrao(arquivo, valor = true) {
  const destravar = await travarIndice();
  try {
    const itens = await lerIndice();
    const i = itens.findIndex((x) => x.arquivo === basename(arquivo));
    if (i < 0) return { ok: false, motivo: "nao esta no indice" };
    itens[i].institucional = !!valor;
    await gravarIndice(itens);
    return { ok: true, item: itens[i] };
  } finally { await destravar(); }
}

// Gera a pasta que viaja para o repositório, a partir do que está marcado no banco.
// Rodar depois de mudar as marcações: node image_bank.mjs institucional
export async function sincronizarInstitucional() {
  const marcadas = (await lerIndice()).filter((i) => i.institucional);
  await mkdir(INSTITUCIONAL, { recursive: true });
  for (const i of marcadas) await copyFile(join(DIR, i.arquivo), join(INSTITUCIONAL, i.arquivo));
  await writeFile(join(INSTITUCIONAL, "index.json"), JSON.stringify(marcadas, null, 2));
  return marcadas.map((i) => i.arquivo);
}

// A foto institucional menos usada. Procura primeiro na pasta que viaja (a única que
// existe no runner) e só depois no banco completo. Devolve null quando não há nenhuma —
// aí quem chama decide, em vez de receber uma imagem qualquer achando que é padrão.
export async function imagemPadrao({ excluir = [] } = {}) {
  for (const base of [INSTITUCIONAL, DIR]) {
    let itens = [];
    try { itens = JSON.parse(await readFile(join(base, "index.json"), "utf8")); } catch { continue; }
    const candidatos = itens
      .filter((i) => i.institucional && i.adequada !== false && !excluir.includes(i.arquivo))
      .sort((a, b) => (a.usos || 0) - (b.usos || 0));
    for (const c of candidatos) {
      // Confere que o arquivo existe: índice e pasta podem desencontrar, e devolver um
      // caminho vazio só quebraria lá na frente, na hora de compor a arte.
      const caminho = join(base, c.arquivo);
      try { await stat(caminho); } catch { continue; }
      return { arquivo: caminho, score: 0, padrao: true, meta: c };
    }
  }
  return null;
}

// Grava o que a foto mostra, em lote e sob trava. anotacoes: { arquivo: {descricao,
// tags_visuais, adequada, motivo} }. adequada:false tira a foto da busca sem apagá-la.
export async function anotarImagens(anotacoes) {
  const destravar = await travarIndice();
  try {
    const itens = await lerIndice();
    let n = 0;
    for (const it of itens) {
      const a = anotacoes[it.arquivo];
      if (!a) continue;
      Object.assign(it, a, { anotadaEm: new Date().toISOString().slice(0, 10) });
      if (it.adequada === false && it.institucional) it.institucional = false;
      n++;
    }
    await gravarIndice(itens);
    return n;
  } finally { await destravar(); }
}

export async function registrarUso(arquivo) {
  const destravar = await travarIndice();
  try {
  const itens = await lerIndice();
  const i = itens.findIndex((x) => x.arquivo === basename(arquivo));
  if (i >= 0) { itens[i].usos = (itens[i].usos || 0) + 1; await gravarIndice(itens); }
  } finally { await destravar(); }
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "institucional") {
    const arqs = await sincronizarInstitucional();
    console.log(`${arqs.length} foto(s) copiadas para banco_institucional/:`);
    for (const a of arqs) console.log("   " + a);
  } else if (cmd === "anotar") {
    // node image_bank.mjs anotar <pasta com mapa.json + anot_*.json>
    const { readdir } = await import("node:fs/promises");
    const mapa = JSON.parse(await readFile(join(arg, "mapa.json"), "utf8"));
    const anot = {};
    for (const f of (await readdir(arg)).filter((f) => /^anot_\d+\.json$/.test(f)))
      for (const [num, descricao, tv, adequada, motivo] of JSON.parse(await readFile(join(arg, f), "utf8")))
        if (mapa[num]) anot[mapa[num]] = { descricao, tags_visuais: tv, adequada, ...(motivo ? { motivo } : {}) };
    const n = await anotarImagens(anot);
    console.log(`${Object.keys(anot).length} anotação(ões) lidas, ${n} aplicada(s) no índice`);
  } else if (cmd === "buscar") {
    const r = await buscarImagem(arg || "");
    console.log(r ? `achou (score ${r.score}): ${r.arquivo}\n  tags: ${r.meta.tags.join(", ")}` : "nada no banco — geraria imagem nova");
  } else {
    const itens = await lerIndice();
    console.log(`${itens.length} imagem(ns) no banco:\n`);
    for (const i of itens) console.log(`  ${i.arquivo}  [${i.w}x${i.h}]  usos:${i.usos || 0}\n     ${i.tags.join(", ")}`);
  }
}
