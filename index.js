require('dotenv').config();
const rng = require('./rng');
const GAME_SEED = rng.initFromEnv();
const express = require('express');
const fs = require('fs');
const path = require('path');

const config = require('./config');
const arbiter = require('./arbiter');
const { drawEvent } = require('./events');
const { callModelWithFallback, MODEL_SIZES } = require('./models');
const { PLAYER_TYPES, getSystemPrompt, getSystemPromptVariant, PROMPT_VARIANTS } = require('./prompts');
const ratings_system = require('./ratings');

const DRY_RUN   = process.argv.includes('--dry-run');
const NO_DELAY  = process.argv.includes('--no-delay');   // skip rate-limit sleeps (tournament mode)
const NO_SERVER = process.argv.includes('--no-server');  // skip Express binding (tournament mode)

let gamePaused = false;

// ── Express setup ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

let eventClients = [];

app.get('/state', (req, res) => {
  res.json(gameState);
});

app.post('/pause', (req, res) => {
  gamePaused = true;
  res.json({ paused: true });
});

app.post('/resume', (req, res) => {
  gamePaused = false;
  res.json({ paused: false });
});

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  eventClients.push(res);
  req.on('close', () => {
    eventClients = eventClients.filter((c) => c !== res);
  });
});

function broadcastTurn(turn_summary) {
  const data = JSON.stringify(turn_summary);
  eventClients.forEach((client) => client.write(`data: ${data}\n\n`));
}

// ── State ─────────────────────────────────────────────────────────────────────
let gameState = arbiter.createInitialState();

function saveState() {
  try {
    fs.writeFileSync(
      path.join(__dirname, 'game_state.json'),
      JSON.stringify(gameState, null, 2)
    );
  } catch (e) {
    console.error('[state] Failed to save game_state.json:', e.message);
  }
}

function appendLog(entry) {
  try {
    fs.appendFileSync(
      path.join(__dirname, 'game_log.jsonl'),
      JSON.stringify(entry) + '\n'
    );
  } catch (e) {
    console.error('[log] Failed to append game_log.jsonl:', e.message);
  }
}

// ── Sector/model assignment ───────────────────────────────────────────────────
function assignModelsAndTypes() {
  const sector_ids = Object.keys(gameState.sectors);

  let model_pool;
  if (DRY_RUN) {
    model_pool = sector_ids.map(() => 'mock');
  } else {
    const available = [];
    if (process.env.GROQ_API_KEY)     available.push('groq', 'groq-deepseek');
    // if (process.env.GEMINI_API_KEY)   available.push('gemini');  // disabled — billing quota exceeded
    if (process.env.CEREBRAS_API_KEY) available.push('cerebras');
    if (process.env.MISTRAL_API_KEY)  available.push('mistral');

    if (available.length === 0) {
      console.warn('[setup] No API keys found — falling back to dry-run mode');
      model_pool = sector_ids.map(() => 'mock');
    } else {
      model_pool = sector_ids.map((_, i) => available[i % available.length]);
      for (let i = model_pool.length - 1; i > 0; i--) {
        const j = Math.floor(rng.rand() * (i + 1));
        [model_pool[i], model_pool[j]] = [model_pool[j], model_pool[i]];
      }
    }
  }

  const type_pool = [...PLAYER_TYPES].sort(() => rng.rand() - 0.5);

  sector_ids.forEach((id, i) => {
    gameState.sectors[id].owner_model = model_pool[i];
    gameState.sectors[id].player_type = type_pool[i % type_pool.length].id;
  });

  console.log('\n=== SECTOR WAR v2: MODEL ASSIGNMENTS ===');
  sector_ids.forEach((id) => {
    const s = gameState.sectors[id];
    console.log(
      `  ${s.name.padEnd(12)} → model: ${s.owner_model.padEnd(10)}  type: ${s.player_type}` +
      `  dep: ${arbiter.SUPPLY_CHAIN_DEPS[id] || 'none'}`
    );
  });
  console.log('========================================\n');
  arbiter.assignHiddenAgendas(gameState);
  console.log('[setup] Hidden agendas assigned (secret).');
}

// ── Sleep utility ─────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── v2: Expire pending proposals past their deadline ─────────────────────────
function expirePendingProposals(state, turn, turn_events_log) {
  Object.keys(state.pending_proposals || {}).forEach((sector_id) => {
    const before = state.pending_proposals[sector_id].length;
    state.pending_proposals[sector_id] = state.pending_proposals[sector_id].filter((p) => {
      const expired = p.proposal.deadline_turn != null && p.proposal.deadline_turn < turn;
      if (expired && state.sectors[sector_id]) {
        const proposer_name = state.sectors[p.proposal.proposer]?.name || p.proposal.proposer;
        turn_events_log.push(
          `PROPOSAL EXPIRED: ${proposer_name} → ${state.sectors[sector_id].name} [${p.proposal.type}] deadline passed.`
        );
        // v2.2: return escrow deposit without bonus on expiry
        if (p.proposal._escrow_id) {
          arbiter.releaseEscrow(state, p.proposal._escrow_id, false, turn_events_log);
        }
      }
      return !expired;
    });
  });
}

// ── Main game loop ────────────────────────────────────────────────────────────
async function runGame() {
  console.log(`[game] Starting SectorWars v2 — ${config.TOTAL_TURNS} turns${DRY_RUN ? ' (DRY RUN)' : ''}`);

  // Prompt sensitivity variant (--prompt-variant=N, default 0)
  const variant_arg = process.argv.find((a) => a.startsWith('--prompt-variant='));
  const PROMPT_VARIANT_ID = variant_arg ? parseInt(variant_arg.split('=')[1], 10) : 0;
  const variant_info = PROMPT_VARIANTS.find((v) => v.id === PROMPT_VARIANT_ID) || PROMPT_VARIANTS[0];
  console.log(`[prompts] Variant: ${variant_info.id} — ${variant_info.name}: ${variant_info.description}`);

  assignModelsAndTypes();

  for (let turn = 1; turn <= config.TOTAL_TURNS; turn++) {
    while (gamePaused) {
      await sleep(250);
    }

    gameState.turn = turn;
    const turn_events_log = [];
    const actions_taken = {};

    console.log(`\n━━━ TURN ${turn}/${config.TOTAL_TURNS} ━━━`);

    // Save BEFORE API calls for crash recovery
    saveState();

    // a. v2: Depreciate idle capital (applied before any other mechanics)
    arbiter.applyCapitalDepreciation(gameState, turn_events_log);

    // a2. v2.10: Decay return_rate on aging investments
    arbiter.applyInvestmentDecay(gameState, turn_events_log);

    // b. v2: Resolve supply chain (sets input_received flags before revenue calc)
    arbiter.resolveSupplyChain(gameState, turn_events_log);

    // c. Apply unique mechanics (energy tax, tech multiplier)
    arbiter.applyUniqueMechanics(gameState, turn_events_log);

    // d. Apply pending event (t+1 → now); advance t+2 forecast → t+1 slot
    if (gameState.pending_event) {
      const { event, target } = gameState.pending_event;
      const msg = event.apply(gameState, target);
      if (msg) turn_events_log.push(`EVENT: ${msg}`);
      gameState.pending_event = null;
    }
    if (gameState.pending_event_t2) {
      gameState.pending_event = gameState.pending_event_t2;
      gameState.pending_event_t2 = null;
    }

    // e. Revenue + investment dividends
    arbiter.resolveRevenue(gameState, turn_events_log);
    arbiter.resolveInvestmentDividends(gameState);

    // f. Debt costs
    arbiter.applyDebtCosts(gameState, turn_events_log);

    // g. Synergy check
    arbiter.checkSynergies(gameState, turn_events_log);

    // h. v2: Expire proposals past their deadline
    expirePendingProposals(gameState, turn, turn_events_log);

    // h2. v2.9: Negotiation escalation — tax stale proposals, auto-match mutual ones
    const automatch_deals = arbiter.applyNegotiationEscalation(gameState, turn_events_log);
    if (automatch_deals.length > 0) {
      arbiter.updateTrustScores(gameState, {}, automatch_deals, [], turn_events_log);
    }

    // i. Get model actions sequentially (shuffled order to avoid bias).
    // Sequential + 3 s gap keeps all models within the 6 000 TPM free-tier quota;
    // Qwen3-32B think blocks consume ~1 500 tokens alone so parallel calls would
    // exhaust the shared limit every turn.
    const sector_ids = Object.keys(gameState.sectors);
    const shuffled = [...sector_ids].sort(() => rng.rand() - 0.5);

    for (const id of shuffled) {
      const s = gameState.sectors[id];
      const player_state = arbiter.buildPlayerState(id, gameState, actions_taken);
      const model_size = MODEL_SIZES[s.owner_model] || 'large';
      const system_prompt = getSystemPromptVariant(s.name, s.player_type, model_size, PROMPT_VARIANT_ID);
      const action = await callModelWithFallback(s.owner_model, system_prompt, player_state);

      // Clamp invest/develop amounts to available capital
      if (
        (action.action === 'invest' || action.action === 'develop') &&
        action.amount != null
      ) {
        action.amount = Math.min(action.amount, Math.floor(s.capital));
        if (action.amount < 1) {
          console.warn(`[turn ${turn}] ${s.name}: clamped amount to 0 → defaulting to hold`);
          action.action = 'hold';
        }
      }

      console.log(
        `  [${s.name}/${s.owner_model}] → ${action.action}` +
        `${action.target ? ' → ' + action.target : ''}` +
        `${action.amount ? ' (' + action.amount + ')' : ''}` +
        ` | ${action.reasoning?.slice(0, 80) || ''}`
      );
      if (action.deepseek_reasoning) {
        console.log(`  [${s.name}/deepseek_think] ${action.deepseek_reasoning.slice(0, 200)}`);
      }
      actions_taken[id] = action;

      // 6 s cooldown between calls. Qwen3-32B think blocks can reach ~2 500 tokens;
      // at 100 tokens/s refill (6 000 TPM free tier) that needs ~25 s to clear the
      // sliding window. With 4 calls × ~5 s API latency + 3 gaps × 6 s = ~35 s
      // between consecutive Qwen3 turns — safely above the 25 s worst case.
      // Skipped after the last sector in each turn.
      if (!NO_DELAY && id !== shuffled[shuffled.length - 1]) {
        await sleep(6000);
      }
    }

    // j. Resolve all actions simultaneously — returns executed_deals and betrayals
    const { executed_deals, betrayals } = arbiter.resolveActions(
      gameState, actions_taken, turn_events_log
    );

    // k. v2: Update trust scores based on what happened this turn
    arbiter.updateTrustScores(
      gameState, actions_taken, executed_deals, betrayals, turn_events_log
    );

    // l. v2.3: Update episodic memory and opponent profiles for every sector
    Object.keys(gameState.sectors).forEach((id) => {
      arbiter.updateSectorMemory(gameState, id, actions_taken, turn_events_log);
    });

    // l2. v2.3: Compute strategic reflection every 3 turns
    if (turn % 3 === 0) {
      Object.keys(gameState.sectors).forEach((id) => {
        if (gameState.sectors[id].memory) {
          gameState.sectors[id].memory.strategic_reflection =
            arbiter.computeStrategicReflection(gameState, id);
        }
      });
    }

    // v2.5: stagnation tax if all sectors held
    arbiter.applyStagnationTax(gameState, actions_taken, turn_events_log);

    // v2.7: forced investment tax on rounds 3, 6, 9, 12, 15
    arbiter.applyForcedInvestmentTax(gameState, actions_taken, turn_events_log);

    // m. Deal violation check (legacy binding deals)
    arbiter.checkDealViolations(gameState, actions_taken, turn_events_log);

    // m. Bankruptcy check
    arbiter.checkBankruptcy(gameState, turn_events_log);

    // n. Draw next events (v2.5: 2-turn forecast)
    if (Object.keys(gameState.sectors).length > 0) {
      const drawn = drawEvent(gameState);
      const [next_event, forecast_event] = Array.isArray(drawn) ? drawn : [drawn, null];

      if (next_event && next_event.event) {
        gameState.pending_event = next_event;
        turn_events_log.push(
          `UPCOMING (turn ${turn + 1}): "${next_event.event.name}" will trigger next turn.`
        );
      }
      if (forecast_event && forecast_event.event) {
        gameState.pending_event_t2 = forecast_event;
        turn_events_log.push(
          `FORECAST (turn ${turn + 2}): "${forecast_event.event.name}" expected in 2 turns.`
        );
      } else {
        gameState.pending_event_t2 = null;
      }
    }

    // Tick time-limited event counters
    arbiter.tickEventCounters(gameState);
    arbiter.tickSupplyChainCounters(gameState);  // v2.4: track supply_chain_master agenda
    arbiter.clampMarketShares(gameState);
    arbiter.applyRegulatorySscrutiny(gameState, turn_events_log);  // v2.5: cap market dominance

    // Scores
    const scores = arbiter.calculateScores(gameState);

    // Build turn summary (v2: includes trust_scores, supply chain, active_deals)
    const turn_summary = {
      turn,
      total_turns: config.TOTAL_TURNS,
      sectors: Object.fromEntries(
        Object.keys(gameState.sectors).map((id) => {
          const s = gameState.sectors[id];
          const invested_capital = Object.values(s.investments_made).reduce(
            (sum, inv) => sum + inv.amount, 0
          );
          return [
            id,
            {
              name: s.name,
              capital: Math.round(s.capital),
              idle_capital: Math.round(s.capital),
              invested_capital,
              trust_score: s.trust_score,
              supply_chain_connected: s.resources.input_received,
              resources: s.resources,
              debt: s.debt,
              market_share: Math.round(s.market_share * 1000) / 1000,
              last_revenue: s.last_revenue,
              production_capacity: s.production_capacity,
              price_per_unit: s.price_per_unit,
              owner_model: s.owner_model,
              player_type: s.player_type,
              non_aggression_partners: s.non_aggression_partners,
              action: actions_taken[id]?.action || 'unknown',
              deepseek_reasoning: actions_taken[id]?.deepseek_reasoning || null,
              score_components: s._score_components || null,
            },
          ];
        })
      ),
      events: turn_events_log,
      scores,
      bankrupt: gameState.bankrupt_sectors,
      active_synergies: gameState.active_synergies,
      active_deals: gameState.active_deals,
      executed_deals_this_turn: executed_deals,
      forecast_event: gameState.pending_event_t2
        ? { name: gameState.pending_event_t2.event?.name || null }
        : null,
    };

    // Save state
    saveState();

    // Append log
    appendLog(turn_summary);

    // Broadcast to frontend
    broadcastTurn(turn_summary);

    // Print summary to console
    turn_events_log.forEach((e) => console.log('  ' + e));

    // Print trust scores each turn
    const trust_line = Object.keys(gameState.sectors)
      .map((id) => `${gameState.sectors[id].name}: ${gameState.sectors[id].trust_score}`)
      .join(' | ');
    console.log(`  [trust] ${trust_line}`);

    // Wait (skipped with --no-delay for tournament mode)
    if (!NO_DELAY && turn < config.TOTAL_TURNS) {
      await sleep(config.TURN_DELAY_MS);
    }

    if (Object.keys(gameState.sectors).length === 0) {
      console.log('[game] All sectors bankrupt — game over early.');
      break;
    }
  }

  // v2.4: Evaluate hidden agendas — must run before final calculateScores
  const agenda_results = arbiter.evaluateHiddenAgendas(gameState);
  console.log('\n[agendas] Hidden agenda results:');
  Object.entries(agenda_results).forEach(([id, r]) => {
    console.log(`  ${gameState.sectors[id]?.name || id}: ${r.agenda} → +${r.bonus} pts`);
  });

  // Final scores
  const final_scores = arbiter.calculateScores(gameState);
  const sorted = Object.entries(final_scores).sort((a, b) => b[1].score - a[1].score);

  console.log('\n╔══════════════════════════════════════╗');
  console.log('║         FINAL STANDINGS  (v2)        ║');
  console.log('╠══════════════════════════════════════╣');
  sorted.forEach(([id, info], i) => {
    const sc = gameState.sectors[id]?._score_components;
    const agenda = gameState.sectors[id]?.hidden_agenda?.name || '?';
    const agenda_bonus = gameState.sectors[id]?._agenda_score || 0;
    const comp_str = sc
      ? `cap:${sc.capital_score} act:${sc.activity_score} syn:${sc.synergy_score} deals:${sc.deals_score}`
      : '';
    console.log(
      `║ #${i+1} ${info.name.padEnd(12)} score:${String(info.score).padStart(6)} ` +
      `[${comp_str}] +${agenda_bonus} agenda ║`
    );
  });
  console.log('╚══════════════════════════════════════╝\n');

  // Record game in Elo ratings system
  const elo_input = {};
  sorted.forEach(([id, info]) => {
    const s = gameState.sectors[id];
    const deals_executed = (gameState.active_deals || []).filter(
      (d) => d.accepted && (d.sector_from === id || d.sector_to === id)
    ).length;
    // Use model_id as key — multiple sectors can share a model; keep best score
    const existing = elo_input[info.model];
    if (!existing || info.score > existing.score) {
      elo_input[info.model] = {
        score:          info.score,
        trust_score:    s?.trust_score || 500,
        deals_executed,
        player_type:    s?.player_type || 'unknown',
      };
    }
  });

  const { winner_id } = ratings_system.recordGame(elo_input, GAME_SEED, PROMPT_VARIANT_ID, variant_info.name);
  ratings_system.printLeaderboard();
  ratings_system.printSensitivityReport();

  const winner = sorted[0];
  const final_entry = {
    type: 'final',
    turn: gameState.turn,
    scores: final_scores,
    winner: winner ? { id: winner[0], ...winner[1] } : null,
  };
  appendLog(final_entry);
  broadcastTurn({ type: 'final', scores: final_scores, winner: final_entry.winner });

  // Exit cleanly so tournament runner subprocesses don't hang on the Express server
  process.exit(0);
}

// ── Start ─────────────────────────────────────────────────────────────────────
if (NO_SERVER) {
  // Tournament mode — skip Express, run game immediately
  console.log(`[rng] Game seed: ${GAME_SEED} (rerun with --seed=${GAME_SEED} to reproduce)`);
  runGame();
} else {
  const PORT = 3000;
  app.listen(PORT, () => {
    console.log(`[server] Observer dashboard at http://localhost:${PORT}`);
    console.log('[server] Waiting 3s before game starts...\n');
    console.log(`[rng] Game seed: ${GAME_SEED} (rerun with --seed=${GAME_SEED} to reproduce)`);
    setTimeout(runGame, 3000);
  });
}
