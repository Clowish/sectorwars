const config = require('./config');

// ── Groq (Llama 3.3 70B) ─────────────────────────────────────────────────────
async function callGroq(system_prompt, player_state_json) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant', // temp: 70b daily limit hit; restore to llama-3.3-70b-versatile when reset
      messages: [
        { role: 'system', content: system_prompt },
        { role: 'user', content: JSON.stringify(player_state_json) },
      ],
      temperature: 0.85,
      max_tokens: 600,
      response_format: { type: 'json_object' },
    }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq HTTP ${response.status}: ${err.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.choices[0].message.content;
}

// ── Groq (Qwen3-32B — reasoning model) ───────────────────────────────────────
// deepseek-r1-distill-llama-70b was decommissioned; qwen/qwen3-32b is the
// current Groq model that emits <think>...</think> chain-of-thought blocks.
// Extraction logic is identical to what was written for DeepSeek R1.
async function callGroqDeepSeek(system_prompt, player_state_json) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'qwen/qwen3-32b',
      messages: [
        { role: 'system', content: system_prompt },
        { role: 'user', content: JSON.stringify(player_state_json) },
      ],
      temperature: 0.6,   // lower temp suits a reasoning model
      max_tokens: 2000,   // think block can be 500-1000 tokens before the JSON
      // No response_format — the <think> prefix breaks strict JSON mode
    }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq/Qwen3 HTTP ${response.status}: ${err.slice(0, 200)}`);
  }
  const data = await response.json();
  const raw = data.choices[0].message.content;

  // Pull out <think>...</think> (case-insensitive, dotall)
  const think_match = raw.match(/<think>([\s\S]*?)<\/think>/i);
  const deepseek_reasoning = think_match ? think_match[1].trim() : null;

  // Everything after the closing tag is the JSON payload
  const json_part = raw.replace(/<think>[\s\S]*?<\/think>/i, '').replace(/```json|```/g, '').trim();

  // Inject reasoning into the action object so parseModelResponse preserves it
  try {
    const parsed = JSON.parse(json_part);
    if (deepseek_reasoning) parsed.deepseek_reasoning = deepseek_reasoning;
    return JSON.stringify(parsed);
  } catch (_) {
    // Let parseModelResponse handle the failure; reasoning is lost but action
    // fallback kicks in normally.
    return json_part;
  }
}

// ── Cerebras (Llama 3.3 70B) ─────────────────────────────────────────────────
async function callCerebras(system_prompt, player_state_json) {
  const response = await fetch('https://api.cerebras.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.CEREBRAS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama3.1-8b',
      messages: [
        { role: 'system', content: system_prompt },
        { role: 'user', content: JSON.stringify(player_state_json) },
      ],
      temperature: 0.85,
      max_tokens: 600,
      response_format: { type: 'json_object' },
    }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Cerebras HTTP ${response.status}: ${err.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.choices[0].message.content;
}

// ── Gemini Flash 2.0 ──────────────────────────────────────────────────────────
async function callGemini(system_prompt, player_state_json) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system_prompt }] },
        contents: [{ parts: [{ text: JSON.stringify(player_state_json) }] }],
        generationConfig: {
          temperature: 0.85,
          maxOutputTokens: 600,
          responseMimeType: 'application/json',
        },
      }),
    }
  );
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini HTTP ${response.status}: ${err.slice(0, 200)}`);
  }
  const data = await response.json();
  if (data.candidates?.[0]?.content) {
    return data.candidates[0].content.parts[0].text;
  }
  throw new Error('Gemini: unexpected response shape');
}

// ── Mistral ───────────────────────────────────────────────────────────────────
async function callMistral(system_prompt, player_state_json) {
  const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'mistral-large-latest',
      messages: [
        { role: 'system', content: system_prompt },
        { role: 'user', content: JSON.stringify(player_state_json) },
      ],
      temperature: 0.85,
      max_tokens: 600,
      response_format: { type: 'json_object' },
    }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Mistral HTTP ${response.status}: ${err.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.choices[0].message.content;
}

// ── Mock model (--dry-run) ────────────────────────────────────────────────────
// Cycles through actions to exercise all v2 code paths during dry-run.
let _mockCounter = 0;
async function callMock(_system_prompt, player_state_json) {
  _mockCounter++;
  const state = player_state_json || {};
  const turn = state.turn || 1;
  const sector_id = state.your_sector?.id || 'energy';
  const capital = state.your_sector?.capital || 0;

  // Determine a valid other sector to target
  const all_sectors = ['energy', 'technology', 'agriculture', 'finance'];
  const others = all_sectors.filter((id) => id !== sector_id);
  const target = others[_mockCounter % others.length];

  // Cycle: invest → negotiate(proposal) → accept_deal → develop → hold → repeat
  const rotation = ['invest', 'negotiate', 'accept_deal', 'develop', 'hold', 'invest'];
  const action = rotation[_mockCounter % rotation.length];

  if (action === 'invest' && capital >= 200) {
    return JSON.stringify({
      action: 'invest',
      target,
      amount: 200,
      message: null,
      deal_proposal: null,
      reasoning: 'MOCK: invest to build supply chain link',
    });
  }

  if (action === 'negotiate') {
    return JSON.stringify({
      action: 'negotiate',
      target,
      amount: null,
      message: `Proposing a joint venture with ${target}.`,
      deal_proposal: {
        type: 'joint_venture',
        investment_amounts: { proposer: 150, target: 150 },
        return_split: 0.5,
        duration_turns: 3,
        deadline_turn: turn + 2,
      },
      reasoning: 'MOCK: submitting structured proposal',
    });
  }

  if (action === 'accept_deal') {
    // Try to accept from any pending proposal; fall back to hold if none
    const pending = state.pending_proposals || [];
    const proposer = pending.length > 0 ? pending[0].proposal.proposer : null;
    if (proposer) {
      return JSON.stringify({
        action: 'accept_deal',
        target: proposer,
        amount: null,
        message: null,
        deal_proposal: null,
        reasoning: 'MOCK: accepting pending proposal',
      });
    }
  }

  if (action === 'develop' && capital >= 500) {
    return JSON.stringify({
      action: 'develop',
      target: null,
      amount: 500,
      message: null,
      deal_proposal: null,
      reasoning: 'MOCK: expanding production capacity',
    });
  }

  // Default: hold
  return JSON.stringify({
    action: 'hold',
    target: null,
    amount: null,
    message: null,
    deal_proposal: null,
    reasoning: 'MOCK: insufficient capital or default hold',
  });
}

// ── Response parser ───────────────────────────────────────────────────────────
const VALID_ACTIONS = ['develop', 'invest', 'negotiate', 'accept_deal', 'hold', 'undercut', 'lobby'];

function parseModelResponse(raw_text) {
  try {
    const cleaned = raw_text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!VALID_ACTIONS.includes(parsed.action)) {
      console.warn(`[models] Invalid action "${parsed.action}" → defaulting to hold`);
      parsed.action = 'hold';
    }
    // Ensure all required keys exist
    parsed.target = parsed.target || null;
    parsed.amount = parsed.amount != null ? parseInt(parsed.amount, 10) : null;
    parsed.message = parsed.message || null;
    parsed.deal_proposal = parsed.deal_proposal || null;
    parsed.reasoning = parsed.reasoning || '';
    parsed.deepseek_reasoning = parsed.deepseek_reasoning || null;
    return parsed;
  } catch (e) {
    return null;
  }
}

// ── Model size classification ─────────────────────────────────────────────────
const MODEL_SIZES = {
  'groq':          'small',    // llama-3.1-8b-instant
  'groq-deepseek': 'large',    // qwen3-32b (reasoning)
  'mistral':       'large',    // mistral-large
  'cerebras':      'large',    // llama-3.3-70b
  'gemini':        'large',    // gemini-2.0-flash
  'mock':          'small',
};

// ── Dispatcher ────────────────────────────────────────────────────────────────
const MODEL_CALLERS = {
  groq:            callGroq,
  'groq-deepseek': callGroqDeepSeek,
  gemini:          callGemini,
  mistral:         callMistral,
  cerebras:        callCerebras,
  mock:            callMock,
};

async function callModel(model_id, system_prompt, player_state) {
  const caller = MODEL_CALLERS[model_id];
  if (!caller) throw new Error(`Unknown model_id: ${model_id}`);
  const raw = await caller(system_prompt, player_state);
  return raw;
}

async function callModelWithFallback(model_id, system_prompt, player_state) {
  for (let attempt = 0; attempt <= config.MAX_RETRIES; attempt++) {
    try {
      const raw = await Promise.race([
        callModel(model_id, system_prompt, player_state),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), config.API_TIMEOUT_MS)
        ),
      ]);
      const parsed = parseModelResponse(raw);
      if (parsed) return parsed;
      console.error(`[models] ${model_id} attempt ${attempt}: failed to parse response`);
    } catch (e) {
      console.error(`[models] ${model_id} attempt ${attempt} failed: ${e.message}`);
    }
    // Wait between retries so tokens from the failed attempt clear the sliding
    // window before we try again. Skipped after the final attempt.
    if (attempt < config.MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, config.RETRY_DELAY_MS));
    }
  }
  // Final fallback
  return {
    action: 'hold',
    target: null,
    amount: null,
    message: null,
    deal_proposal: null,
    reasoning: 'FALLBACK: model failed to respond',
  };
}

module.exports = { callModelWithFallback, parseModelResponse, MODEL_SIZES };
