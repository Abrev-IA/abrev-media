// Renova o token de longa duração do Instagram (login do Instagram, token "IGAA...").
//
// Por que existe: o token vale 60 dias e nada no sistema o renovava. Vencido, o publicador
// para em silêncio. A Meta deixa renovar quantas vezes quiser, desde que o token tenha
// mais de 24 h e ainda esteja válido — cada renovação devolve um token novo com mais 60 dias.
//
// O que faz:
//   1. chama graph.instagram.com/refresh_access_token com o token atual;
//   2. confere que o token novo funciona (lê o @ da conta);
//   3. grava o token novo no segredo IG_ACCESS_TOKEN do repositório (via gh, pela entrada
//      padrão — o valor nunca aparece em log nem em linha de comando);
//   4. com --salvar-env, também troca a linha no .env desta máquina;
//   5. publica calendario/token_instagram.json com as DATAS (renovado/expira), sem o token,
//      para quem quiser exibir o aviso no cockpit.
//
// Uso local:   node --env-file=.env ig_token.mjs --salvar-env
// No GitHub:   .github/workflows/ig-token.yml (dia 1 e 15). Precisa de GH_TOKEN com
//              permissão "Secrets: read and write" no repositório.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.MEDIA_REPO || "Abrev-IA/abrev-media";
const atual = process.env.IG_ACCESS_TOKEN;
const salvarEnv = process.argv.includes("--salvar-env");
const semSegredo = process.argv.includes("--sem-segredo");

if (!atual) { console.error("IG_ACCESS_TOKEN ausente."); process.exit(1); }

const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(atual)}`);
const j = await r.json().catch(() => ({}));
if (!r.ok || !j.access_token) {
  console.error(`Renovação recusada (${r.status}): ${j.error?.message || "sem detalhe"}`);
  console.error("Se o token já venceu, é preciso gerar um novo no painel da Meta e colar no .env/segredo.");
  process.exit(1);
}
const novo = j.access_token;
if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${novo}`);

const v = await (await fetch(`https://graph.instagram.com/me?fields=username&access_token=${encodeURIComponent(novo)}`)).json();
if (!v.username) { console.error("Token novo não respondeu — nada foi gravado."); process.exit(1); }

const agora = new Date();
const expira = new Date(agora.getTime() + (j.expires_in || 0) * 1000);
console.log(`Token renovado para @${v.username}. Vale até ${expira.toISOString().slice(0, 10)} (${Math.round((j.expires_in || 0) / 86400)} dias).`);

// .env antes do segredo: se o segredo falhar, o token novo não se perde.
if (salvarEnv) {
  const arq = join(RAIZ, ".env");
  const txt = await readFile(arq, "utf8");
  if (!/^IG_ACCESS_TOKEN=.*$/m.test(txt)) { console.error(".env sem linha IG_ACCESS_TOKEN — não mexi."); process.exit(1); }
  await writeFile(arq, txt.replace(/^IG_ACCESS_TOKEN=.*$/m, () => `IG_ACCESS_TOKEN=${novo}`));
  console.log(".env atualizado.");
}

if (!semSegredo) {
  const gh = spawnSync("gh", ["secret", "set", "IG_ACCESS_TOKEN", "-R", REPO], {
    input: novo, encoding: "utf8",
    // Fora do Actions, o GITHUB_TOKEN do .env (sem permissão de segredo) passaria na
    // frente do login do gh desta máquina. No Actions vale o GH_TOKEN do workflow.
    env: process.env.GITHUB_ACTIONS ? process.env
      : Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "GITHUB_TOKEN" && k !== "GH_TOKEN")),
  });
  if (gh.status !== 0) {
    console.error(`Falhou ao gravar o segredo IG_ACCESS_TOKEN: ${(gh.stderr || "").trim()}`);
    console.error("O token antigo continua válido até vencer; corrija a permissão e rode de novo.");
    process.exit(1);
  }
  console.log(`Segredo IG_ACCESS_TOKEN atualizado em ${REPO}.`);
}

await mkdir(join(RAIZ, "calendario"), { recursive: true });
await writeFile(join(RAIZ, "calendario", "token_instagram.json"), JSON.stringify({
  conta: v.username,
  renovado_em: agora.toISOString(),
  expira_em: expira.toISOString(),
}, null, 2) + "\n");
