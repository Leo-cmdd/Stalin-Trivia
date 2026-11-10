// Generates weekly AI carousel slides (EN + PT) as HTML, then renders PNGs (1080x1350).
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const HANDLE = '@yourhandle'; // <- replace with your account

const content = {
  en: {
    cover: ['DO YOU REALIZE WHAT JUST HAPPENED IN AI THIS WEEK?', 'THE BIGGEST AI NEWS, GLOBAL + LATAM', 'SWIPE FOR MORE'],
    stories: [
      ['Latin America Has an AI Ranking, and Chile Leads', 'The 2026 Latin American AI Index puts Chile, Brazil and Uruguay ahead in the region. Brazil stands out on infrastructure.', 'LATAM AI INDEX 2026'],
      ['Mistral Large 4 Is Open Weight', 'Mistral released a 1-trillion-parameter model under a modified MIT licence, with a separate licence for resellers.', 'MISTRAL AI'],
      ['Only 17% of Latin American Companies See the Results They Expected From AI', 'A McKinsey survey says most organisations in the region are still struggling to turn AI spending into returns.', 'MCKINSEY'],
      ['OpenAI Launches GPT-6 Cyber', 'OpenAI rates the model "Critical" for cybersecurity capability, its highest risk tier.', 'OPENAI'],
      ['The Region\'s Biggest Bank Is Buying a Brazilian AI Startup', 'The largest bank in Latin America by assets will acquire a startup founded in 2023 to speed up its own models.', 'BLOOMBERG LÍNEA'],
      ['Google Switches Gemini Off by Default for K-12 Students', 'Gemini and AI in Search will be off by default on school accounts for students.', 'GOOGLE'],
      ['Brazil Is Ahead of the Region in AI Agents, but Behind in the Global Race', 'Agent adoption in Brazil is above the Latin American average, while experts warn of a talent shortage.', 'CNN BRASIL'],
    ],
    cta: ['Follow for the weekly AI news that matters', 'Global + Latin America. Every week. Free.', 'FOLLOW ' + HANDLE],
    foot: 'Sources: public news reports, Nov 2026',
  },
  pt: {
    cover: ['VOCÊ VIU O QUE ACONTECEU EM IA NESTA SEMANA?', 'AS MAIORES NOTÍCIAS DE IA, GLOBAL + AMÉRICA LATINA', 'DESLIZE PARA VER'],
    stories: [
      ['A América Latina Tem um Ranking de IA, e o Chile Lidera', 'O Índice Latino-Americano de IA 2026 coloca Chile, Brasil e Uruguai à frente na região. O Brasil se destaca em infraestrutura.', 'ÍNDICE LATAM DE IA 2026'],
      ['Mistral Large 4 É Open Weight', 'A Mistral lançou um modelo de 1 trilhão de parâmetros com licença MIT modificada e licença separada para revendedores.', 'MISTRAL AI'],
      ['Só 17% das Empresas Latino-Americanas Têm os Resultados Esperados com IA', 'Pesquisa da McKinsey indica que a maioria das organizações da região ainda não transforma o investimento em IA em retorno.', 'MCKINSEY'],
      ['OpenAI Lança o GPT-6 Cyber', 'A OpenAI classifica o modelo como "Crítico" em capacidade de cibersegurança, o nível mais alto de risco.', 'OPENAI'],
      ['O Maior Banco da Região Vai Comprar uma Startup Brasileira de IA', 'O maior banco da América Latina em ativos vai adquirir uma startup fundada em 2023 para acelerar seus próprios modelos.', 'BLOOMBERG LÍNEA'],
      ['Google Desliga o Gemini por Padrão para Estudantes', 'O Gemini e a IA na Busca ficarão desativados por padrão nas contas escolares de estudantes.', 'GOOGLE'],
      ['Brasil Lidera Agentes de IA na Região, mas Está Atrás na Corrida Global', 'O uso de agentes no Brasil está acima da média latino-americana, mas especialistas alertam para a falta de talentos.', 'CNN BRASIL'],
    ],
    cta: ['Siga para as notícias de IA que importam, toda semana', 'Global + América Latina. Toda semana. Grátis.', 'SIGA ' + HANDLE],
    foot: 'Fontes: reportagens públicas, nov. 2026',
  },
};

const parrot = `<svg viewBox="0 0 200 220" width="260" height="286"><path d="M70 205c-20-40-10-95 25-120 30-22 70-5 72 30 1 25-15 40-12 70 2 15-20 30-45 25z" fill="#2ecc71"/><path d="M95 95c-8-45 40-60 60-30-20-5-38 8-40 30z" fill="#e74c3c"/><circle cx="118" cy="82" r="14" fill="#fff"/><circle cx="121" cy="82" r="6" fill="#111"/><path d="M135 90c25 5 28 25 10 38-5-15-12-25-10-38z" fill="#f1c40f"/><path d="M60 150c-25 30-10 55 10 60l5-50z" fill="#3498db"/></svg>`;

const css = `*{margin:0;box-sizing:border-box}body{width:1080px;height:1350px;background:#0a0a0c;color:#fff;font-family:Heebo,Inter,Arial,sans-serif;position:relative;overflow:hidden}
.brand{position:absolute;top:48px;right:56px;font-size:28px;font-weight:700;opacity:.85}
.num{position:absolute;top:48px;left:56px;font-size:26px;opacity:.5}
.story{padding:150px 72px 0}
.story h2{font-size:60px;line-height:1.12;font-weight:800}
.story h2:before{content:"– "}
.story p{font-size:38px;line-height:1.35;margin-top:36px;color:#cfd2d8}
.tag{position:absolute;left:72px;right:72px;bottom:130px;height:520px;border-radius:28px;background:linear-gradient(135deg,#1c2541,#3a506b 60%,#5bc0be);display:flex;align-items:center;justify-content:center;font-size:54px;font-weight:900;letter-spacing:3px;text-align:center;padding:40px}
.foot{position:absolute;bottom:48px;left:72px;font-size:24px;opacity:.45}
.cover{background:linear-gradient(160deg,#0f2027,#203a43 50%,#2c5364)}
.cover h1{position:absolute;left:60px;right:60px;bottom:230px;font-size:104px;line-height:1.02;font-weight:900;text-align:center}
.cover .sub{position:absolute;bottom:150px;width:100%;text-align:center;font-size:30px;font-weight:700;letter-spacing:2px;opacity:.9}
.cover .sw{position:absolute;bottom:90px;width:100%;text-align:center;font-size:24px;opacity:.6;letter-spacing:3px}
.cta{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 80px;gap:36px}
.cta h2{font-size:68px;line-height:1.1;font-weight:900}.cta p{font-size:36px;color:#cfd2d8}
.btn{background:#fff;color:#000;font-weight:800;font-size:38px;padding:26px 56px;border-radius:60px}`;

const page = b => `<!doctype html><meta charset=utf-8><style>${css}</style>${b}`;
(async () => {
  const br = await chromium.launch();
  for (const lang of ['en', 'pt']) {
    const c = content[lang], out = path.join(__dirname, lang);
    fs.mkdirSync(out, { recursive: true });
    const slides = [
      `<body class=cover><div class=brand>${HANDLE}</div><h1>${c.cover[0]}</h1><div class=sub>${c.cover[1]}</div><div class=sw>${c.cover[2]} ›</div>`,
      ...c.stories.map((s, i) => `<body><div class=num>${i + 1}/${c.stories.length}</div><div class=brand>${HANDLE}</div><div class=story><h2>${s[0]}</h2><p>${s[1]}</p></div><div class=tag>${s[2]}</div><div class=foot>${c.foot}</div>`),
      `<body class=cta>${parrot}<h2>${c.cta[0]}</h2><p>${c.cta[1]}</p><div class=btn>${c.cta[2]}</div>`,
    ];
    const pg = await br.newPage({ viewport: { width: 1080, height: 1350 } });
    for (let i = 0; i < slides.length; i++) {
      fs.writeFileSync(path.join(out, `slide${i + 1}.html`), page(slides[i]));
      await pg.setContent(page(slides[i]));
      await pg.screenshot({ path: path.join(out, `slide${String(i + 1).padStart(2, '0')}.png`) });
    }
  }
  await br.close();
})();
