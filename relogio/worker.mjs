// relogio — o relógio do publicador da ABREV.
//
// POR QUE ISTO EXISTE. O workflow "Publicar Instagram" declara `*/15 * * * *`, que
// seriam 96 execuções por dia. Medição de 05/11/2026 nos horários reais das últimas
// execuções: o GitHub entregou de 3 a 5 por dia, com buracos de 4h19 a 8h22. Um card
// com `due` às 19:00 podia sair às 03:00 da manhã seguinte. É o mesmo comportamento já
// observado no cron "de 5 minutos" do blog, que sai 4 a 6 vezes por dia: o GitHub
// descarta a maior parte dos disparos AGENDADOS.
//
// Disparo por `repository_dispatch` é outra coisa: é um evento, não um agendamento, e
// não entra nessa fila de descarte. Então a divisão de trabalho fica: a Cloudflare
// guarda a hora (cron de Worker cumpre minuto), o GitHub faz o trabalho.
//
// E não dá para empurrar o relógio para a Meta: a Content Publishing API do Instagram
// não tem parâmetro de publicação agendada. O Business Suite tem; a API, não.
//
// O QUE ELE NÃO FAZ. Não decide o que publicar e não conhece canal. Ele só bate o
// ponto. Quem olha o quadro, vê o que venceu e publica é o `publisher.mjs`, do outro
// lado. Por isso um disparo "de LinkedIn" às 09:00 hoje roda o publicador de Instagram
// e não acha nada — o canal é propriedade do card, não do gatilho. Os três horários
// passam a valer por canal quando existirem os publicadores de LinkedIn e de
// newsletter; até lá o que eles entregam é pontualidade, que já é o problema.
//
// Segredo necessário (wrangler secret put GITHUB_TOKEN): PAT fine-grained com
// Contents: Read and write no repositório de destino. É a permissão que a API exige
// para POST /repos/{repo}/dispatches.

const PADRAO_REPO = "Abrev-IA/abrev-media";
const EVENTO = "publicar";

// Brasília é UTC-3 o ano inteiro desde que o horário de verão acabou, em 2019, então
// estes três horários não precisam de ajuste sazonal. Se o país voltar a mudar de
// hora, é aqui e no wrangler.toml que se mexe.
const HORARIOS = {
  "0 12 * * *": "09:00 BRT — janela do LinkedIn",
  "0 16 * * *": "13:00 BRT — janela da newsletter",
  "0 22 * * *": "19:00 BRT — janela do Instagram",
};

async function disparar(cron, env) {
  const repo = env.REPO || PADRAO_REPO;
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN ausente nos secrets do Worker.");

  const motivo = HORARIOS[cron] || "varredura de recuperação";
  const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "abrev-relogio",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: EVENTO,
      // Chega no workflow como github.event.client_payload — serve para, olhando uma
      // execução no Actions, saber se ela veio de um horário ou da varredura.
      client_payload: { cron, motivo, em: new Date().toISOString() },
    }),
  });

  // A API devolve 204 sem corpo quando aceita.
  if (res.status !== 204) {
    throw new Error(`dispatch falhou ${res.status}: ${await res.text()}`);
  }
  console.log(`disparado (${motivo}) para ${repo}`);
}

export default {
  async scheduled(event, env, ctx) {
    // waitUntil: sem isso o Worker pode ser encerrado antes de a requisição terminar.
    ctx.waitUntil(
      disparar(event.cron, env).catch((e) => {
        // Um erro aqui aparece no `wrangler tail` e no painel. Não há retry: a próxima
        // varredura, no máximo uma hora depois, pega o que ficou para trás — que é
        // exatamente para isso que ela existe.
        console.error(`ERRO no cron "${event.cron}": ${e.message}`);
        throw e;
      }),
    );
  },

  // Só informativo, para confirmar que o Worker está no ar. Não dispara nada de
  // propósito: um endpoint público que publica seria um gatilho para qualquer um.
  // Para testar um disparo use o painel da Cloudflare ("Trigger scheduled event") ou
  // `npx wrangler dev --test-scheduled`.
  async fetch(req, env) {
    const repo = env.REPO || PADRAO_REPO;
    const linhas = [
      "relógio do publicador ABREV",
      `destino: ${repo} (repository_dispatch "${EVENTO}")`,
      "",
      ...Object.entries(HORARIOS).map(([c, m]) => `  ${c}  ${m}`),
      "  varredura de recuperação nas demais horas cheias",
      "",
      `token configurado: ${env.GITHUB_TOKEN ? "sim" : "NÃO — o Worker vai falhar"}`,
      `agora (UTC): ${new Date().toISOString()}`,
    ];
    return new Response(linhas.join("\n") + "\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
