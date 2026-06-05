// ═══════════════════════════════════════════════════════════════
// NEXUS HUB XD — generate.js
// ═══════════════════════════════════════════════════════════════

const GROQ_KEYS = [
  'YOUR_GROQ_API_KEY_1',
  'YOUR_GROQ_API_KEY_2',
  'YOUR_GROQ_API_KEY_3',
];

// ── SMART KEY MANAGER ─────────────────────────────────────────
// Tracks rate limits per key in memory (resets on page reload)
const keyStatus = {}; // { idx: { limited: bool, resetAt: timestamp } }

function isKeyAvailable(idx) {
  const s = keyStatus[idx];
  if (!s || !s.limited) return true;
  if (Date.now() > s.resetAt) { keyStatus[idx] = { limited: false }; return true; }
  return false;
}

function markRateLimited(idx, retryAfterSec) {
  const wait = (retryAfterSec || 10) * 1000;
  keyStatus[idx] = { limited: true, resetAt: Date.now() + wait };
  console.warn(`Key ${idx+1} rate limited for ${retryAfterSec || 10}s`);
}

// Returns how many seconds until a key is free (0 if free now)
function getWaitTime() {
  const times = GROQ_KEYS.map((k, i) => {
    if (!k || k.startsWith('YOUR_')) return Infinity;
    if (isKeyAvailable(i)) return 0;
    return Math.ceil((keyStatus[i].resetAt - Date.now()) / 1000);
  });
  return Math.min(...times);
}

// ── API CALL WITH SMART ROTATION ──────────────────────────────
let lastKeyIdx = 0;

async function callGroq(body) {
  const validIdxs = GROQ_KEYS.map((k, i) => i).filter(i => {
    const k = GROQ_KEYS[i];
    return k && !k.startsWith('YOUR_');
  });

  if (validIdxs.length === 0) return { error: 'no_keys' };

  // Try each valid key, starting from last used
  for (let attempt = 0; attempt < validIdxs.length; attempt++) {
    const idx = validIdxs[(lastKeyIdx + attempt) % validIdxs.length];
    if (!isKeyAvailable(idx)) continue;

    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GROQ_KEYS[idx]}`
        },
        body: JSON.stringify(body)
      });

      if (res.status === 429) {
        let retryAfter = 60;
        try {
          const errJson = await res.clone().json();
          // GROQ returns retry time in error message
          const match = (errJson?.error?.message || '').match(/try again in (\d+\.?\d*)s/i);
          if (match) retryAfter = Math.ceil(parseFloat(match[1]));
          const hdr = res.headers.get('retry-after');
          if (hdr) retryAfter = parseInt(hdr);
        } catch {}
        markRateLimited(idx, retryAfter);
        continue;
      }

      if (res.status === 401) {
        console.error(`Key ${idx+1} unauthorized (401) — check if key is valid`);
        keyStatus[idx] = { limited: true, resetAt: Date.now() + 999999999 }; // Mark as dead
        continue;
      }

      if (!res.ok) {
        const txt = await res.text();
        console.error(`Key ${idx+1} error ${res.status}:`, txt);
        continue;
      }

      lastKeyIdx = (validIdxs.indexOf(idx) + 1) % validIdxs.length; // Rotate for next call
      return { res };

    } catch (err) {
      console.error(`Key ${idx+1} network error:`, err.message);
    }
  }

  // All keys failed — check wait time
  const wait = getWaitTime();
  if (wait === Infinity) return { error: 'no_keys' };
  if (wait > 0) return { error: 'rate_limit', waitSec: wait };
  return { error: 'all_failed' };
}

// ── EXAM PROMPTS ──────────────────────────────────────────────
const EXAM_PROMPTS = {
  'NEET UG': `You are an expert NEET UG MCQ generator for Biology, Physics, Chemistry.
NEET UG standards: Strictly NCERT-based (Class 11 & 12). Cover conceptual understanding, application, and NCERT line-based questions.
Difficulty: medical entrance level. Focus on NCERT definitions, diagrams, examples, clinical applications, and PYQ-style questions.
Question variety is MANDATORY: Mix direct concept, NCERT statement completion, which-is-correct, which-is-incorrect, assertion-reason style.`,

  'JEE Main': `You are an expert JEE Main MCQ generator for Physics, Chemistry, Mathematics.
JEE Main standards: NTA pattern, application-based, numerical problems, conceptual clarity.
Difficulty: engineering entrance level.`,

  'JEE Advanced': `You are an expert JEE Advanced MCQ generator for Physics, Chemistry, Mathematics.
JEE Advanced standards: highest difficulty, multi-concept integration, analytical thinking required.`,

  'GUJCET': `You are an expert GUJCET MCQ generator.
GUJCET standards: Gujarat State Board syllabus, Physics Chemistry Maths/Biology.
Difficulty: state entrance level. Based on GSEB textbooks.`,

  'Gujarat Board (GHSEB)': `You are an expert GHSEB MCQ generator.
GHSEB standards: Class 11-12 Gujarat Board syllabus.
Difficulty: board exam level. Focus on textbook definitions and standard formulas.`,

  'General': `You are an expert MCQ generator.
Create well-balanced questions covering theory, application, and analysis.`
};

// ── MAIN GENERATE FUNCTION ────────────────────────────────────
async function generateQuestions({ topic, numQ, difficulty, language, exam, subject, onProgress, onError }) {
  const examPrompt = EXAM_PROMPTS[exam] || EXAM_PROMPTS['General'];
  const total = parseInt(numQ);

  const isGuj = language === 'Gujarati';
  const isHin = language === 'Hindi';

  const langInstruction = isGuj
    ? `CRITICAL: Write EVERY word in Gujarati script (ગુજરાતી) ONLY. No English anywhere.`
    : isHin
    ? `CRITICAL: Write EVERY word in Hindi (हिंदी) ONLY. No English anywhere.`
    : `Write everything in clear English.`;

  // Token-efficient settings
  const BATCH = isGuj ? 3 : isHin ? 4 : 10;
  const MAX_TOK = isGuj ? 2500 : isHin ? 3000 : 4000;
  const MODEL = 'llama-3.1-8b-instant'; // High rate limit, fast

  const totalBatches = Math.ceil(total / BATCH);
  let allQ = [];

  // Run 2 batches in parallel (faster!) except for Gujarati (token heavy)
  const PARALLEL = isGuj ? 1 : 2;

  async function fetchBatch(batchIndex, startId) {
    const bCount = Math.min(BATCH, total - startId);
    if (bCount <= 0) return [];
    const startN = startId + 1;

    const diffMap = {
      'easy': exam === 'JEE Advanced' ? 'medium' : 'easy',
      'medium': 'medium', 'hard': 'hard',
      'mixed': 'varied (mix of easy, medium, hard)'
    };

    const stemExamples = isGuj
      ? `કયો, કઈ, શું, ક્યારે, કોણ, કેટલા, નીચેમાંથી, સાચો વિકલ્પ, ખોટું વિધાન`
      : isHin
      ? `कौन सा, क्या, कितने, नीचे में से, सही विकल्प, गलत कथन`
      : `Which, What, How many, Identify, Which of the following, The correct statement, Which is NOT`;

    const prompt = `Generate exactly ${bCount} MCQ about: "${topic}".
Exam: ${exam} | Subject: ${subject||'General'} | Difficulty: ${diffMap[difficulty]||difficulty}
${langInstruction}
Questions ${startN} to ${startN+bCount-1}.

RULES:
- Each question starts with a DIFFERENT word. Never repeat topic name at start.
- Use stems: ${stemExamples}
- Return ONLY valid JSON array. No markdown, no backticks, no extra text.
- Format: [{"question":"...","options":["A","B","C","D"],"correct":0,"explanation":"..."}]
- "correct" = 0-based index (0=A,1=B,2=C,3=D)
- Keep explanations brief (1-2 lines).

Start with [ and end with ]`;

    for (let retry = 0; retry < 3; retry++) {
      const result = await callGroq({
        model: MODEL,
        messages: [
          { role: 'system', content: `${examPrompt}\n${langInstruction}\nReturn ONLY valid JSON array.` },
          { role: 'user', content: prompt }
        ],
        temperature: 0.4,
        max_tokens: MAX_TOK
      });

      if (!result || result.error) {
        if (result?.error === 'rate_limit') {
          const waitSec = result.waitSec || 10;
          if (onError) onError('rate_limit', waitSec);
          await new Promise(r => setTimeout(r, waitSec * 1000));
        }
        if (result?.error === 'no_keys') {
          if (onError) onError('no_keys', 0);
          return [];
        }
        continue;
      }

      const data = await result.res.json();
      const raw = data.choices?.[0]?.message?.content?.trim();
      if (!raw) continue;

      const s = raw.indexOf('['), e = raw.lastIndexOf(']');
      if (s === -1 || e === -1) continue;

      let jsonStr = raw.substring(s, e + 1)
        .replace(/,\s*]/g, ']').replace(/,\s*}/g, '}')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ');

      let parsed;
      try { parsed = JSON.parse(jsonStr); } catch { continue; }
      if (!Array.isArray(parsed) || !parsed.length) continue;

      return parsed
        .filter(q => q.question && q.question.length > 5)
        .map((q, i) => ({
          id: startId + i + 1,
          question: q.question,
          options: Array.isArray(q.options) && q.options.length >= 4
            ? q.options.slice(0, 4)
            : ['Option A', 'Option B', 'Option C', 'Option D'],
          correct: typeof q.correct === 'number' && q.correct >= 0 && q.correct <= 3 ? q.correct : 0,
          explanation: q.explanation || 'Refer to textbook.',
          difficulty
        }));
    }
    return [];
  }

  // Process batches — parallel where possible
  for (let b = 0; b < totalBatches; b += PARALLEL) {
    const batchPromises = [];
    for (let p = 0; p < PARALLEL && (b + p) < totalBatches; p++) {
      const startId = (b + p) * BATCH;
      batchPromises.push(fetchBatch(b + p, Math.min(startId, total - 1)));
    }

    const results = await Promise.all(batchPromises);
    for (const res of results) {
      if (res.length > 0) {
        // Fix IDs to be sequential
        res.forEach((q, i) => { q.id = allQ.length + i + 1; });
        allQ = [...allQ, ...res];
        if (onProgress) onProgress(allQ.length, total, Math.ceil(allQ.length / BATCH), totalBatches);
      }
    }
  }

  return allQ;
}

// ── HTML QUIZ BUILDER ─────────────────────────────────────────
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
:root{--bg:#0a0a0f;--surface:#13131a;--card:#1a1a24;--border:#2a2a3a;--accent:#7c6aff;--accent2:#ff6a9b;--accent3:#6affd4;--text:#e8e8f0;--muted:#7070a0;}
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
  <div class="branding">Generated by <strong>NEXUS HUB XD</strong> · ${exam} · ${new Date().toLocaleDateString('en-IN')}</div>
</div>
<script>
const QUESTIONS=${questionsJSON};
let answered={},score=0;
function renderAll(){
  const w=document.getElementById('questionsWrap');
  w.innerHTML=QUESTIONS.map((q,i)=>\`<div class="q-card" id="qc\${i}">
    <div class="q-top"><div class="q-num">\${i+1}</div><div class="q-text">\${q.question}</div></div>
    <div class="opts">\${q.options.map((o,oi)=>\`<div class="opt" id="opt_\${i}_\${oi}" onclick="pick(\${i},\${oi})"><div class="opt-ltr">\${'ABCD'[oi]}</div><span>\${o}</span></div>\`).join('')}</div>
    <div class="exp" id="exp\${i}">\${q.explanation}</div>
  </div>\`).join('');
}
function pick(qi,sel){
  if(answered[qi]!==undefined)return;
  answered[qi]=sel;
  const c=QUESTIONS[qi].correct;
  document.getElementById('opt_'+qi+'_'+c)?.classList.add('correct');
  if(sel!==c)document.getElementById('opt_'+qi+'_'+sel)?.classList.add('wrong');
  document.querySelectorAll('#qc'+qi+' .opt').forEach(el=>el.classList.add('locked'));
  document.getElementById('exp'+qi)?.classList.add('show');
  if(sel===c)score++;
  updateScore();
}
function updateScore(){
  const done=Object.keys(answered).length,total=QUESTIONS.length;
  const pct=done?Math.round(score/done*100):0;
  document.getElementById('scoreNum').textContent=score+'/'+done;
  document.getElementById('scorePct').textContent=pct+'% · '+done+'/'+total+' answered';
  document.getElementById('pFill').style.width=(done/total*100)+'%';
  document.getElementById('finScore').textContent=score+'/'+done;
  document.getElementById('finLabel').textContent=pct+'% score · '+done+'/'+total+' answered';
  if(done===total)document.getElementById('finMsg').textContent=pct>=80?'🏆 Excellent!':pct>=60?'👍 Good Job!':pct>=40?'📚 Keep Studying!':'💪 Try Again!';
}
function revealAll(){
  QUESTIONS.forEach((q,i)=>{
    if(answered[i]===undefined){
      answered[i]=q.correct;
      document.getElementById('opt_'+i+'_'+q.correct)?.classList.add('correct');
      document.querySelectorAll('#qc'+i+' .opt').forEach(el=>el.classList.add('locked'));
      document.getElementById('exp'+i)?.classList.add('show');
    }
  });
  score=0;QUESTIONS.forEach((q,i)=>{if(answered[i]===q.correct)score++;});
  updateScore();document.getElementById('finCard').classList.add('show');
}
function resetQuiz(){answered={};score=0;document.getElementById('finCard').classList.remove('show');renderAll();updateScore();}
renderAll();
</script>
</body>
</html>`;
}

window.NEXUS = { generateQuestions, buildQuizHTML, GROQ_KEYS };