# relogio — o relógio do publicador

Mantém a hora de publicação e dispara o workflow "Publicar Instagram (calendário ABREV)"
por `repository_dispatch`.

## Por que não é só o cron do GitHub

O `publish.yml` declara `*/15 * * * *` — 96 execuções por dia. Medição de 05/11/2026,
pelos horários reais das 14 últimas execuções:

```
05/11 01:28 · 04/11 21:09 · 04/11 14:50 · 04/11 06:28 · 04/11 00:09 · 03/11 19:25 · 03/11 11:57
```

De 3 a 5 por dia, com buracos de **4h19 a 8h22**. O GitHub descarta a maior parte dos
disparos agendados. Um card com `due` às 19:00 podia sair às 03:00 da manhã seguinte —
e é por isso que novembro foi agendado à mão pelo Business Suite.

Disparo por `repository_dispatch` é evento, não agendamento, e não entra nessa fila de
descarte: a execução começa em segundos. O cron do `publish.yml` continua lá, rebaixado
a rede de segurança para o caso de o Worker sair do ar.

## Horários

| Cron (UTC) | Brasília | |
|---|---|---|
| `0 12 * * *` | 09:00 | janela do LinkedIn |
| `0 16 * * *` | 13:00 | janela da newsletter |
| `0 22 * * *` | 19:00 | janela do Instagram |
| `0 0-11,13-15,17-21,23 * * *` | demais horas | varredura de recuperação |

São 27 invocações por dia; o plano gratuito da Cloudflare dá 100 mil.

**O relógio não conhece canal.** Ele só bate o ponto; quem decide o que publicar é o
`publisher.mjs`, lendo o `due` dos cards em "Agendado". Hoje o publicador só faz
Instagram, então o disparo das 09:00 roda e não acha nada. Os três horários passam a
valer por canal quando existirem os publicadores de LinkedIn e de newsletter — até lá o
que o relógio entrega é pontualidade, que já era o problema.

## Implantar

Precisa de uma conta Cloudflare (a mesma do cockpit serve) e de um PAT do GitHub.

1. **Criar o PAT.** GitHub → Settings → Developer settings → Personal access tokens →
   Fine-grained. Repositório: só `Abrev-IA/abrev-media`. Permissão: **Contents: Read and
   write** — é a que a API exige para `POST /repos/{repo}/dispatches`. Anotar o token.

2. **Publicar o Worker**, desta pasta:

   ```
   npx wrangler deploy
   ```

3. **Guardar o token**, quando o deploy terminar:

   ```
   npx wrangler secret put GITHUB_TOKEN
   ```

4. **Conferir.** Abrir a URL que o deploy imprimiu: a página diz os horários e se o
   token está configurado. Ela não dispara nada — é só informativa, de propósito.

5. **Testar um disparo.** No painel da Cloudflare, no Worker, *Settings → Trigger
   Events → Trigger scheduled event*; ou `npx wrangler dev --test-scheduled` e chamar
   `/__scheduled?cron=0+22+*+*+*`. Depois confirmar no Actions do `abrev-media` que
   apareceu uma execução com evento `repository_dispatch`.

Se o Worker falhar, o erro aparece em `npx wrangler tail` e no painel. Não há retry por
disparo: a varredura da hora seguinte pega o que ficou para trás, que é a razão de ela
existir.
