// ═══════════════════════════════════════════════════════════════
// NEXUS HUB XD — generate.js (Browser-side, No Server Needed)
// ═══════════════════════════════════════════════════════════════

const GROQ_KEYS = [
  'YOUR_GROQ_API_KEY_1',
  'YOUR_GROQ_API_KEY_2',
  'YOUR_GROQ_API_KEY_3',
];

// ── API ROTATION ──────────────────────────────────────────────
let lastKeyIndex = 0;
async function callGroq(body) {
  const validKeys = GROQ_KEYS.filter(k => k && !k.startsWith('YOUR_'));
  if (validKeys.length === 0) {
    console.error('No valid GROQ API keys set!');
    return null;
  }
  for (let attempt = 0; attempt < GROQ_KEYS.length; attempt++) {
    const idx = (lastKeyIndex + attempt) % GROQ_KEYS.length;
    const key = GROQ_KEYS[idx];
    if (!key || key.startsWith('YOUR_')) continue;
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify(body)
      });
      if (res.status === 429) { console.warn(`Key ${idx+1} rate limited`); continue; }
      if (res.status === 401) { console.error(`Key ${idx+1} invalid/expired`); continue; }
      if (!res.ok) { const e = await res.text(); console.error(`Key ${idx+1} error: ${e}`); continue; }
      lastKeyIndex = idx;
      return res;
    } catch (err) { console.error(`Key ${idx+1} fetch error:`, err.message); }
  }
  console.error('All GROQ API keys failed or rate limited!');
  return null;
}

// ── EXAM LEVEL SYSTEM PROMPTS ─────────────────────────────────
const EXAM_PROMPTS = {
  'NEET UG': `You are an expert NEET UG MCQ generator for Biology, Physics, Chemistry.
NEET UG standards: Strictly NCERT-based (Class 11 & 12). Cover conceptual understanding, application, and NCERT line-based questions.
Difficulty: medical entrance level. Focus on NCERT definitions, diagrams, examples, clinical applications, and PYQ-style questions.
Question variety is MANDATORY: use different starting words for each question. Mix: direct concept, NCERT statement completion, which-is-correct, which-is-incorrect, assertion-reason style, example-based, organism/structure identification.`,

  'JEE Main': `You are an expert JEE Main MCQ generator for Physics, Chemistry, Mathematics.
JEE Main standards: NTA pattern, application-based, numerical problems, conceptual clarity.
Difficulty: engineering entrance level. Include formula-based, concept-based questions.`,

  'JEE Advanced': `You are an expert JEE Advanced MCQ generator for Physics, Chemistry, Mathematics.
JEE Advanced standards: highest difficulty, multi-concept integration, analytical thinking required.
Difficulty: very hard. Include tricky options, multi-step reasoning, advanced applications.`,

  'GUJCET': `You are an expert GUJCET (Gujarat Common Entrance Test) MCQ generator.
GUJCET standards: Gujarat State Board syllabus, Physics Chemistry Maths/Biology.
Difficulty: state entrance level. Based on GSEB textbooks, standard applications.`,

  'Gujarat Board (GHSEB)': `You are an expert GHSEB (Gujarat Higher Secondary Education Board) MCQ generator.
GHSEB standards: Class 11-12 Gujarat Board syllabus, standard textbook questions.
Difficulty: board exam level. Focus on textbook definitions, standard formulas, direct applications.`,

  'General': `You are an expert MCQ generator.
Create well-balanced questions covering theory, application, and analysis.
Difficulty: as specified. Make questions educational and clear.`
};

// ── MAIN GENERATE FUNCTION ────────────────────────────────────
async function generateQuestions({ topic, numQ, difficulty, language, exam, subject, onProgress }) {
  const examPrompt = EXAM_PROMPTS[exam] || EXAM_PROMPTS['General'];
  const total = parseInt(numQ);

  const isGuj = language === 'Gujarati';
  const isHin = language === 'Hindi';

  const langInstruction = isGuj
    ? `CRITICAL: Write EVERY word in Gujarati script (ગુજરાતી) ONLY. Questions, options, explanations — all in Gujarati. No English anywhere.`
    : isHin
    ? `CRITICAL: Write EVERY word in Hindi (हिंदी) ONLY. Questions, options, explanations — all in Hindi. No English anywhere.`
    : `Write everything in clear, standard English.`;

  const BATCH = isGuj ? 5 : isHin ? 7 : 20;
  const MAX_TOK = isGuj ? 8000 : isHin ? 7000 : 6000;
  const MODEL = total <= 5 ? 'llama-3.1-8b-instant' : 'llama-3.3-70b-versatile';

  const totalBatches = Math.ceil(total / BATCH);
  let allQ = [];

  for (let b = 0; b < totalBatches; b++) {
    const bCount = Math.min(BATCH, total - allQ.length);
    const startN = allQ.length + 1;
    let success = false;

    for (let retry = 0; retry < 3 && !success; retry++) {
      if (retry > 0) await new Promise(r => setTimeout(r, 700 * retry));

      const diffMap = {
        'easy': exam === 'JEE Advanced' ? 'medium' : 'easy',
        'medium': 'medium',
        'hard': 'hard',
        'mixed': 'varied (mix of easy, medium, and hard)'
      };

      const stemExamples = isGuj
        ? `કયો, કઈ, શું, ક્યારે, કોણ, કેટલા, નીચેમાંથી કયું, _______ ________., આ પ્રક્રિયામાં, નીચેના વિધાનો પૈકી, સાચો વિકલ્પ, ખોટું વિધાન`
        : isHin
        ? `कौन सा, कौन, क्या, कितने, नीचे में से, ______ _______, इस प्रक्रिया में, निम्न में से, सही विकल्प, गलत कथन`
        : `Which, What, How many, Identify, Which of the following, ______ is/are, The correct statement, Which is NOT, In which, According to NCERT`;

      const prompt = `Generate exactly ${bCount} MCQ questions about the topic: "${topic}".
Subject: ${subject || 'General'} | Exam: ${exam} | Difficulty: ${diffMap[difficulty] || difficulty}
${langInstruction}
These are questions ${startN} to ${startN + bCount - 1}.

CRITICAL VARIETY RULE — STRICTLY FOLLOW:
- NEVER start multiple questions with the same word or phrase.
- Do NOT start questions with the topic name "${topic}" itself.
- Each question must begin with a DIFFERENT stem word or structure.
- Use varied question stems like: ${stemExamples}
- Mix statement-based, fill-in-the-blank, assertion-reason, and direct questions.
- Some questions can be about related sub-concepts, not just the main topic name.

RULES (strictly follow):
1. Return ONLY a valid JSON array — no markdown, no backticks, no explanation text outside JSON.
2. Format: [{"question":"...","options":["A text","B text","C text","D text"],"correct":0,"explanation":"..."}]
3. "correct" = 0-based index of correct option (0=A, 1=B, 2=C, 3=D).
4. All 4 options must be distinct and plausible.
5. Explanation must explain WHY that answer is correct with NCERT reference where applicable.
6. Questions must match ${exam} exam level precisely.
7. No repeated questions. No two questions starting with same word.

Start with [ and end with ]`;

      const res = await callGroq({
        model: MODEL,
        messages: [
          { role: 'system', content: `${examPrompt}\n${langInstruction}\nReturn ONLY valid JSON array. Nothing before [. Nothing after ].\nIMPORTANT: Every question must start with a DIFFERENT word. Never repeat the topic name at the start of questions. Use diverse question structures: direct, fill-in-blank, which-of-following, assertion, negation, diagram-based description, etc.` },
          { role: 'user', content: prompt }
        ],
        temperature: 0.45,
        max_tokens: MAX_TOK
      });

      if (!res) continue;
      const data = await res.json();
      const raw = data.choices?.[0]?.message?.content?.trim();
      if (!raw) continue;

      const s = raw.indexOf('['), e = raw.lastIndexOf(']');
      if (s === -1 || e === -1) continue;

      let jsonStr = raw.substring(s, e + 1)
        .replace(/,\s*]/g, ']').replace(/,\s*}/g, '}')
        .replace(/[\x00-\x1F\x7F]/g, ' ');

      let parsed;
      try { parsed = JSON.parse(jsonStr); } catch { continue; }
      if (!Array.isArray(parsed)) continue;

      const valid = parsed
        .filter(q => q.question && q.question.length > 5)
        .map((q, i) => ({
          id: allQ.length + i + 1,
          question: q.question,
          options: Array.isArray(q.options) && q.options.length >= 4
            ? q.options.slice(0, 4)
            : ['Option A', 'Option B', 'Option C', 'Option D'],
          correct: typeof q.correct === 'number' && q.correct >= 0 && q.correct <= 3 ? q.correct : 0,
          explanation: q.explanation || 'See textbook for details.',
          difficulty: difficulty
        }));

      allQ = [...allQ, ...valid];
      success = true;

      if (onProgress) onProgress(allQ.length, total, b + 1, totalBatches);
    }

    if (b < totalBatches - 1) await new Promise(r => setTimeout(r, 350));
  }

  return allQ;
}

// ── HTML QUIZ FILE GENERATOR ──────────────────────────────────
function buildQuizHTML({ title, exam, subject, topic, difficulty, language, questions }) {
  const diffLabel = { easy: 'Easy', medium: 'Medium', hard: 'Hard', mixed: 'Mixed' }[difficulty] || difficulty;

  const questionsJSON = JSON.stringify(questions);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
:root{--bg:#0a0a0f;--surface:#13131a;--card:#1a1a24;--border:#2a2a3a;--accent:#7c6aff;--accent2:#ff6a9b;--accent3:#6affd4;--text:#e8e8f0;--muted:#7070a0;--gold:#ffd166;}
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding:20px;}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse at 20% 20%,rgba(124,106,255,.08),transparent 50%),radial-gradient(ellipse at 80% 80%,rgba(255,106,155,.06),transparent 50%);pointer-events:none;}
.container{max-width:860px;margin:0 auto;position:relative;z-index:1;}
.quiz-header{text-align:center;padding:32px 20px 24px;background:var(--card);border:1px solid var(--border);border-radius:20px;margin-bottom:20px;}
.quiz-badge{display:inline-flex;align-items:center;gap:6px;background:rgba(0,212,255,.1);border:1px solid rgba(0,212,255,.3);color:#00d4ff;font-size:11px;font-weight:700;padding:5px 14px;border-radius:20px;letter-spacing:1px;text-transform:uppercase;margin-bottom:12px;}
.quiz-title{font-family:'Syne',sans-serif;font-size:clamp(22px,5vw,36px);font-weight:800;background:linear-gradient(135deg,#00d4ff,#7c6aff,#ff6a9b);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:8px;}
.quiz-meta{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:14px;}
.meta-tag{background:var(--surface);border:1px solid var(--border);padding:5px 12px;border-radius:8px;font-size:12px;color:var(--muted);}
.meta-tag span{color:var(--text);font-weight:600;}
.score-bar{background:var(--card);border:1px solid rgba(0,212,255,.2);border-radius:16px;padding:20px 24px;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;}
.score-main{font-family:'Syne',sans-serif;font-size:42px;font-weight:800;background:linear-gradient(135deg,#00d4ff,#7c6aff);-webkit-background-clip:text;-webkit-text-fill-color:transparent;}
.score-detail{font-size:13px;color:var(--muted);margin-top:2px;}
.progress-wrap{flex:1;min-width:160px;}
.progress-track{height:8px;background:var(--border);border-radius:10px;overflow:hidden;margin-top:8px;}
.progress-fill{height:100%;background:linear-gradient(90deg,#00d4ff,#7c6aff);border-radius:10px;transition:width .5s ease;}
.controls{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px;}
.btn{padding:10px 18px;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid var(--border);background:var(--surface);color:var(--text);transition:all .2s;font-family:'DM Sans',sans-serif;}
.btn:hover{border-color:#00d4ff;color:#00d4ff;}
.btn.primary{background:linear-gradient(135deg,#00d4ff,#7c6aff);border:none;color:white;}
.btn.primary:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,212,255,.4);}
.btn.danger{border-color:rgba(255,106,155,.4);color:var(--accent2);}
.btn.danger:hover{background:rgba(255,106,155,.1);}
.q-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:22px;margin-bottom:12px;transition:border-color .2s;}
.q-card:hover{border-color:rgba(124,106,255,.3);}
.q-top{display:flex;align-items:flex-start;gap:12px;margin-bottom:16px;}
.q-num{background:linear-gradient(135deg,#00d4ff,#7c6aff);color:white;font-family:'Syne',sans-serif;font-weight:800;font-size:11px;min-width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.q-text{font-size:15px;font-weight:500;line-height:1.6;flex:1;}
.opts{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
.opt{display:flex;align-items:center;gap:10px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:11px 14px;cursor:pointer;transition:all .2s;font-size:14px;line-height:1.4;}
.opt:hover:not(.locked){border-color:#7c6aff;background:rgba(124,106,255,.07);}
.opt.correct{border-color:var(--accent3);background:rgba(106,255,212,.08);color:var(--accent3);}
.opt.wrong{border-color:var(--accent2);background:rgba(255,106,155,.08);color:var(--accent2);}
.opt-ltr{width:24px;height:24px;background:var(--border);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;transition:all .2s;}
.opt.correct .opt-ltr{background:var(--accent3);color:#000;}
.opt.wrong .opt-ltr{background:var(--accent2);color:#fff;}
.exp{display:none;margin-top:14px;padding:12px 16px;background:rgba(0,212,255,.06);border:1px solid rgba(0,212,255,.15);border-radius:10px;font-size:13px;color:#00d4ff;line-height:1.7;}
.exp.show{display:block;}
.exp::before{content:'💡 ';font-size:14px;}
.fin-card{display:none;text-align:center;background:var(--card);border:2px solid rgba(0,212,255,.3);border-radius:20px;padding:40px 24px;margin-bottom:20px;}
.fin-card.show{display:block;}
.fin-score{font-family:'Syne',sans-serif;font-size:72px;font-weight:800;background:linear-gradient(135deg,#00d4ff,#7c6aff);-webkit-background-clip:text;-webkit-text-fill-color:transparent;line-height:1;}
.fin-label{font-size:15px;color:var(--muted);margin-top:8px;}
.fin-msg{font-size:28px;margin:16px 0 8px;}
.branding{text-align:center;padding:20px;color:var(--muted);font-size:12px;border-top:1px solid var(--border);margin-top:28px;}
.branding strong{color:#00d4ff;}
@media(max-width:600px){.opts{grid-template-columns:1fr;}.score-bar{flex-direction:column;}.quiz-meta{gap:8px;}}
</style>
</head>
<body>
<div class="container">
  <div class="quiz-header">
    <div class="quiz-badge">📚 ${exam} — ${diffLabel}</div>
    <div class="quiz-title">${title}</div>
    <div style="color:var(--muted);font-size:14px;margin-top:6px;">${subject} · ${questions.length} Questions · ${language}</div>
    <div class="quiz-meta">
      <div class="meta-tag">Topic: <span>${topic}</span></div>
      <div class="meta-tag">Exam: <span>${exam}</span></div>
      <div class="meta-tag">Difficulty: <span>${diffLabel}</span></div>
      <div class="meta-tag">Questions: <span>${questions.length}</span></div>
    </div>
  </div>

  <div class="score-bar" id="scoreBar">
    <div>
      <div class="score-main" id="scoreNum">0/${questions.length}</div>
      <div class="score-detail" id="scorePct">0% · 0 answered</div>
    </div>
    <div class="progress-wrap">
      <div style="font-size:12px;color:var(--muted);">Progress</div>
      <div class="progress-track"><div class="progress-fill" id="pFill" style="width:0%"></div></div>
    </div>
  </div>

  <div class="controls">
    <button class="btn primary" onclick="revealAll()">👁️ Show All Answers</button>
    <button class="btn" onclick="resetQuiz()">🔄 Reset</button>
    <button class="btn danger" onclick="document.getElementById('finCard').classList.toggle('show')">📊 Final Score</button>
  </div>

  <div class="fin-card" id="finCard">
    <div class="fin-score" id="finScore">-</div>
    <div class="fin-label" id="finLabel">Complete the quiz to see results</div>
    <div class="fin-msg" id="finMsg"></div>
  </div>

  <div id="questionsWrap"></div>

  <div class="branding">
    Generated by <strong>NEXUS HUB XD</strong> · ${exam} · ${new Date().toLocaleDateString('en-IN')} · nexushubxd.vercel.app
  </div>
</div>

<script>
const QUESTIONS = ${questionsJSON};
let answered = {}, score = 0;

function renderAll() {
  const wrap = document.getElementById('questionsWrap');
  wrap.innerHTML = QUESTIONS.map((q, i) => \`
    <div class="q-card" id="qc\${i}">
      <div class="q-top">
        <div class="q-num">\${i+1}</div>
        <div class="q-text">\${q.question}</div>
      </div>
      <div class="opts">
        \${q.options.map((o, oi) => \`
          <div class="opt" id="opt_\${i}_\${oi}" onclick="pick(\${i},\${oi})">
            <div class="opt-ltr">\${'ABCD'[oi]}</div><span>\${o}</span>
          </div>
        \`).join('')}
      </div>
      <div class="exp" id="exp\${i}">\${q.explanation}</div>
    </div>
  \`).join('');
}

function pick(qi, sel) {
  if (answered[qi] !== undefined) return;
  answered[qi] = sel;
  const correct = QUESTIONS[qi].correct;
  const cEl = document.getElementById('opt_'+qi+'_'+correct);
  const sEl = document.getElementById('opt_'+qi+'_'+sel);
  if (cEl) cEl.classList.add('correct');
  if (sel !== correct && sEl) sEl.classList.add('wrong');
  document.querySelectorAll('#qc'+qi+' .opt').forEach(el => el.classList.add('locked'));
  const exp = document.getElementById('exp'+qi);
  if (exp) exp.classList.add('show');
  if (sel === correct) score++;
  updateScore();
}

function updateScore() {
  const done = Object.keys(answered).length;
  const total = QUESTIONS.length;
  const pct = done ? Math.round(score/done*100) : 0;
  document.getElementById('scoreNum').textContent = score + '/' + done;
  document.getElementById('scorePct').textContent = pct + '% · ' + done + '/' + total + ' answered';
  document.getElementById('pFill').style.width = (done/total*100) + '%';
  const fs = document.getElementById('finScore');
  const fl = document.getElementById('finLabel');
  const fm = document.getElementById('finMsg');
  if (fs) { fs.textContent = score+'/'+done; fl.textContent = pct+'% score · '+done+'/'+total+' answered'; }
  if (done === total) {
    fm.textContent = pct>=80?'🏆 Excellent!':pct>=60?'👍 Good Job!':pct>=40?'📚 Keep Studying!':'💪 Try Again!';
  }
}

function revealAll() {
  QUESTIONS.forEach((q,i) => {
    if (answered[i] === undefined) {
      answered[i] = q.correct;
      const cEl = document.getElementById('opt_'+i+'_'+q.correct);
      if (cEl) cEl.classList.add('correct');
      document.querySelectorAll('#qc'+i+' .opt').forEach(el => el.classList.add('locked'));
      const exp = document.getElementById('exp'+i);
      if (exp) exp.classList.add('show');
    }
  });
  score = QUESTIONS.filter(q => answered[QUESTIONS.indexOf(q)] === q.correct).length;
  // recount
  score = 0;
  QUESTIONS.forEach((q,i) => { if(answered[i]===q.correct) score++; });
  updateScore();
  document.getElementById('finCard').classList.add('show');
}

function resetQuiz() {
  answered = {}; score = 0;
  document.getElementById('finCard').classList.remove('show');
  renderAll(); updateScore();
}

renderAll();
</script>
</body>
</html>`;
}

window.NEXUS = { generateQuestions, buildQuizHTML, GROQ_KEYS };
