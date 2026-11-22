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

// APROVAÇÃO TÁCITA (decisão do Alan, 22/11/2026): sem manifestação, a pauta está aprovada.
// O e-mail do dia 20 não pede aval — avisa o que vai ao ar e abre prazo para objeção.
//
// O PRAZO É O QUE TORNA ISSO SEGURO. Sem ele, "silêncio aprova" vira "aprovado no instante
// em que o card existe", e ninguém teria tempo de se manifestar. Pautas do mês M ficam
// aprovadas a partir deste dia do mês M-1.
export const PRAZO_OBJECAO_DIA = 25;

// Quem discorda, responde o e-mail; quem lê a resposta marca o card com esta etiqueta. Ela
// segura a peça em DOIS pontos: o agendamento não a agenda, e o publisher não a publica
// mesmo que já esteja em Agendado — então objeção tardia também é respeitada.
export const ETIQUETA_OBJECAO = "Ajustar";

// Atalho opcional: card com esta etiqueta é agendado antes do prazo acabar.
export const ETIQUETA_APROVADO = "Aprovado";

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
    "Dia 20 — aprovacao.mjs envia o cronograma por e-mail, como AVISO: o que vai ao ar no mês seguinte.",
    "Até o dia 25 — quem discordar de alguma pauta responde o e-mail; a pauta recebe a etiqueta \"Ajustar\".",
    "Dia 25 — sem manifestação, o mês está aprovado (aprovação tácita).",
    "agendar.mjs — a partir do dia 25, põe data e hora pela tabela acima e move para Agendado.",
    "publisher.mjs — publica no horário e move para Publicado.",
  ],
  convencao_do_card: "Título \"DD/MM · Formato · Tema\". Legenda até o primeiro marcador; depois vêm [RASCUNHO], [VISUAL] e notas internas, que nunca são publicadas.",
  aprovacao: "Tácita: sem manifestação até o dia 25, a pauta do mês seguinte está aprovada. O e-mail do dia 20 serve para quem quiser discordar.",
  travas: [
    "Card sem data em Rascunho não publica: é a trava do cronograma.",
    "Antes do dia 25, nada do mês seguinte é agendado — o prazo de manifestação está aberto.",
    "Card com a etiqueta \"Ajustar\" não é agendado nem publicado, em nenhuma etapa.",
    "Story só vai se o post do mesmo dia for — exceto a que anuncia a newsletter.",
  ],
  limites: [
    "Enquete e caixa de perguntas em story não são publicáveis pela API: ficam no app.",
    "LinkedIn ainda não publica automaticamente: aguarda aprovação do app pelo LinkedIn.",
  ],
};
