#!/usr/bin/env node
// cronograma.mjs — PASSO 00 do ciclo: monta o cronograma editorial do mês seguinte como
// cartões na lista "Rascunho" do quadro Calendário ABREV.
//
// É o passo que faltava. A rotina de artes (art_routine), o e-mail de aprovação
// (aprovacao) e o publicador (publisher) todos LEEM a lista Rascunho; nenhum deles
// escrevia um cartão. Sem este passo o ciclo do mês seguinte simplesmente não começa:
// no dia 15 a rotina de artes acha só os cards do mês corrente, já prontos, e no dia 20
// o disparo de aprovação morre em "nenhuma pauta de <mês> na lista Rascunho".
//
// Duas camadas, de propósito separadas:
//   1) CALENDÁRIO — determinístico, sem IA. Calcula os slots do mês: que dia, que
//      formato, que data comercial. É a parte que não pode variar de execução para
//      execução, então não passa por modelo nenhum.
//   2) EDITORIAL — tema, legenda, palavras visuais e a legenda do Stories de apoio.
//      Consulta notas oficiais, exige aprovação A99 e guarda o parecer no cockpit.
//
// Para cada peça cria DOIS cartões, como o mês de novembro fez à mão: a peça e o
// Stories de apoio. Nenhum deles recebe `due` — `due` é o que o publicador usa para
// decidir que venceu, e quem põe data é a etapa de aprovação, ao mover para "Agendado".
// Cartão sem data em Rascunho é a trava que impede este script de publicar nada.
//
// Env: TRELLO_KEY, TRELLO_TOKEN. COCKPIT_USER, COCKPIT_PASSWORD. Opcionais:
//      TRELLO_LIST_RASCUNHO, CRONOGRAMA_MES (1-12), CRONOGRAMA_ANO.
//
// Uso: node --env-file=.env cronograma.mjs --dry-run   # mostra o plano, não escreve
//      node --env-file=.env cronograma.mjs             # cria os cartões
//      node cronograma.mjs --modelo                    # só gera o JSON do mês p/ preencher
//      node --env-file=.env cronograma.mjs --mes=12 --ano=2026

import { login } from "./art_runner.mjs";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const T = "https://api.trello.com/1";
const LIST_RASCUNHO = process.env.TRELLO_LIST_RASCUNHO || "6ad43ed930b50a2b6519bdf7";
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

// ---------------------------------------------------------------------------
// 1) CALENDÁRIO
// ---------------------------------------------------------------------------

// Cadência observada em novembro/2026, que é o mês que a equipe montou à mão:
// terça carrossel, quinta reel, newsletter na 2ª e na 4ª sexta. Mantida igual de
// propósito — o calendário novo não deve inventar ritmo diferente do que a associação
// já pratica.
const CADENCIA = { 2: "Carrossel", 4: "Reel" }; // getDay(): 0=dom ... 2=ter, 4=qui
const SEXTAS_NEWSLETTER = [2, 4];               // 2ª e 4ª sexta-feira do mês

// Feriados nacionais. Publicar em feriado é queimar alcance, e 24/12 e 31/12 são
// meio-expediente no varejo — entram como dia morto pelo mesmo motivo.
const FERIADOS_FIXOS = ["01-01", "04-21", "05-01", "09-07", "10-12", "11-02", "11-15", "11-20", "12-25"];
const DIAS_MORTOS = ["12-24", "12-31"];

// Páscoa (Meeus/Jones/Butcher) — base de Carnaval, Sexta-feira Santa e Corpus Christi.
function pascoa(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(ano, mes - 1, dia));
}

const DIA = 86400000;
function mmdd(d) {
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function feriados(ano) {
  const p = pascoa(ano).getTime();
  const moveis = [p - 48 * DIA, p - 47 * DIA, p - 2 * DIA, p + 60 * DIA] // carnaval seg/ter, sexta santa, corpus christi
    .map((t) => mmdd(new Date(t)));
  return new Set([...FERIADOS_FIXOS, ...moveis, ...DIAS_MORTOS]);
}

// Datas comerciais que mexem com reversa. Não mudam o FORMATO do slot — entram como
// gancho editorial, para a peça daquele dia falar do que o varejo está vivendo.
function datasComerciais(ano, mes) {
  const marcas = new Map();
  const põe = (dia, nome) => { if (dia >= 1) marcas.set(dia, nome); };
  const enesimo = (semana, diaSemana) => {           // n-ésimo <diaSemana> do mês
    const primeiro = new Date(Date.UTC(ano, mes - 1, 1)).getUTCDay();
    return 1 + ((diaSemana - primeiro + 7) % 7) + (semana - 1) * 7;
  };
  if (mes === 1) { põe(5, "onda de trocas pós-Natal"); põe(20, "volta às aulas"); }
  if (mes === 3) põe(15, "Dia do Consumidor");
  if (mes === 5) põe(enesimo(2, 0), "Dia das Mães");
  if (mes === 6) põe(12, "Dia dos Namorados");
  if (mes === 8) põe(enesimo(2, 0), "Dia dos Pais");
  if (mes === 10) põe(12, "Dia das Crianças");
  if (mes === 11) {
    const blackFriday = enesimo(4, 4) + 1;           // sexta depois da 4ª quinta
    põe(blackFriday, "Black Friday");
    põe(blackFriday + 3, "Cyber Monday");
  }
  if (mes === 12) { põe(25, "Natal"); põe(26, "início das trocas de Natal"); }
  return marcas;
}

// Monta os slots do mês: um por peça, já com formato e gancho comercial.
// Devolve { slots, perdidos } — `perdidos` são os dias de cadência que caíram em feriado
// ou dia morto e por isso não viraram peça.
//
// Slot que cai em feriado é DESCARTADO, não remanejado. A tentação é empurrar para o dia
// útil vizinho, mas isso põe reel na quarta e carrossel na segunda: o ritmo que o público
// reconhece (terça e quinta) vale mais do que fechar a conta de peças do mês. Em dezembro
// de 2026 o remanejamento criava peça em 23/12 e 30/12, véspera de Natal e de réveillon,
// a semana mais morta do calendário do varejo.
export function montarSlots(ano, mes) {
  const fer = feriados(ano);
  const comerciais = datasComerciais(ano, mes);
  const ultimo = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  const ocupados = new Set();
  const slots = [];
  const perdidos = [];

  let sextas = 0;
  for (let dia = 1; dia <= ultimo; dia++) {
    const d = new Date(Date.UTC(ano, mes - 1, dia));
    const semana = d.getUTCDay();
    let formato = CADENCIA[semana] || null;
    if (semana === 5) {
      sextas++;
      if (SEXTAS_NEWSLETTER.includes(sextas)) formato = "Newsletter";
    }
    if (!formato) continue;
    if (fer.has(mmdd(d))) { perdidos.push({ dia, formato }); continue; }
    ocupados.add(dia);
    slots.push({ dia, formato, gancho: null });
  }

  // Datas comerciais. Duas situações:
  //  - o dia está livre e não encosta em nenhuma peça: ganha slot próprio. É o caso da
  //    Cyber Monday, que cai na segunda — e é exatamente o que a equipe fez à mão em
  //    30/11/2026. Sem esta passada o gerador perderia a peça mais importante do mês.
  //  - o dia é feriado, fim de semana ou vizinho de uma peça: o gancho GRUDA na peça mais
  //    próxima em vez de criar uma terceira peça em três dias seguidos. É assim que o
  //    Natal (25/12, feriado) chega ao carrossel de 22/12.
  for (const [dia, nome] of [...comerciais].sort((a, b) => a[0] - b[0])) {
    if (dia > ultimo) continue;
    const d = new Date(Date.UTC(ano, mes - 1, dia));
    const proprio = !ocupados.has(dia) && !fer.has(mmdd(d)) && ![0, 6].includes(d.getUTCDay())
      && !ocupados.has(dia - 1) && !ocupados.has(dia + 1);
    if (proprio) {
      ocupados.add(dia);
      slots.push({ dia, formato: "Carrossel", gancho: nome });
      continue;
    }
    const antes = slots.filter((s) => s.dia <= dia).sort((a, b) => b.dia - a.dia)[0];
    const depois = slots.filter((s) => s.dia >= dia).sort((a, b) => a.dia - b.dia)[0];
    const alvo = antes && !antes.gancho ? antes : depois && !depois.gancho ? depois : null;
    if (alvo) alvo.gancho = nome;
  }

  slots.sort((a, b) => a.dia - b.dia);
  return { slots, perdidos };
}

// ---------------------------------------------------------------------------
// 2) EDITORIAL
// ---------------------------------------------------------------------------

async function editorialOficial(slots, ano, mes) {
  const cookie = await login();
  const base = process.env.COCKPIT_BASE || "https://abrev-cockpit.administradorabrev.workers.dev";
  const pecas = [];
  for (let index = 0; index < slots.length; index += 1) {
    const response = await fetch(new URL("/api/editorial/monthly",base), {
      method:"POST", headers:{cookie,"content-type":"application/json"},
      body:JSON.stringify({slots:slots.slice(index,index+1),ano,mes,anteriores:pecas.map(p=>p.tema)})
    });
    const data = await response.json().catch(()=>({error:"O cockpit interrompeu o parecer (HTTP "+response.status+")."}));
    if (!response.ok || !Array.isArray(data.pecas) || data.pecas.some(p=>!/^BIB_\d+$/.test(p.bib)||!/^[a-f0-9]{64}$/.test(p.prova)))
      throw Error(data.error || "Pauta sem parecer A99 e nota oficial.");
    pecas.push(...data.pecas);
  }
  return pecas;
}

function tauth() {
  const key = process.env.TRELLO_KEY, token = process.env.TRELLO_TOKEN;
  if (!key || !token) throw new Error("TRELLO_KEY/TRELLO_TOKEN ausentes (.env).");
  return { key, token };
}

async function trello(path, params = {}, method = "GET") {
  const { key, token } = tauth();
  const qs = new URLSearchParams({ ...params, key, token });
  const res = await fetch(`${T}${path}?${qs}`, { method });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Trello ${method} ${path} ${res.status}: ${JSON.stringify(j)}`);
  return j;
}

const dd = (n) => String(n).padStart(2, "0");

// A descrição tem contrato com os outros scripts: `legendaDoCard` (art_routine e
// aprovacao) corta no primeiro marcador entre colchetes, então a legenda vem primeiro e
// tudo que é controle interno vem depois. `palavrasVisuais` procura a linha [VISUAL].
function montarDesc(peça, hoje) {
  return [
    peça.legenda.trim(),
    "",
    `[VISUAL] ${peça.visual.trim()}`,
    `[ACERVO] ${peça.bib} | A99 ${peça.prova}`,
    `[RASCUNHO] Pauta gerada automaticamente em ${hoje}. Mantido em Rascunho; não autoriza nem dispara publicação.`,
  ].join("\n");
}

async function criarCartao(nome, desc) {
  return trello("/cards", { idList: LIST_RASCUNHO, name: nome, desc, pos: "bottom" }, "POST");
}

// ---------------------------------------------------------------------------
// EXECUÇÃO
// ---------------------------------------------------------------------------

async function run({ dryRun, refazer, modelo, mes, ano }) {
  const { slots, perdidos } = montarSlots(ano, mes);
  console.log(`${MESES[mes - 1]}/${ano}: ${slots.length} slot(s) no calendário.`);
  for (const s of slots) {
    console.log(`  ${dd(s.dia)}/${dd(mes)} · ${s.formato}${s.gancho ? ` · ${s.gancho}` : ""}`);
  }
  for (const p of perdidos) {
    console.log(`  (${dd(p.dia)}/${dd(mes)} · ${p.formato} não entra: feriado ou véspera)`);
  }
  if (!slots.length) throw new Error("o mês não rendeu nenhum slot — confira o calendário de feriados.");

  if (modelo) {
    const dir = join(AQUI, "cronograma");
    await mkdir(dir, { recursive: true });
    const arquivo = join(dir, `${ano}-${dd(mes)}.json`);
    const esqueleto = {
      mes, ano,
      pecas: slots.map((s) => ({
        dia: s.dia, formato: s.formato, gancho: s.gancho,
        tema: "", legenda: "", visual: "", stories: "",
      })),
    };
    await writeFile(arquivo, JSON.stringify(esqueleto, null, 2) + "\n");
    console.log(`\nmodelo escrito em ${arquivo} — preencha tema/legenda/visual/stories.`);
    return;
  }

  // Idempotência: se o mês já tem cartão na lista, não duplica. Rodar de novo é seguro.
  if (!dryRun) {
    const existentes = await trello(`/lists/${LIST_RASCUNHO}/cards`, { fields: "name" });
    const doMes = existentes.filter((c) => new RegExp(`^\\d{2}\\/${dd(mes)}\\s*·`).test(c.name));
    if (doMes.length && !refazer) {
      console.log(`\n${doMes.length} cartão(ões) de ${MESES[mes - 1]} já estão em Rascunho — nada a fazer.`);
      console.log("Use --refazer para criar de novo (os antigos NÃO são apagados).");
      return;
    }
  }

  const pecas = await editorialOficial(slots, ano, mes);

  const porDia = new Map(pecas.map((p) => [Number(p.dia), p]));
  const faltando = slots.filter((s) => !porDia.has(s.dia));
  if (faltando.length) {
    throw new Error(`a pauta não cobre ${faltando.map((s) => dd(s.dia)).join(", ")} — nada foi criado.`);
  }

  // Campo vazio é pior que pauta ausente. Um tema em branco monta o título
  // "01/12 · Carrossel · ", que a regex do aprovacao.mjs NÃO casa — o cartão existiria no
  // quadro e ficaria invisível para o e-mail do dia 20, que é o pior resultado possível:
  // falha silenciosa num passo que ninguém revisita. É exatamente o estado do esqueleto
  // que --modelo escreve e ninguém preencheu.
  const vazios = ["tema", "legenda", "visual", "stories"];
  const incompletos = slots
    .map((s) => ({ s, falta: vazios.filter((c) => !String(porDia.get(s.dia)[c] || "").trim()) }))
    .filter((x) => x.falta.length);
  if (incompletos.length) {
    throw new Error(
      "pauta incompleta — nada foi criado:\n" +
      incompletos.map((x) => `  ${dd(x.s.dia)}/${dd(mes)} sem ${x.falta.join(", ")}`).join("\n"),
    );
  }

  const hoje = new Date().toLocaleDateString("pt-BR");
  let criados = 0;

  for (const slot of slots) {
    const p = porDia.get(slot.dia);
    const tema = String(p.tema).replace(/·/g, "-").trim();
    const titulo = `${dd(slot.dia)}/${dd(mes)} · ${slot.formato} · ${tema}`;
    const tituloStories = `${dd(slot.dia)}/${dd(mes)} · Stories · apoio ${slot.formato === "Newsletter" ? "à" : "ao"} ${slot.formato} "${tema}"`;
    const descStories = montarDesc({ ...p, legenda: p.stories }, hoje);

    if (dryRun) {
      console.log(`\nDRY: ${titulo} · ${p.bib} · A99 ${p.prova}`);
      console.log(`     ${String(p.legenda).replace(/\n+/g, " ").slice(0, 120)}...`);
      console.log(`     [VISUAL] ${p.visual}`);
      console.log(`DRY: ${tituloStories}`);
      continue;
    }
    await criarCartao(titulo, montarDesc(p, hoje));
    await criarCartao(tituloStories, descStories);
    criados += 2;
    console.log(`OK: ${titulo}`);

  }

  console.log(dryRun
    ? `\n[DRY-RUN] ${slots.length * 2} cartão(ões) seriam criados. Nada foi escrito no Trello.`
    : `\n${criados} cartão(ões) criados em Rascunho.`);

}

const args = process.argv.slice(2);
const arg = (n) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? Number(a.split("=")[1]) : null;
};
// Sem --mes, o alvo é o mês SEGUINTE: o cronograma é montado antes do dia 15, para a
// rotina de artes encontrar os cards prontos quando rodar.
const hoje = new Date();
const proximo = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 1);
run({
  dryRun: args.includes("--dry-run"),
  refazer: args.includes("--refazer"),
  modelo: args.includes("--modelo"),
  mes: arg("mes") || Number(process.env.CRONOGRAMA_MES) || proximo.getMonth() + 1,
  ano: arg("ano") || Number(process.env.CRONOGRAMA_ANO) || proximo.getFullYear(),
}).catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
