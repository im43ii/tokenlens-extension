'use strict';

const $ = id => document.getElementById(id);

// ── State ─────────────────────────────────────────────────────────────────────
let detectedData = null;
let variations   = [];
let activeVar    = 0;

// ── Persist server URL and token ──────────────────────────────────────────────
chrome.storage.local.get('serverUrl', ({ serverUrl }) => {
  if (serverUrl) $('server-url').value = serverUrl;
});
$('server-url').addEventListener('change', () => {
  chrome.storage.local.set({ serverUrl: $('server-url').value });
});

const savedToken = localStorage.getItem('tl_token');
if (savedToken) $('tl-token').value = savedToken;
$('tl-token').addEventListener('change', () => {
  const t = $('tl-token').value.trim();
  if (t) localStorage.setItem('tl_token', t);
  else localStorage.removeItem('tl_token');
});

function authHeaders() {
  const token = localStorage.getItem('tl_token') || $('tl-token').value.trim();
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

// ── Main tab switching ────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
    btn.classList.add('active');
    $(`panel-${btn.dataset.tab}`).classList.remove('hidden');
    if (btn.dataset.tab === 'project') pmInit();
  });
});

// ── Improve tab variation switching ──────────────────────────────────────────
document.querySelectorAll('.var-tab').forEach(btn => {
  btn.addEventListener('click', () => selectVariation(parseInt(btn.dataset.var, 10)));
});

function selectVariation(idx) {
  activeVar = idx;
  document.querySelectorAll('.var-tab').forEach((t, i) => t.classList.toggle('active', i === idx));
  document.querySelectorAll('.var-panel').forEach((p, i) => p.classList.toggle('active', i === idx));
}

// ── Shared helpers ────────────────────────────────────────────────────────────
function serverUrl() { return $('server-url').value.trim().replace(/\/$/, ''); }

function showAnalyzeError(msg) {
  $('analyze-error').textContent = msg;
  $('analyze-error').classList.remove('hidden');
  $('analyze-results').classList.add('hidden');
}
function showImproveError(msg) {
  $('improve-error').textContent = msg;
  $('improve-error').classList.remove('hidden');
}
function clearImproveError() { $('improve-error').classList.add('hidden'); }

function timeAgo(ts) {
  if (!ts) return '';
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ══════════════════════════════════════════════════════════════════════════════
// PROJECT MEMORY
// ══════════════════════════════════════════════════════════════════════════════
const PM_KEY = 'tl_project_memory';

function emptyProject() {
  return {
    projectName: '', description: '',
    techStack: { frontend: '', styling: '', backend: '', database: '', payment: '', other: '' },
    currentTask: '', completedTasks: [], preferences: '', history: [], lastUpdated: 0,
  };
}

function loadProjectMemory() {
  try {
    const raw = localStorage.getItem(PM_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveProjectMemory(pm) {
  pm.lastUpdated = Date.now();
  localStorage.setItem(PM_KEY, JSON.stringify(pm));
}

// Maps question keys → techStack fields
const Q_TO_STACK = {
  framework: 'frontend',
  platform:  'frontend',
  styling:   'styling',
  backend:   'backend',
  language:  'backend',
  database:  'database',
  payment:   'payment',
  // auth / charts / datasrc / task / level / admin / products → 'other' (not persisted to stack)
};

// ── Build rich project context string sent to /generate-prompt ────────────────
function buildProjectContext() {
  if (ab.ignoreProject) return undefined;
  const pm = loadProjectMemory();
  if (!pm || !pm.projectName) return undefined;

  const lines = [];
  lines.push(`You are helping build ${pm.projectName}${pm.description ? ': ' + pm.description : ''}.`);

  const stackParts = [pm.techStack.frontend, pm.techStack.styling, pm.techStack.backend, pm.techStack.database]
    .filter(Boolean);
  if (stackParts.length) lines.push(`Tech stack: ${stackParts.join(' + ')}`);
  if (pm.completedTasks.length) lines.push(`Completed so far: ${pm.completedTasks.slice(-5).join(', ')}`);
  if (pm.currentTask)  lines.push(`Currently working on: ${pm.currentTask}`);
  if (pm.preferences)  lines.push(`Developer preferences: ${pm.preferences}`);

  return lines.join('\n');
}

// ── Save AI Builder session answers + generated prompt back into memory ───────
function abSaveToMemory(result) {
  let pm = loadProjectMemory() || emptyProject();

  // Merge answers into techStack (skip "I don't know" answers)
  Object.entries(ab.answers).forEach(([key, val]) => {
    if (!val || val.startsWith("I don't")) return;
    const field = Q_TO_STACK[key];
    if (field) pm.techStack[field] = val;
  });

  // Add to history (cap at 10)
  if (result.prompt) {
    pm.history.unshift({ prompt: result.prompt, userRequest: ab.request, timestamp: Date.now() });
    pm.history = pm.history.slice(0, 10);
  }

  saveProjectMemory(pm);
}

// ══════════════════════════════════════════════════════════════════════════════
// ANALYZE TAB
// ══════════════════════════════════════════════════════════════════════════════
async function initAnalyze() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { showAnalyzeError('No active tab found.'); return; }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_MESSAGES' });
    if (!response) {
      $('site-name').textContent = 'Not connected';
      $('msg-count').textContent = '0';
      showAnalyzeError('Content script not responding. Reload the AI site tab and try again.');
      return;
    }
    detectedData = response;
    const count = response.messageCount ?? 0;
    $('site-name').textContent = response.editor ?? 'unknown';
    $('msg-count').textContent = count;
    if (count > 0) {
      $('dot').classList.add('active');
      $('analyze-btn').disabled = false;
      $('analyze-error').classList.add('hidden');
    } else {
      showAnalyzeError('No messages found. Open a conversation on the AI site first.');
    }
    tryAutoFillImprovePrompt(tab.id);
  } catch {
    $('site-name').textContent = 'Not supported';
    $('msg-count').textContent = '0';
    showAnalyzeError("Not an AI site, or the page hasn't loaded yet. Reload the tab and try again.");
  }
}

async function tryAutoFillImprovePrompt(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_INPUT_TEXT' });
    if (response?.text && response.text.trim().length > 3) {
      $('improve-prompt-input').value = response.text.trim();
      $('detect-hint').classList.remove('hidden');
    }
  } catch { /* silent */ }
}

$('analyze-btn').addEventListener('click', async () => {
  if (!detectedData?.messages?.length) return;
  const token = localStorage.getItem('tl_token') || $('tl-token').value.trim();
  if (!token) {
    showAnalyzeError(`No token found. Get your free token at ${serverUrl()}/register, then paste it in the Token field above.`);
    return;
  }
  const btn = $('analyze-btn');
  btn.disabled = true;
  btn.textContent = 'Analyzing…';
  $('analyze-error').classList.add('hidden');
  try {
    const res = await fetch(`${serverUrl()}/analyze-direct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ messages: detectedData.messages, model: detectedData.model, editor: detectedData.editor, provider: detectedData.provider }),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })); throw new Error(err.error ?? `HTTP ${res.status}`); }
    renderAnalyzeResults(await res.json());
  } catch (e) {
    const msg = e.message ?? String(e);
    showAnalyzeError(msg.includes('fetch') || msg.includes('Failed')
      ? `Cannot reach TokenLens at ${serverUrl()}. Is the server running?` : msg);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Analyze Conversation';
  }
});

function renderAnalyzeResults(data) {
  const tokens = data.breakdown?.total ?? 0;
  const cost   = data.cost?.estimated  ?? 0;
  const waste  = data.waste?.length    ?? 0;
  const top    = data.suggestions?.[0];
  $('analyze-results').innerHTML = `
    <div class="result-row"><span class="rl">Total tokens</span><span class="rv">${tokens.toLocaleString()}</span></div>
    <div class="result-row"><span class="rl">Est. cost</span><span class="rv">$${cost.toFixed(4)}</span></div>
    <div class="result-row"><span class="rl">Waste items</span><span class="rv ${waste === 0 ? 'green' : waste < 3 ? 'yellow' : ''}">${waste}</span></div>
    ${top ? `<div class="tip-row"><em>Tip:</em> ${top.title}</div>` : ''}
  `;
  $('analyze-results').classList.remove('hidden');
}

// ══════════════════════════════════════════════════════════════════════════════
// IMPROVE TAB
// ══════════════════════════════════════════════════════════════════════════════
$('improve-btn').addEventListener('click', async () => {
  const prompt  = $('improve-prompt-input').value.trim();
  const goal    = $('improve-goal').value || undefined;
  const context = $('improve-context').value.trim() || undefined;
  if (!prompt) { showImproveError('Please enter a prompt first.'); return; }
  const btn = $('improve-btn');
  btn.disabled = true;
  btn.textContent = 'Improving…';
  clearImproveError();
  $('improve-result').classList.add('hidden');
  try {
    const res = await fetch(`${serverUrl()}/improve-prompt`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ prompt, goal, context }),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })); throw new Error(err.error ?? `HTTP ${res.status}`); }
    renderImproveResults(await res.json());
  } catch (e) {
    const msg = e.message ?? String(e);
    showImproveError(msg.includes('fetch') || msg.includes('Failed')
      ? `Cannot reach TokenLens at ${serverUrl()}. Is the server running?` : msg);
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Improve Prompt';
  }
});

function scoreBadgeClass(s) { return s >= 8 ? 'high' : s >= 5 ? 'mid' : 'low'; }

function renderImproveResults(data) {
  variations = data.variations ?? [];
  activeVar  = 1;
  const vagueScore = data.vagueScore ?? 3;
  const pct = Math.round((vagueScore / 5) * 100);
  const fill = $('vague-fill');
  fill.style.width      = `${pct}%`;
  fill.style.background = vagueScore <= 2 ? '#f87171' : vagueScore <= 3 ? '#f59e0b' : '#22c55e';
  $('vague-score-text').textContent = `${vagueScore}/5`;
  $('vague-score-text').style.color = vagueScore <= 2 ? '#f87171' : vagueScore <= 3 ? '#f59e0b' : '#22c55e';
  const questions = data.clarifyingQuestions ?? [];
  if (questions.length) { $('clarify-list').innerHTML = questions.map(q => `<li>${q}</li>`).join(''); $('clarify-box').classList.remove('hidden'); }
  else $('clarify-box').classList.add('hidden');
  const stack = data.suggestedTechStack;
  if (stack?.primary) { $('stack-primary').textContent = stack.primary; $('stack-reason').textContent = stack.reason ? `— ${stack.reason}` : ''; $('stack-badge').classList.remove('hidden'); }
  else $('stack-badge').classList.add('hidden');
  variations.forEach((v, i) => {
    const score = v.qualityScore ?? 0;
    const s = $(`var-score-${i}`); if (s) s.textContent = `${score}/10`;
    const t = $(`text-${i}`);     if (t) t.textContent  = v.prompt ?? '';
    const b = $(`badge-${i}`);    if (b) { b.textContent = `${score}/10`; b.className = `score-badge ${scoreBadgeClass(score)}`; }
  });
  selectVariation(activeVar);
  const tip = data.tip ?? '';
  if (tip) { $('improve-tip').innerHTML = `<em>Tip:</em> ${tip}`; $('improve-tip').classList.remove('hidden'); }
  else $('improve-tip').classList.add('hidden');
  $('improve-result').classList.remove('hidden');
}

$('copy-btn').addEventListener('click', async () => {
  const v = variations[activeVar];
  if (!v?.prompt) return;
  try {
    await navigator.clipboard.writeText(v.prompt);
    const btn = $('copy-btn'); btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = '📋 Copy'; }, 1500);
  } catch { showImproveError('Could not access clipboard.'); }
});

$('insert-btn').addEventListener('click', async () => {
  const v = variations[activeVar];
  if (!v?.prompt) return;
  await injectIntoPage(v.prompt, showImproveError, 'insert-btn', '💉 Insert');
});

// ══════════════════════════════════════════════════════════════════════════════
// AI BUILDER TAB
// ══════════════════════════════════════════════════════════════════════════════
const QUESTION_SETS = {
  ecommerce: [
    { key: 'platform',  q: 'What platform or framework?',     opts: ['Next.js custom', 'Shopify', 'WooCommerce', 'React + Vite', "I don't know — pick for me"] },
    { key: 'payment',   q: 'Payment processing?',             opts: ['Stripe', 'PayPal', 'Both', 'Skip for now'] },
    { key: 'products',  q: 'What type of products?',          opts: ['Physical goods', 'Digital downloads', 'Both', 'Services / subscriptions'] },
    { key: 'admin',     q: 'Admin panel needed?',             opts: ['Yes — full CRUD', 'Yes — basic only', 'No', "I don't know"] },
  ],
  mobile: [
    { key: 'platform',  q: 'Target platform?',                opts: ['React Native', 'Flutter', 'iOS only (Swift)', 'Android only (Kotlin)', "I don't know — pick for me"] },
    { key: 'backend',   q: 'Backend / data storage?',         opts: ['Firebase', 'Supabase', 'Custom REST API', 'None / local only', "I don't know"] },
    { key: 'auth',      q: 'User authentication?',            opts: ['Yes — email/password', 'Yes — social login', 'No', "I don't know"] },
  ],
  dashboard: [
    { key: 'framework', q: 'Frontend framework?',             opts: ['Next.js', 'React', 'Vue', 'SvelteKit', "I don't know — pick for me"] },
    { key: 'charts',    q: 'Charts / visualization library?', opts: ['Recharts', 'Chart.js', 'D3.js', 'Tremor', "I don't know"] },
    { key: 'datasrc',   q: 'Data source?',                    opts: ['REST API', 'GraphQL', 'Supabase', 'Mock / static data', "I don't know"] },
  ],
  api: [
    { key: 'language',  q: 'Backend language?',               opts: ['Node.js / TypeScript', 'Python', 'Go', 'Rust', "I don't know — pick for me"] },
    { key: 'framework', q: 'Framework?',                      opts: ['Express', 'FastAPI', 'NestJS', 'Hono', "I don't know"] },
    { key: 'database',  q: 'Database?',                       opts: ['PostgreSQL', 'MongoDB', 'SQLite', 'Supabase', "I don't know"] },
    { key: 'auth',      q: 'Authentication?',                 opts: ['JWT', 'OAuth 2.0', 'API Keys', 'None needed'] },
  ],
  script: [
    { key: 'language',  q: 'Language / runtime?',             opts: ['Python', 'Node.js', 'Bash / Shell', 'TypeScript', "I don't know — pick for me"] },
    { key: 'task',      q: 'What does the script do?',        opts: ['File processing', 'Web scraping', 'API calls / integration', 'Data analysis', 'Something else'] },
  ],
  website: [
    { key: 'framework', q: 'Framework / stack?',              opts: ['Next.js', 'React + Vite', 'Vue', 'Plain HTML/CSS', "I don't know — pick for me"] },
    { key: 'styling',   q: 'Styling approach?',               opts: ['Tailwind CSS', 'CSS Modules', 'Styled Components', 'Bootstrap', "I don't know"] },
    { key: 'backend',   q: 'Backend needed?',                 opts: ['Yes — Node.js', 'Yes — Python', 'No — frontend only', "I don't know"] },
    { key: 'database',  q: 'Database?',                       opts: ['Supabase', 'PostgreSQL', 'MongoDB', 'None needed', "I don't know"] },
  ],
  other: [
    { key: 'language',  q: 'Primary language / tech?',        opts: ['JavaScript / TypeScript', 'Python', 'Go', 'Rust', 'Other'] },
    { key: 'level',     q: 'Your experience level?',          opts: ['Beginner', 'Intermediate', 'Advanced'] },
  ],
};

function detectCategory(input) {
  const s = input.toLowerCase();
  if (/ecommerce|e-commerce|shop|store|product|cart|checkout|payment|sell|shopify/.test(s)) return 'ecommerce';
  if (/mobile|ios|android|react native|flutter|app store|play store/.test(s))               return 'mobile';
  if (/dashboard|admin panel|analytics|chart|metric|monitoring|reporting/.test(s))           return 'dashboard';
  if (/\bapi\b|backend|server|endpoint|microservice|rest|graphql|fastapi|express/.test(s))  return 'api';
  if (/script|automat|scrape|scraper|bot|cli|cron|workflow|pipeline|etl/.test(s))           return 'script';
  if (/website|web app|site|page|landing|portfolio|blog|saas|startup/.test(s))              return 'website';
  return 'other';
}

// ── Builder state ─────────────────────────────────────────────────────────────
let ab = {
  provider: '', apiKey: '', request: '', category: '',
  questions: [], currentQ: 0, answers: {},
  result: null, ignoreProject: false,
};

// ── Show/hide screens ─────────────────────────────────────────────────────────
function abShow(screenId) {
  ['ab-setup', 'ab-input', 'ab-questions', 'ab-generating', 'ab-result'].forEach(id => {
    $(id).classList.toggle('hidden', id !== screenId);
  });
  if (screenId === 'ab-input') abUpdateBanner();
}

// ── Project banner in input screen ───────────────────────────────────────────
function abUpdateBanner() {
  if (ab.ignoreProject) { $('ab-project-banner').classList.add('hidden'); return; }
  const pm = loadProjectMemory();
  if (pm && pm.projectName) {
    const hint = pm.techStack.frontend || pm.techStack.backend || '';
    $('ab-banner-name').textContent = pm.projectName + (hint ? ` · ${hint}` : '');
    $('ab-project-banner').classList.remove('hidden');
  } else {
    $('ab-project-banner').classList.add('hidden');
  }
}

$('ab-banner-ignore').addEventListener('click', () => {
  ab.ignoreProject = true;
  $('ab-project-banner').classList.add('hidden');
});

// ── Init ──────────────────────────────────────────────────────────────────────
function abInit() {
  ab.provider = localStorage.getItem('tl_provider') || '';
  ab.apiKey   = localStorage.getItem('tl_api_key')  || '';
  abShow(ab.provider && ab.apiKey ? 'ab-input' : 'ab-setup');
}

// ── Setup screen ──────────────────────────────────────────────────────────────
let selectedProvider = '';

document.querySelectorAll('.provider-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.provider-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    selectedProvider = card.dataset.provider;
    const labels = {
      anthropic: { label: 'Anthropic API Key', placeholder: 'sk-ant-...' },
      openai:    { label: 'OpenAI API Key',     placeholder: 'sk-...' },
      groq:      { label: 'Groq API Key',       placeholder: 'gsk_...' },
    };
    const cfg = labels[selectedProvider] ?? labels.openai;
    $('ab-key-label').textContent = cfg.label;
    $('ab-api-key').placeholder   = cfg.placeholder;
  });
});

$('ab-key-toggle').addEventListener('click', () => {
  const inp = $('ab-api-key');
  inp.type = inp.type === 'password' ? 'text' : 'password';
  $('ab-key-toggle').textContent = inp.type === 'password' ? 'Show' : 'Hide';
});

$('ab-save-key').addEventListener('click', () => {
  const key = $('ab-api-key').value.trim();
  $('ab-setup-error').classList.add('hidden');
  if (!selectedProvider) { $('ab-setup-error').textContent = 'Please choose a provider.'; $('ab-setup-error').classList.remove('hidden'); return; }
  if (!key)               { $('ab-setup-error').textContent = 'Please enter your API key.'; $('ab-setup-error').classList.remove('hidden'); return; }
  ab.provider = selectedProvider;
  ab.apiKey   = key;
  localStorage.setItem('tl_provider', selectedProvider);
  localStorage.setItem('tl_api_key',  key);
  abShow('ab-input');
});

$('ab-change-key').addEventListener('click', () => {
  $('ab-api-key').value = ab.apiKey;
  if (ab.provider) {
    const card = $(`ab-card-${ab.provider}`);
    if (card) { document.querySelectorAll('.provider-card').forEach(c => c.classList.remove('selected')); card.classList.add('selected'); selectedProvider = ab.provider; }
  }
  abShow('ab-setup');
});

// ── Input screen ──────────────────────────────────────────────────────────────
$('ab-start-btn').addEventListener('click', () => {
  const req = $('ab-request').value.trim();
  if (!req) return;

  ab.request  = req;
  ab.category = detectCategory(req);
  ab.currentQ = 0;
  ab.answers  = {};

  const allQuestions = QUESTION_SETS[ab.category] ?? QUESTION_SETS.other;

  // Pre-fill from project memory and skip answered questions
  if (!ab.ignoreProject) {
    const pm = loadProjectMemory();
    if (pm) {
      allQuestions.forEach(q => {
        const field = Q_TO_STACK[q.key];
        const saved = field ? pm.techStack[field] : null;
        if (saved && !saved.startsWith("I don't")) {
          ab.answers[q.key] = saved;
        }
      });
    }
  }

  // Only show questions that aren't already answered from memory
  ab.questions = allQuestions.filter(q => !ab.answers[q.key]);

  if (ab.questions.length === 0) {
    // All answered from memory — skip straight to generation
    abGenerate();
  } else {
    abShow('ab-questions');
    abRenderQuestion();
  }
});

// ── Questions screen ──────────────────────────────────────────────────────────
function abRenderQuestion() {
  const q     = ab.questions[ab.currentQ];
  const total = ab.questions.length;
  $('ab-step-text').textContent = `Step ${ab.currentQ + 1} of ${total}`;

  const dots = $('ab-dots');
  dots.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const d = document.createElement('div');
    d.className = 'ab-dot' + (i < ab.currentQ ? ' done' : i === ab.currentQ ? ' active' : '');
    dots.appendChild(d);
  }

  $('ab-q-title').textContent = q.q;
  $('ab-custom-input').value  = '';
  $('ab-q-error').classList.add('hidden');

  const container = $('ab-options');
  container.innerHTML = '';
  q.opts.forEach(opt => {
    const btn = document.createElement('button');
    btn.className   = 'ab-option' + (opt.startsWith("I don't") ? ' idk' : '');
    btn.textContent = opt;
    btn.addEventListener('click', () => abAnswer(q.key, opt));
    container.appendChild(btn);
  });

  $('ab-back-btn').style.visibility = ab.currentQ === 0 ? 'hidden' : 'visible';
}

function abAnswer(key, value) {
  ab.answers[key] = value;
  ab.currentQ++;
  if (ab.currentQ >= ab.questions.length) abGenerate();
  else abRenderQuestion();
}

$('ab-custom-submit').addEventListener('click', () => {
  const val = $('ab-custom-input').value.trim();
  if (!val) { $('ab-q-error').textContent = 'Please type an answer or choose an option above.'; $('ab-q-error').classList.remove('hidden'); return; }
  abAnswer(ab.questions[ab.currentQ].key, val);
});

$('ab-custom-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('ab-custom-submit').click(); });

$('ab-back-btn').addEventListener('click', () => {
  if (ab.currentQ > 0) { ab.currentQ--; abRenderQuestion(); }
});

// ── Generate ──────────────────────────────────────────────────────────────────
async function abGenerate() {
  abShow('ab-generating');
  const genLabels = { anthropic: 'Powered by Claude Haiku', openai: 'Powered by GPT-4o mini', groq: 'Powered by Groq — Llama 3.3 70B' };
  $('ab-gen-provider').textContent = genLabels[ab.provider] ?? 'Generating…';

  try {
    const projectContext = buildProjectContext();

    const res = await fetch(`${serverUrl()}/generate-prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        userRequest:    ab.request,
        answers:        ab.answers,
        provider:       ab.provider,
        apiKey:         ab.apiKey,
        projectContext: projectContext,
      }),
    });

    if (!res.ok) { const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })); throw new Error(err.error ?? `HTTP ${res.status}`); }

    ab.result = await res.json();
    abRenderResult(ab.result);
  } catch (e) {
    abShow('ab-result');
    const msg = e.message ?? String(e);
    $('ab-result-error').textContent = msg.includes('fetch') || msg.includes('Failed')
      ? `Cannot reach TokenLens at ${serverUrl()}. Is the server running?`
      : (msg.includes('401') || msg.includes('invalid_api_key') || msg.includes('Incorrect') || msg.includes('Invalid API'))
        ? 'Invalid API key. Click "Change API key" to update it.'
        : msg;
    $('ab-result-error').classList.remove('hidden');
    $('ab-result-text').textContent = '';
    $('ab-score-badge').textContent = '—/10';
    $('ab-tips').innerHTML = '';
    $('ab-task-card').classList.add('hidden');
    $('ab-next-task-row').classList.add('hidden');
  }
}

function abRenderResult(data) {
  abShow('ab-result');
  $('ab-result-error').classList.add('hidden');
  $('ab-task-card').classList.add('hidden');
  $('ab-next-task-row').classList.add('hidden');

  const prompt = data.prompt ?? '';
  const score  = data.qualityScore ?? 0;
  const tips   = data.tips ?? [];

  $('ab-result-text').textContent = prompt;

  const badge = $('ab-score-badge');
  badge.textContent = `${score}/10`;
  badge.className   = `score-badge ${scoreBadgeClass(score)}`;

  $('ab-tips').innerHTML = tips.map(t => `<li>${t}</li>`).join('');

  // Auto-save to project memory
  abSaveToMemory(data);

  // Show task-completion UI if project has a current task
  const pm = loadProjectMemory();
  if (pm && pm.projectName && pm.currentTask) {
    $('ab-task-name').textContent = pm.currentTask;
    $('ab-task-card').classList.remove('hidden');
  }
}

// ── Task completion ───────────────────────────────────────────────────────────
$('ab-mark-yes').addEventListener('click', () => {
  const pm = loadProjectMemory();
  if (!pm) return;
  if (pm.currentTask) {
    pm.completedTasks.push(pm.currentTask);
    pm.completedTasks = pm.completedTasks.slice(-20); // keep last 20
  }
  pm.currentTask = '';
  saveProjectMemory(pm);
  $('ab-task-card').classList.add('hidden');
  $('ab-next-task-row').classList.remove('hidden');
  $('ab-next-input').focus();
});

$('ab-mark-no').addEventListener('click', () => {
  $('ab-task-card').classList.add('hidden');
});

$('ab-next-save').addEventListener('click', () => {
  const val = $('ab-next-input').value.trim();
  if (!val) return;
  const pm = loadProjectMemory();
  if (pm) { pm.currentTask = val; saveProjectMemory(pm); }
  $('ab-next-task-row').classList.add('hidden');
  $('ab-next-input').value = '';
  // Flash confirmation
  const btn = $('ab-next-save');
  btn.textContent = '✓';
  setTimeout(() => { btn.textContent = 'Save →'; }, 1200);
});

$('ab-next-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('ab-next-save').click(); });

// ── Copy / Insert / Redo / Start over ─────────────────────────────────────────
$('ab-copy-btn').addEventListener('click', async () => {
  const text = $('ab-result-text').textContent;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const btn = $('ab-copy-btn'); btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = '📋 Copy'; }, 1500);
  } catch { $('ab-result-error').textContent = 'Could not access clipboard.'; $('ab-result-error').classList.remove('hidden'); }
});

$('ab-insert-btn').addEventListener('click', async () => {
  const text = $('ab-result-text').textContent;
  if (!text) return;
  await injectIntoPage(text, msg => { $('ab-result-error').textContent = msg; $('ab-result-error').classList.remove('hidden'); }, 'ab-insert-btn', '💉 Insert');
});

$('ab-regen-btn').addEventListener('click', () => {
  ab.currentQ = 0;
  // Re-run full question set (ignore pre-fills for redo)
  ab.questions = QUESTION_SETS[ab.category] ?? QUESTION_SETS.other;
  ab.answers   = {};
  abShow('ab-questions');
  abRenderQuestion();
});

$('ab-start-over').addEventListener('click', () => {
  $('ab-request').value = '';
  ab.answers       = {};
  ab.result        = null;
  ab.ignoreProject = false;
  abShow('ab-input');
});

// ══════════════════════════════════════════════════════════════════════════════
// MY PROJECT TAB
// ══════════════════════════════════════════════════════════════════════════════
function pmInit() {
  const pm = loadProjectMemory();
  if (pm && pm.projectName) pmShowFilled(pm);
  else pmShowEmpty(null);
}

function pmShowEmpty(existingPm) {
  $('pm-empty').classList.remove('hidden');
  $('pm-filled').classList.add('hidden');
  if (existingPm) {
    $('pm-name').value        = existingPm.projectName;
    $('pm-description').value = existingPm.description;
    $('pm-task').value        = existingPm.currentTask;
    $('pm-prefs').value       = existingPm.preferences;
    $('pm-cancel').classList.remove('hidden');
  } else {
    $('pm-name').value = '';
    $('pm-description').value = '';
    $('pm-task').value = '';
    $('pm-prefs').value = '';
    $('pm-cancel').classList.add('hidden');
  }
  $('pm-save-error').classList.add('hidden');
}

function pmShowFilled(pm) {
  $('pm-empty').classList.add('hidden');
  $('pm-filled').classList.remove('hidden');

  $('pm-name-display').textContent    = pm.projectName;
  $('pm-updated-display').textContent = pm.lastUpdated ? `Updated ${timeAgo(pm.lastUpdated)}` : '';

  // Tech stack badges
  const badgeEl = $('pm-stack-badges');
  badgeEl.innerHTML = '';
  const stackDefs = [
    { field: 'frontend', cls: 'fe' },
    { field: 'styling',  cls: 'st' },
    { field: 'backend',  cls: 'be' },
    { field: 'database', cls: 'db' },
    { field: 'payment',  cls: 'py' },
  ];
  stackDefs.forEach(({ field, cls }) => {
    const val = pm.techStack[field];
    if (val) {
      const span = document.createElement('span');
      span.className   = `pm-badge ${cls}`;
      span.textContent = val;
      badgeEl.appendChild(span);
    }
  });

  // Completed tasks count
  const doneEl = $('pm-done-badge');
  if (pm.completedTasks.length > 0) {
    doneEl.textContent = `✅ ${pm.completedTasks.length} task${pm.completedTasks.length > 1 ? 's' : ''} completed`;
    doneEl.classList.remove('hidden');
  } else {
    doneEl.classList.add('hidden');
  }

  // Current task
  $('pm-task-display').textContent  = pm.currentTask  || '(not set)';
  $('pm-prefs-display').textContent = pm.preferences  || '(not set)';

  // Recent prompts (last 3)
  const histWrap = $('pm-history-wrap');
  const histList = $('pm-history-list');
  histList.innerHTML = '';
  const recent = pm.history.slice(0, 3);
  if (recent.length > 0) {
    histWrap.classList.remove('hidden');
    recent.forEach(item => {
      const div = document.createElement('div');
      div.className = 'pm-history-item';
      div.innerHTML = `
        <div class="pm-history-req">${escHtml(item.userRequest || 'Prompt')}</div>
        <div class="pm-history-preview">${escHtml(item.prompt || '')}</div>
      `;
      div.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(item.prompt);
          div.querySelector('.pm-history-preview').textContent = '✓ Copied!';
          setTimeout(() => { div.querySelector('.pm-history-preview').textContent = item.prompt; }, 1500);
        } catch { /* ignore */ }
      });
      histList.appendChild(div);
    });
  } else {
    histWrap.classList.add('hidden');
  }
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Save button
$('pm-save-btn').addEventListener('click', () => {
  const name = $('pm-name').value.trim();
  $('pm-save-error').classList.add('hidden');
  if (!name) {
    $('pm-save-error').textContent = 'Project name is required.';
    $('pm-save-error').classList.remove('hidden');
    return;
  }
  const existing = loadProjectMemory() || emptyProject();
  existing.projectName  = name;
  existing.description  = $('pm-description').value.trim();
  existing.currentTask  = $('pm-task').value.trim();
  existing.preferences  = $('pm-prefs').value.trim();
  saveProjectMemory(existing);
  pmShowFilled(existing);
});

// Cancel editing
$('pm-cancel').addEventListener('click', () => {
  const pm = loadProjectMemory();
  if (pm) pmShowFilled(pm);
});

// Update task quick input
$('pm-update-btn').addEventListener('click', () => {
  const val = $('pm-update-input').value.trim();
  if (!val) return;
  const pm = loadProjectMemory();
  if (!pm) return;
  pm.currentTask = val;
  saveProjectMemory(pm);
  $('pm-task-display').textContent = val;
  $('pm-update-input').value = '';
  $('pm-updated-display').textContent = 'Updated just now';
});

$('pm-update-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('pm-update-btn').click(); });

// Edit project
$('pm-edit-btn').addEventListener('click', () => {
  const pm = loadProjectMemory();
  pmShowEmpty(pm);
});

// Reset project (with confirmation)
$('pm-reset-btn').addEventListener('click', () => {
  const name = loadProjectMemory()?.projectName || 'this project';
  if (!confirm(`Reset "${name}"? This will clear all saved stack, tasks, and prompt history.`)) return;
  localStorage.removeItem(PM_KEY);
  pmShowEmpty(null);
});

// ══════════════════════════════════════════════════════════════════════════════
// SHARED: inject prompt into the active AI page
// ══════════════════════════════════════════════════════════════════════════════
async function injectIntoPage(text, showError, btnId, defaultLabel) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { showError('No active tab found.'); return; }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'INJECT_PROMPT', text });
    if (response?.ok) {
      const btn = $(btnId); btn.textContent = '✓ Inserted!';
      setTimeout(() => { btn.textContent = defaultLabel; }, 1500);
    } else {
      showError(response?.error ?? 'Could not find chat input on this page.');
    }
  } catch { showError('Content script not reachable. Reload the AI site tab.'); }
}

// ══════════════════════════════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════════════════════════════
initAnalyze();
abInit();
