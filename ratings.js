'use strict';

const fs   = require('fs');
const path = require('path');

const RATINGS_FILE = path.join(__dirname, 'ratings.json');
const K_FACTOR     = 32;   // standard Elo K-factor
const BASE_ELO     = 1000;

// ── Load / Save ───────────────────────────────────────────────────────────────
function loadRatings() {
  try {
    if (fs.existsSync(RATINGS_FILE)) {
      return JSON.parse(fs.readFileSync(RATINGS_FILE, 'utf8'));
    }
  } catch (_) {}
  return { models: {}, games_played: 0, last_updated: null };
}

function saveRatings(data) {
  data.last_updated = new Date().toISOString();
  fs.writeFileSync(RATINGS_FILE, JSON.stringify(data, null, 2));
}

// ── Elo update (Bradley-Terry pairwise) ──────────────────────────────────────
// score_a: actual result for A (1=win, 0.5=draw, 0=loss)
function eloUpdate(rating_a, rating_b, score_a, k) {
  const expected_a = 1 / (1 + Math.pow(10, (rating_b - rating_a) / 400));
  const delta      = k * (score_a - expected_a);
  return { new_a: Math.round((rating_a + delta) * 10) / 10, delta };
}

// ── Ensure model entry exists ─────────────────────────────────────────────────
function ensureModel(ratings, model_id) {
  if (!ratings.models[model_id]) {
    ratings.models[model_id] = {
      model_id,
      games: 0,
      // Three Elo dimensions
      strategic_elo:   BASE_ELO,  // economic performance (composite score rank)
      diplomatic_elo:  BASE_ELO,  // cooperation success (deals executed, trust)
      adaptation_elo:  BASE_ELO,  // improvement across games (score vs own baseline)
      // History for confidence intervals
      strategic_history:  [],
      diplomatic_history: [],
      adaptation_history: [],
      // Raw stats
      wins: 0, losses: 0, draws: 0,
      total_trust_score: 0,
      total_deals: 0,
      best_score: null,
      worst_score: null,
    };
  }
  return ratings.models[model_id];
}

// ── Confidence interval (simple bootstrap approximation) ─────────────────────
// Returns ±margin at 95% confidence level. Requires ≥5 data points.
function confidenceInterval(history) {
  if (history.length < 5) return null;
  const n    = history.length;
  const mean = history.reduce((s, v) => s + v, 0) / n;
  const variance = history.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const se   = Math.sqrt(variance / n);
  const margin = Math.round(1.96 * se * 10) / 10;  // 95% CI
  return { mean: Math.round(mean * 10) / 10, margin, n };
}

// ── Record game result ────────────────────────────────────────────────────────
// final_scores: { [model_id]: { score, trust_score, deals_executed, player_type } }
// Previous game scores for adaptation_elo: ratings.models[model].best_score
function recordGame(final_scores, seed, prompt_variant_id, prompt_variant_name) {
  const ratings = loadRatings();
  ratings.games_played++;

  if (!ratings.variants) ratings.variants = {};
  const vkey = `variant_${prompt_variant_id ?? 0}`;
  if (!ratings.variants[vkey]) {
    ratings.variants[vkey] = {
      name: prompt_variant_name || 'baseline',
      games: 0,
      model_scores: {},  // { [model_id]: [scores] } for sensitivity analysis
    };
  }
  ratings.variants[vkey].games++;

  const entries = Object.entries(final_scores)
    .map(([model_id, data]) => ({ model_id, ...data }))
    .sort((a, b) => b.score - a.score);

  const n = entries.length;

  // Ensure all models exist
  entries.forEach(({ model_id }) => ensureModel(ratings, model_id));

  // Pairwise Bradley-Terry updates for all three dimensions
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = entries[i];
      const b = entries[j];
      const ma = ratings.models[a.model_id];
      const mb = ratings.models[b.model_id];

      // 1. Strategic Elo — based on composite score rank
      const score_a_strat = a.score > b.score ? 1 : a.score === b.score ? 0.5 : 0;
      const { new_a: new_strat_a } = eloUpdate(ma.strategic_elo, mb.strategic_elo, score_a_strat, K_FACTOR);
      const { new_a: new_strat_b } = eloUpdate(mb.strategic_elo, ma.strategic_elo, 1 - score_a_strat, K_FACTOR);
      ma.strategic_elo = new_strat_a;
      mb.strategic_elo = new_strat_b;

      // 2. Diplomatic Elo — based on trust_score
      const score_a_dipl = a.trust_score > b.trust_score ? 1 : a.trust_score === b.trust_score ? 0.5 : 0;
      const { new_a: new_dipl_a } = eloUpdate(ma.diplomatic_elo, mb.diplomatic_elo, score_a_dipl, K_FACTOR);
      const { new_a: new_dipl_b } = eloUpdate(mb.diplomatic_elo, ma.diplomatic_elo, 1 - score_a_dipl, K_FACTOR);
      ma.diplomatic_elo = new_dipl_a;
      mb.diplomatic_elo = new_dipl_b;

      // 3. Adaptation Elo — score vs own personal best (improvement)
      const a_improved = ma.best_score == null || a.score > ma.best_score;
      const b_improved = mb.best_score == null || b.score > mb.best_score;
      const score_a_adap = a_improved && !b_improved ? 1
        : !a_improved && b_improved ? 0 : 0.5;
      const { new_a: new_adap_a } = eloUpdate(ma.adaptation_elo, mb.adaptation_elo, score_a_adap, K_FACTOR);
      const { new_a: new_adap_b } = eloUpdate(mb.adaptation_elo, ma.adaptation_elo, 1 - score_a_adap, K_FACTOR);
      ma.adaptation_elo = new_adap_a;
      mb.adaptation_elo = new_adap_b;
    }
  }

  // Update per-model stats and history
  const winner_id = entries[0].model_id;
  entries.forEach(({ model_id, score, trust_score, deals_executed }, rank) => {
    const m = ratings.models[model_id];
    m.games++;
    if (rank === 0) m.wins++;
    else if (rank === n - 1) m.losses++;
    else m.draws++;

    m.total_trust_score += trust_score || 0;
    m.total_deals       += deals_executed || 0;

    // Track per-variant scores for sensitivity analysis
    const vdata = ratings.variants?.[vkey];
    if (vdata) {
      if (!vdata.model_scores[model_id]) vdata.model_scores[model_id] = [];
      vdata.model_scores[model_id].push(score);
    }
    if (m.best_score  == null || score > m.best_score)  m.best_score  = score;
    if (m.worst_score == null || score < m.worst_score) m.worst_score = score;

    // Append to history for CI calculation
    m.strategic_history.push(m.strategic_elo);
    m.diplomatic_history.push(m.diplomatic_elo);
    m.adaptation_history.push(m.adaptation_elo);

    // Keep history to last 50 games
    if (m.strategic_history.length  > 50) m.strategic_history.shift();
    if (m.diplomatic_history.length > 50) m.diplomatic_history.shift();
    if (m.adaptation_history.length > 50) m.adaptation_history.shift();
  });

  saveRatings(ratings);
  return { ratings, winner_id };
}

// ── Print leaderboard ─────────────────────────────────────────────────────────
function printLeaderboard() {
  const ratings = loadRatings();
  const models  = Object.values(ratings.models).sort(
    (a, b) => b.strategic_elo - a.strategic_elo
  );

  if (models.length === 0) {
    console.log('[ratings] No games recorded yet.');
    return;
  }

  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║                    ELO LEADERBOARD (Bradley-Terry)              ║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  console.log('║  Model              Strat   Dipl   Adap   W/L/D   Games        ║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  models.forEach((m) => {
    const ci = confidenceInterval(m.strategic_history);
    const ci_str = ci ? `±${ci.margin}` : '(n<5)';
    console.log(
      `║  ${m.model_id.padEnd(16)}` +
      `  ${String(Math.round(m.strategic_elo)).padStart(5)}${ci_str.padStart(6)}` +
      `  ${String(Math.round(m.diplomatic_elo)).padStart(5)}` +
      `  ${String(Math.round(m.adaptation_elo)).padStart(5)}` +
      `  ${m.wins}/${m.losses}/${m.draws}` +
      `  [${m.games}g]`.padStart(6) + '  ║'
    );
  });
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`  Total games recorded: ${ratings.games_played}\n`);
}

// ── Print prompt sensitivity report ──────────────────────────────────────────
function printSensitivityReport() {
  const ratings = loadRatings();
  if (!ratings.variants || Object.keys(ratings.variants).length < 2) {
    console.log('[sensitivity] Need games from ≥2 variants to compare. Run with --prompt-variant=0/1/2.');
    return;
  }

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║           PROMPT SENSITIVITY REPORT                 ║');
  console.log('╠══════════════════════════════════════════════════════╣');

  Object.entries(ratings.variants).forEach(([vkey, vdata]) => {
    console.log(`║  ${vdata.name.padEnd(24)} [${vdata.games} games]`.padEnd(54) + '║');
    Object.entries(vdata.model_scores).forEach(([model_id, scores]) => {
      if (scores.length === 0) return;
      const mean  = Math.round(scores.reduce((s, v) => s + v, 0) / scores.length);
      const ci    = confidenceInterval(scores);
      const ci_str = ci ? `±${ci.margin}` : `(n=${scores.length}<5)`;
      console.log(`║    ${model_id.padEnd(16)} avg:${String(mean).padStart(6)} ${ci_str.padEnd(10)}`.padEnd(54) + '║');
    });
  });

  console.log('╚══════════════════════════════════════════════════════╝\n');
}

module.exports = { recordGame, printLeaderboard, printSensitivityReport, loadRatings, confidenceInterval };
