// Regras do calendário da ABREV — fonte única.
//
// O agendar.mjs usa estas tabelas para pôr data e hora nas pautas aprovadas, e o
// calendario_feed.mjs as publica junto do calendário, para o cockpit mostrar a regra que
// gerou cada mês. Estavam espalhadas (no código e num .md) e por isso já divergiram uma
// vez: o carrossel mudou de 12h30 para 19h entre outubro e novembro sem ninguém atualizar
// a documentação. Mudou a regra? Muda aqui, e as duas pontas acompanham.

// Horário de Brasília. Prática medida nos `due` de novembro/2026.
export const HORARIO_PECA = { "reel+card": "19:00", reel: "19:00", carrossel: "19:00", newsletter: "08:00" };

// Story de apoio. 12h30 é o story que ANTECIPA o carrossel das 19h — por isso difere.
export const HORARIO_STORY = { "reel+card": "19:00", reel: "19:00", carrossel: "12:30", newsletter: "08:00" };

export const BRT_PARA_UTC = 3; // Brasília não tem horário de verão desde 2019

// Texto legível das regras, para quem abrir o calendário daqui a três meses saber como
// ele foi montado. É conteúdo, não código: pode ser editado à vontade.
export const REGRAS = {
  atualizado_em: "2026-11-22",
  cadencia: "Posts de feed às terças e quintas; newsletter quinzenal. Cada post e cada newsletter tem um Stories de apoio no mesmo dia.",
  horarios_brt: {
    "Carrossel": HORARIO_PECA.carrossel,
    "Reel": HORARIO_PECA.reel,
    "Reel+Card": HORARIO_PECA["reel+card"],
    "Newsletter": HORARIO_PECA.newsletter,
    "Stories de apoio a Carrossel": HORARIO_STORY.carrossel,
    "Stories de apoio a Reel": HORARIO_STORY.reel,
    "Stories de apoio a Newsletter": HORARIO_STORY.newsletter,
  },
  ciclo: [
    "Dia 12 — cronograma.mjs cria as pautas do mês seguinte em Rascunho, SEM data.",
    "Dias 15 a 20 — art_routine.mjs gera as artes e anexa aos cards.",
    "Dia 20 — aprovacao.mjs envia o cronograma por e-mail para aprovação.",
    "Aprovação — as pautas aprovadas recebem a etiqueta \"Aprovado\" no Trello.",
    "agendar.mjs — põe data e hora pela tabela acima e move para Agendado.",
    "publisher.mjs — publica no horário e move para Publicado.",
  ],
  convencao_do_card: "Título \"DD/MM · Formato · Tema\". Legenda até o primeiro marcador; depois vêm [RASCUNHO], [VISUAL] e notas internas, que nunca são publicadas.",
  travas: [
    "Card sem data em Rascunho não publica: é a trava do cronograma.",
    "Sem a etiqueta \"Aprovado\", o agendamento não age.",
    "Story só vai se o post do mesmo dia for — exceto a que anuncia a newsletter.",
  ],
  limites: [
    "Enquete e caixa de perguntas em story não são publicáveis pela API: ficam no app.",
    "LinkedIn ainda não publica automaticamente: aguarda aprovação do app pelo LinkedIn.",
  ],
};
