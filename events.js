const config = require('./config');
const rng = require('./rng');

const EVENTS = [
  {
    id: 'supply_shock',
    name: 'Energy Supply Shock',
    affects: 'energy',
    weight: 1.5,
    apply: (state) => {
      if (!state.sectors.energy) return;
      state.sectors.energy.production_capacity = Math.floor(
        state.sectors.energy.production_capacity * 0.78
      );
      return `Energy Supply Shock: Energy production capacity cut to ${state.sectors.energy.production_capacity}.`;
    },
  },
  {
    id: 'tech_regulation',
    name: 'Technology Regulation',
    affects: 'technology',
    weight: 1.0,
    apply: (state) => {
      if (!state.sectors.technology) return;
      state.sectors.technology.true_growth_rate -= 0.04;
      state.sectors.technology._regulation_turns_remaining = 3;
      return `Technology Regulation: Tech growth rate reduced for 3 turns.`;
    },
  },
  {
    id: 'drought',
    name: 'Regional Drought',
    affects: 'agriculture',
    weight: 0.8,
    apply: (state) => {
      if (!state.sectors.agriculture) return;
      state.sectors.agriculture.production_capacity = Math.floor(
        state.sectors.agriculture.production_capacity * 0.72
      );
      state.sectors.agriculture._drought_turns_remaining = 2;
      return `Regional Drought: Agriculture production capacity cut to ${state.sectors.agriculture.production_capacity} for 2 turns.`;
    },
  },
  {
    id: 'credit_crunch',
    name: 'Credit Crunch',
    affects: 'all',
    weight: 0.7,
    apply: (state) => {
      Object.keys(state.sectors).forEach((id) => {
        if (id === 'agriculture') return;
        Object.values(state.sectors[id].investments_made).forEach((inv) => {
          inv.return_rate *= 0.5;
        });
      });
      state._credit_crunch_turns_remaining = 2;
      return `Credit Crunch: All investment return rates halved for 2 turns (Agriculture immune).`;
    },
  },
  {
    id: 'economic_boom',
    name: 'Economic Boom',
    affects: 'all',
    weight: 0.9,
    apply: (state) => {
      state._boom_market_multiplier = 1.15;
      state._boom_turns_remaining = 2;
      return `Economic Boom: Market expands 15% for 2 turns!`;
    },
  },
  {
    id: 'innovation_leap',
    name: 'Innovation Breakthrough',
    affects: 'random',
    weight: 0.6,
    apply: (state) => {
      const ids = Object.keys(state.sectors);
      const target = ids[Math.floor(rng.rand() * ids.length)];
      state.sectors[target].production_capacity = Math.floor(
        state.sectors[target].production_capacity * 1.32
      );
      return `Innovation Breakthrough: ${state.sectors[target].name} sector production capacity surged to ${state.sectors[target].production_capacity}!`;
    },
  },
  {
    id: 'energy_spike',
    name: 'Energy Price Spike',
    affects: 'energy',
    weight: 1.0,
    apply: (state) => {
      if (!state.sectors.energy) return;
      state.sectors.energy.price_per_unit = Math.round(
        state.sectors.energy.price_per_unit * 1.35
      );
      state._energy_spike_active = true;
      return `Energy Price Spike: Energy price_per_unit jumped to ${state.sectors.energy.price_per_unit}. All other sectors face revenue pressure next turn.`;
    },
  },
  {
    id: 'infrastructure_bill',
    name: 'Infrastructure Bill',
    affects: 'lobby_winner',
    weight: 0, // only triggered by lobby, never drawn randomly
    apply: (state, target_sector_id) => {
      if (!state.sectors[target_sector_id]) return;
      state.sectors[target_sector_id].capital += 500;
      state.sectors[target_sector_id].idle_capital = state.sectors[target_sector_id].capital;
      return `Infrastructure Bill: ${state.sectors[target_sector_id].name} received +500 capital grant.`;
    },
  },
];

// ── v2.5: drawEvent with 2-turn forecast ─────────────────────────────────────
// Returns array [next_turn_event, forecast_event] — either element can be null.
// Only the first event's cooldown is stamped (it executes next turn).
// Forecast event cooldown is NOT stamped yet — it will be when it becomes next_turn_event.
function drawEvent(state) {
  if (!state.event_cooldowns) state.event_cooldowns = {};

  // Lobby wins bypass cooldown — fire infrastructure_bill immediately
  if (state._pending_lobby_winner) {
    const winner = state._pending_lobby_winner;
    state._pending_lobby_winner = null;
    const ev = EVENTS.find((e) => e.id === 'infrastructure_bill');
    return [{ event: ev, target: winner }, null];
  }

  const current_turn = state.turn;
  const cooldown = config.EVENT_COOLDOWN_TURNS || 4;
  const forecast_count = config.EVENT_FORECAST_TURNS || 2;

  function pickOne(exclude_ids) {
    const candidates = EVENTS.filter((ev) => {
      if (ev.weight <= 0) return false;
      if (exclude_ids.includes(ev.id)) return false;
      const last = state.event_cooldowns[ev.id];
      if (last != null && (current_turn - last) < cooldown) return false;
      return true;
    });
    if (candidates.length === 0) return null;

    const weights = candidates.map((ev) => {
      let w = ev.weight;
      if (ev.id === 'supply_shock' && state.sectors.energy) {
        const noDevTurns = state.sectors.energy._turns_without_develop || 0;
        if (noDevTurns >= 3) w *= 1.5;
      }
      if (ev.id === 'tech_regulation' && state.sectors.technology) {
        if (state.sectors.technology.market_share > 0.35) w *= 1.8;
      }
      return w;
    });

    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let r = rng.rand() * totalWeight;
    let selected = candidates[candidates.length - 1];
    for (let i = 0; i < candidates.length; i++) {
      r -= weights[i];
      if (r <= 0) { selected = candidates[i]; break; }
    }
    return selected;
  }

  const drawn = [];
  const used_ids = [];

  for (let i = 0; i < forecast_count; i++) {
    const selected = pickOne(used_ids);
    if (!selected) { drawn.push(null); continue; }
    // Only stamp cooldown for the FIRST event (the one executing next turn)
    if (i === 0) state.event_cooldowns[selected.id] = current_turn;
    used_ids.push(selected.id);
    drawn.push({ event: selected, target: null });
  }

  return drawn;  // [next_turn_event, forecast_event] — either can be null
}

module.exports = { EVENTS, drawEvent };
