const config = require('./config');
const rng = require('./rng');

// ── v2: Supply chain dependency map ──────────────────────────────────────────
// Each sector needs inputs from the sector it depends on.
// Energy → Technology → Finance → Agriculture → Energy (circular)
const SUPPLY_CHAIN_DEPS = {
  technology: 'energy',     // Technology needs Energy input
  finance: 'technology',    // Finance needs Technology input
  agriculture: 'finance',   // Agriculture needs Finance input
  energy: 'agriculture',    // Energy needs Agriculture input
};

// ── Initial sector definitions ────────────────────────────────────────────────
const INITIAL_SECTORS = {
  energy: {
    name: 'Energy',
    owner_model: null,
    player_type: null,
    capital: 1200,
    idle_capital: 1200,        // v2: tracked separately from invested capital
    debt: 150,
    production_capacity: 80,
    price_per_unit: 15,
    market_share: 0.26,
    true_growth_rate: 1.055,
    volatility: 0.22,
    active_synergies: [],
    pending_lobby: false,
    investments_made: {},
    investments_received: {},
    last_revenue: 0,
    consecutive_negative_turns: 0,
    _turns_without_develop: 0,
    // v2 fields
    trust_score: 500,          // reputation ledger (0–1000)
    non_aggression_partners: [], // sectors with active NAP
    resources: {
      primary_output: 'energy_units',
      input_source: 'agriculture',
      input_received: false,   // updated each turn by resolveSupplyChain
    },
    memory: {
      episodic_log: [],
      opponent_profiles: {},
      strategic_reflection: null,
    },
  },
  technology: {
    name: 'Technology',
    owner_model: null,
    player_type: null,
    capital: 800,
    idle_capital: 800,
    debt: 0,
    production_capacity: 55,
    price_per_unit: 30,
    market_share: 0.22,
    true_growth_rate: 1.092,
    volatility: 0.26,
    active_synergies: [],
    pending_lobby: false,
    investments_made: {},
    investments_received: {},
    last_revenue: 0,
    consecutive_negative_turns: 0,
    _turns_without_develop: 0,
    trust_score: 500,
    non_aggression_partners: [],
    resources: {
      primary_output: 'tech_units',
      input_source: 'energy',
      input_received: false,
    },
    memory: {
      episodic_log: [],
      opponent_profiles: {},
      strategic_reflection: null,
    },
  },
  agriculture: {
    name: 'Agriculture',
    owner_model: null,
    player_type: null,
    capital: 1100,
    idle_capital: 1100,
    debt: 0,
    production_capacity: 95,
    price_per_unit: 9,
    market_share: 0.28,
    true_growth_rate: 1.036,
    volatility: 0.07,
    active_synergies: [],
    pending_lobby: false,
    investments_made: {},
    investments_received: {},
    last_revenue: 0,
    consecutive_negative_turns: 0,
    _turns_without_develop: 0,
    trust_score: 500,
    non_aggression_partners: [],
    resources: {
      primary_output: 'agricultural_output',
      input_source: 'finance',
      input_received: false,
    },
    memory: {
      episodic_log: [],
      opponent_profiles: {},
      strategic_reflection: null,
    },
  },
  finance: {
    name: 'Finance',
    owner_model: null,
    player_type: null,
    capital: 1500,
    idle_capital: 1500,
    debt: 0,
    production_capacity: 0,
    price_per_unit: 0,
    market_share: 0.24,
    true_growth_rate: 1.065,
    volatility: 0.13,
    active_synergies: [],
    pending_lobby: false,
    investments_made: {},
    investments_received: {},
    last_revenue: 0,
    consecutive_negative_turns: 0,
    _turns_without_develop: 0,
    trust_score: 500,
    non_aggression_partners: [],
    resources: {
      primary_output: 'financial_services',
      input_source: 'technology',
      input_received: false,
    },
    memory: {
      episodic_log: [],
      opponent_profiles: {},
      strategic_reflection: null,
    },
  },
};

// ── v2.4: Hidden agendas — asymmetric win conditions ─────────────────────────
const HIDDEN_AGENDAS = [
  {
    id: 'market_dominator',
    name: 'Market Dominator',
    description: 'Achieve the highest market_share among all active sectors at game end.',
    evaluate: (sector, state, sector_id) => {
      const shares = Object.entries(state.sectors).map(([id, s]) => ({ id, share: s.market_share }));
      const max_share = Math.max(...shares.map(s => s.share));
      return sector.market_share >= max_share ? 800 : 0;
    },
  },
  {
    id: 'deal_maker',
    name: 'Deal Maker',
    description: 'Execute 3 or more deals (any type) during the game.',
    evaluate: (sector, state, sector_id) => {
      const count = state.active_deals.filter(
        d => d.accepted && (d.sector_from === sector_id || d.sector_to === sector_id)
      ).length;
      if (count >= 5) return 1000;
      if (count >= 3) return 600;
      return 0;
    },
  },
  {
    id: 'trust_pillar',
    name: 'Trust Pillar',
    description: 'End the game with trust_score above 750.',
    evaluate: (sector, state, sector_id) => {
      if (sector.trust_score >= 900) return 1000;
      if (sector.trust_score >= 750) return 600;
      return 0;
    },
  },
  {
    id: 'supply_chain_master',
    name: 'Supply Chain Master',
    description: 'Maintain supply chain connection for 10 or more turns.',
    evaluate: (sector, state, sector_id) => {
      const turns = sector._supply_connected_turns || 0;
      if (turns >= 13) return 1000;
      if (turns >= 10) return 700;
      if (turns >= 7)  return 300;
      return 0;
    },
  },
  {
    id: 'capital_grower',
    name: 'Capital Grower',
    description: 'End the game with capital at least 2× your starting capital.',
    evaluate: (sector, state, sector_id) => {
      const start = sector._starting_capital || 1000;
      const ratio = sector.capital / start;
      if (ratio >= 3.0) return 1000;
      if (ratio >= 2.0) return 700;
      if (ratio >= 1.5) return 300;
      return 0;
    },
  },
  {
    id: 'synergy_builder',
    name: 'Synergy Builder',
    description: 'Activate 2 or more synergies (mutual investments) by game end.',
    evaluate: (sector, state, sector_id) => {
      return state.active_synergies.length >= 2 ? 800 : 0;
    },
  },
];

function createInitialState() {
  return {
    turn: 0,
    sectors: JSON.parse(JSON.stringify(INITIAL_SECTORS)),
    active_synergies: [],
    _finance_amplifier: 1.35,
    _credit_crunch_turns_remaining: 0,
    _boom_market_multiplier: 1.0,
    _boom_turns_remaining: 0,
    _energy_spike_active: false,
    _finance_max_loss_per_turn: null,
    _pending_lobby_winner: null,
    pending_event: null,
    message_queues: { energy: [], technology: [], agriculture: [], finance: [] },
    active_deals: [],
    turn_revenue_negatives: [],
    bankrupt_sectors: [],
    log: [],
    // v2 additions
    event_cooldowns: {},       // { [event_id]: last_turn_triggered }
    pending_proposals: {       // structured proposals awaiting a sector's response
      energy: [], technology: [], agriculture: [], finance: [],
    },
    escrow: {},                // v2.2: { [escrow_id]: { sector_id, amount, proposal_ref } }
    hidden_agenda_scores: {},  // v2.4: filled at game end by evaluateHiddenAgendas
  };
}

// ── v2: Capital depreciation ──────────────────────────────────────────────────
// Idle (liquid) capital loses 5% every turn — eliminates HOLD as dominant strategy.
function applyCapitalDepreciation(state, turn_events_log) {
  Object.keys(state.sectors).forEach((id) => {
    const s = state.sectors[id];
    const depreciation = Math.round(s.capital * config.IDLE_CAPITAL_DEPRECIATION_RATE);
    s.capital -= depreciation;
    s.idle_capital = s.capital;
    turn_events_log.push(
      `${s.name}: idle capital -${depreciation} (5% depreciation). Remaining: ${Math.round(s.capital)}.`
    );
  });
}

// ── v2: Supply chain resolution ───────────────────────────────────────────────
// Determines whether each sector has a trade link to its input dependency.
// Called BEFORE resolveRevenue so the penalty can be applied in calculateRevenue.
function resolveSupplyChain(state, turn_events_log) {
  const s = state.sectors;
  Object.keys(s).forEach((id) => {
    const dep_id = SUPPLY_CHAIN_DEPS[id];
    if (!dep_id || !s[dep_id]) {
      s[id].resources.input_received = true; // dependency absent — no penalty
      return;
    }
    // Trade link exists when either party has invested in the other
    const has_connection =
      (s[id].investments_made[dep_id] && s[id].investments_made[dep_id].amount > 0) ||
      (s[dep_id].investments_made[id] && s[dep_id].investments_made[id].amount > 0);

    s[id].resources.input_received = has_connection;

    if (!has_connection) {
      turn_events_log.push(
        `SUPPLY CHAIN: ${s[id].name} has no trade link with ${s[dep_id].name} ` +
        `— self-producing inputs at 3× cost (40% revenue penalty).`
      );
    }
  });
}

function getSynergyMultiplier(sectors, investor_id, target_id) {
  const inv_forward = sectors[investor_id]?.investments_made?.[target_id];
  const inv_back    = sectors[target_id]?.investments_made?.[investor_id];
  if (!inv_forward || !inv_back || inv_back.amount <= 0) return 1.0;
  const min_mutual = Math.min(inv_forward.amount, inv_back.amount);
  const tiers = config.SYNERGY_RETURN_TIERS || [
    { min_mutual: 500, multiplier: 3.0 },
    { min_mutual: 300, multiplier: 2.0 },
    { min_mutual: 100, multiplier: 1.5 },
  ];
  for (const tier of tiers) {
    if (min_mutual >= tier.min_mutual) return tier.multiplier;
  }
  return 1.0;
}

function calculateRevenue(sector_id, sector, state) {
  const amplifier = state._finance_amplifier || 1.35;

  // v2: supply chain multiplier
  const supply_multiplier = sector.resources.input_received ? 1.0
    : (config.SUPPLY_CHAIN_SELF_PRODUCE_REVENUE_MULTIPLIER || 0.6);

  if (sector_id === 'finance') {
    const fees = sector.market_share * config.MARKET_SIZE * 0.012 * supply_multiplier;
    const dividends = Object.entries(sector.investments_made).reduce(
      (sum, [target_id, inv]) => {
        const syn = getSynergyMultiplier(state.sectors, sector_id, target_id);
        return sum + inv.amount * inv.return_rate * amplifier * syn;
      },
      0
    );
    return fees + dividends;
  }

  const shock = (rng.rand() * 2 - 1) * sector.volatility;
  const effective_growth = sector.true_growth_rate + shock;
  const marketMult = state._boom_market_multiplier || 1.0;
  const base = sector.price_per_unit * sector.production_capacity * sector.market_share;
  let revenue = base * effective_growth * marketMult * supply_multiplier;

  // v2.1: dividend income includes superlinear synergy multiplier for mutual investments
  const dividends_out = Object.entries(sector.investments_made).reduce(
    (sum, [target_id, inv]) => {
      const syn = getSynergyMultiplier(state.sectors, sector_id, target_id);
      return sum + inv.amount * inv.return_rate * syn;
    },
    0
  );

  return revenue + dividends_out;
}
// Pay dividends from invested-in sectors to investor sectors.
// v2.1: applies superlinear synergy multiplier for mutual investments.
function resolveInvestmentDividends(state) {
  const sectors = state.sectors;
  Object.keys(sectors).forEach((investor_id) => {
    const investor = sectors[investor_id];
    Object.keys(investor.investments_made).forEach((target_id) => {
      const inv = investor.investments_made[target_id];
      const amplifier = investor_id === 'finance' ? (state._finance_amplifier || 1.35) : 1;
      const syn = getSynergyMultiplier(sectors, investor_id, target_id);
      inv.last_dividend = Math.round(inv.amount * inv.return_rate * amplifier * syn);
    });
  });
}

// ── Unique sector mechanics ───────────────────────────────────────────────────
function applyUniqueMechanics(state, turn_events_log) {
  const s = state.sectors;

  // Energy Tax: if energy price > 16, other sectors pay 5% revenue
  if (s.energy && s.energy.price_per_unit > 16) {
    Object.keys(s).forEach((id) => {
      if (id === 'energy') return;
      const tax = Math.round(s[id].last_revenue * 0.05);
      s[id].capital -= tax;
      s.energy.capital += tax;
      turn_events_log.push(
        `Energy Tax: ${s[id].name} paid ${tax} to Energy (price=${s.energy.price_per_unit}).`
      );
    });
  }

  // Technology Efficiency Multiplier: sectors with >= 300 invested in tech get capacity boost
  if (s.technology) {
    Object.keys(s).forEach((id) => {
      if (id === 'technology') return;
      const inv = s[id].investments_made.technology;
      if (inv && inv.amount >= 300) {
        s[id].production_capacity = Math.round(s[id].production_capacity * 1.08);
        turn_events_log.push(
          `Tech Efficiency: ${s[id].name} production capacity boosted to ${s[id].production_capacity}.`
        );
      }
    });
  }
}

function applyAgricultureFloor(sector, new_revenue, prev_revenue) {
  const floor = prev_revenue * 0.80;
  if (new_revenue < floor && prev_revenue > 0) {
    return floor;
  }
  return new_revenue;
}

// ── Market share utilities ────────────────────────────────────────────────────
function renormalizeMarketShares(state) {
  const ids = Object.keys(state.sectors);
  const total = ids.reduce((sum, id) => sum + state.sectors[id].market_share, 0);
  if (Math.abs(total - 1.0) > 0.001) {
    ids.forEach((id) => {
      state.sectors[id].market_share /= total;
    });
  }
}

function clampMarketShares(state) {
  const ids = Object.keys(state.sectors);
  ids.forEach((id) => {
    state.sectors[id].market_share = Math.max(
      0.05,
      Math.min(0.70, state.sectors[id].market_share)
    );
  });
  renormalizeMarketShares(state);
}

// ── Synergy detection ─────────────────────────────────────────────────────────
function checkSynergies(state, turn_events_log) {
  const s = state.sectors;

  function mutualInvest(a, b) {
    return (
      s[a] &&
      s[b] &&
      s[a].investments_made[b] &&
      s[a].investments_made[b].amount >= 300 &&
      s[b].investments_made[a] &&
      s[b].investments_made[a].amount >= 300
    );
  }

  if (mutualInvest('energy', 'technology') && !state.active_synergies.includes('green_tech')) {
    state.active_synergies.push('green_tech');
    s.energy.true_growth_rate += 0.012;
    s.technology.true_growth_rate += 0.012;
    turn_events_log.push('SYNERGY: Green Tech activated — Energy & Technology growth rates boosted!');
  }

  if (mutualInvest('technology', 'finance') && !state.active_synergies.includes('fintech_boom')) {
    state.active_synergies.push('fintech_boom');
    state._finance_amplifier = 1.45;
    turn_events_log.push('SYNERGY: Fintech Boom activated — Finance investment amplifier increased to 1.45!');
  }

  if (mutualInvest('agriculture', 'energy') && !state.active_synergies.includes('biofuel')) {
    state.active_synergies.push('biofuel');
    s.energy.volatility = Math.max(0.05, s.energy.volatility * 0.5);
    turn_events_log.push('SYNERGY: Biofuel activated — Energy volatility halved!');
  }

  if (mutualInvest('finance', 'agriculture') && !state.active_synergies.includes('stable_dividend')) {
    state.active_synergies.push('stable_dividend');
    state._finance_max_loss_per_turn = 0.10;
    turn_events_log.push('SYNERGY: Stable Dividend activated — Finance gains downside protection (max 10% loss/turn)!');
  }
}

// ── v2.2: Escrow deposit management ──────────────────────────────────────────
function lockEscrow(state, proposer_id, proposal_amount, proposal_ref) {
  if (!proposal_amount || proposal_amount <= 0) return null;
  const deposit = Math.round(proposal_amount * (config.ESCROW_DEPOSIT_RATE || 0.20));
  if (deposit <= 0) return null;
  const s = state.sectors[proposer_id];
  if (!s || s.capital < deposit) return null;

  const escrow_id = `${proposer_id}_${state.turn}_${Date.now()}`;
  s.capital -= deposit;
  s.idle_capital = s.capital;
  if (!state.escrow) state.escrow = {};
  state.escrow[escrow_id] = { sector_id: proposer_id, amount: deposit, proposal_ref };
  return escrow_id;
}

function releaseEscrow(state, escrow_id, with_bonus, turn_events_log) {
  if (!state.escrow || !state.escrow[escrow_id]) return;
  const entry = state.escrow[escrow_id];
  const s = state.sectors[entry.sector_id];
  if (!s) { delete state.escrow[escrow_id]; return; }

  const bonus_rate = with_bonus ? (config.ESCROW_COOPERATION_BONUS_RATE || 0.20) : 0;
  const returned = Math.round(entry.amount * (1 + bonus_rate));
  s.capital += returned;
  s.idle_capital = s.capital;

  const msg = with_bonus
    ? `ESCROW: ${s.name} received back ${returned} (deposit ${entry.amount} + ${Math.round(entry.amount * bonus_rate)} cooperation bonus).`
    : `ESCROW: ${s.name} received back ${entry.amount} (proposal expired, no bonus).`;
  turn_events_log.push(msg);
  delete state.escrow[escrow_id];
}

// ── v2: Structured proposal validation ───────────────────────────────────────
const VALID_PROPOSAL_TYPES = ['trade_pact', 'non_aggression', 'joint_venture'];

function validateProposal(state, proposal, proposer_id) {
  const errors = [];
  const s = state.sectors;

  if (!proposal || typeof proposal !== 'object') {
    return { valid: false, errors: ['deal_proposal must be an object'] };
  }
  if (!VALID_PROPOSAL_TYPES.includes(proposal.type)) {
    errors.push(`invalid type "${proposal.type}" — must be trade_pact, non_aggression, or joint_venture`);
  }
  if (!s[proposal.target]) {
    errors.push(`invalid or bankrupt target "${proposal.target}"`);
  }
  if (proposal.deadline_turn != null && proposal.deadline_turn <= state.turn) {
    errors.push(`deadline_turn ${proposal.deadline_turn} is not in the future (current turn: ${state.turn})`);
  }
  const prop_amount = (proposal.investment_amounts && proposal.investment_amounts.proposer) || 0;
  if (prop_amount > 0 && s[proposer_id] && s[proposer_id].capital < prop_amount) {
    errors.push(
      `proposer lacks capital for their share (needs ${prop_amount}, has ${Math.round(s[proposer_id].capital)})`
    );
  }

  return { valid: errors.length === 0, errors };
}

// ── v2: Deal execution (accept = execute) ─────────────────────────────────────
// When a target accepts a structured proposal, the arbiter auto-executes all terms.
function executeDeal(state, proposal, turn_events_log, executed_deals) {
  const s = state.sectors;
  const { type, proposer, target, investment_amounts, duration_turns } = proposal;

  if (!s[proposer] || !s[target]) {
    turn_events_log.push(`DEAL: execution skipped — a sector no longer exists.`);
    return;
  }

  const prop_amount = (investment_amounts && investment_amounts.proposer) || 0;
  const tgt_amount = (investment_amounts && investment_amounts.target) || 0;

  // Transfer proposer → target investment
  if (prop_amount > 0) {
    const actual = Math.min(prop_amount, Math.floor(s[proposer].capital));
    if (actual > 0) {
      s[proposer].capital -= actual;
      s[proposer].idle_capital = s[proposer].capital;
      if (s[proposer].investments_made[target]) {
        s[proposer].investments_made[target].amount += actual;
      } else {
        s[proposer].investments_made[target] = {
          amount: actual,
          return_rate: config.INVESTMENT_BASE_RETURN,
          last_dividend: 0,
          _turns_held: 0,
        };
      }
      if (s[target].investments_received[proposer]) {
        s[target].investments_received[proposer].amount += actual;
      } else {
        s[target].investments_received[proposer] = { amount: actual };
      }
    }
  }

  // Transfer target → proposer investment
  if (tgt_amount > 0) {
    const actual = Math.min(tgt_amount, Math.floor(s[target].capital));
    if (actual > 0) {
      s[target].capital -= actual;
      s[target].idle_capital = s[target].capital;
      if (s[target].investments_made[proposer]) {
        s[target].investments_made[proposer].amount += actual;
      } else {
        s[target].investments_made[proposer] = {
          amount: actual,
          return_rate: config.INVESTMENT_BASE_RETURN,
          last_dividend: 0,
          _turns_held: 0,
        };
      }
      if (s[proposer].investments_received[target]) {
        s[proposer].investments_received[target].amount += actual;
      } else {
        s[proposer].investments_received[target] = { amount: actual };
      }
    }
  }

  // Non-aggression pact (applies to non_aggression and joint_venture types)
  if (type === 'non_aggression' || type === 'joint_venture') {
    if (!s[proposer].non_aggression_partners.includes(target)) {
      s[proposer].non_aggression_partners.push(target);
    }
    if (!s[target].non_aggression_partners.includes(proposer)) {
      s[target].non_aggression_partners.push(proposer);
    }
  }

  // Register in active_deals
  state.active_deals.push({
    sector_from: proposer,
    sector_to: target,
    type,
    terms: proposal,
    turn_agreed: state.turn,
    turns_remaining: duration_turns || 3,
    accepted: true,
  });

  const amounts_str = prop_amount || tgt_amount
    ? ` — invested ${prop_amount} / ${tgt_amount}`
    : '';
  turn_events_log.push(
    `DEAL EXECUTED: ${s[proposer].name} ↔ ${s[target].name} [${type}]${amounts_str}. ` +
    `Duration: ${duration_turns || 3} turns.`
  );

  executed_deals.push({ proposer, target, type });

  // v2.2: release escrow with cooperation bonus on deal execution
  if (proposal._escrow_id) {
    releaseEscrow(state, proposal._escrow_id, true, turn_events_log);
  }
}

// ── v2: Trust score updates ───────────────────────────────────────────────────
function updateTrustScores(state, actions, executed_deals, betrayals, turn_events_log) {
  const s = state.sectors;

  // +50 for each side of an executed deal
  executed_deals.forEach(({ proposer, target }) => {
    if (s[proposer]) {
      s[proposer].trust_score = Math.min(
        config.TRUST_SCORE_MAX,
        s[proposer].trust_score + 50
      );
    }
    if (s[target]) {
      s[target].trust_score = Math.min(
        config.TRUST_SCORE_MAX,
        s[target].trust_score + 50
      );
    }
    if (s[proposer] && s[target]) {
      turn_events_log.push(
        `TRUST: ${s[proposer].name} +50 → ${s[proposer].trust_score}, ` +
        `${s[target].name} +50 → ${s[target].trust_score} (deal fulfilled).`
      );
    }
  });

  // +10 for sectors that invested this turn
  Object.keys(actions).forEach((id) => {
    if (!s[id]) return;
    if (actions[id].action === 'invest') {
      s[id].trust_score = Math.min(config.TRUST_SCORE_MAX, s[id].trust_score + 10);
    }
  });

  // Penalties for betrayals
  betrayals.forEach(({ sector_id, reason, victim }) => {
    if (!s[sector_id]) return;
    const penalty = reason === 'attacked_after_nap' ? 150 : 100;
    s[sector_id].trust_score = Math.max(config.TRUST_SCORE_MIN, s[sector_id].trust_score - penalty);
    const victim_name = (victim && s[victim]) ? s[victim].name : victim;
    turn_events_log.push(
      `TRUST: ${s[sector_id].name} -${penalty} (${reason} against ${victim_name}). ` +
      `Score now: ${s[sector_id].trust_score}.`
    );
  });
}

// ── Action resolution ─────────────────────────────────────────────────────────
// Returns { executed_deals, betrayals } for trust score processing.
function resolveActions(state, actions, turn_events_log) {
  const s = state.sectors;
  const ids = Object.keys(s);
  const executed_deals = [];
  const betrayals = [];

  // 1. DEVELOP
  ids.forEach((id) => {
    const act = actions[id];
    if (!act || act.action !== 'develop') return;
    const amount = act.amount || 500;
    const spend = Math.max(500, Math.min(amount, s[id].capital));
    if (s[id].capital < 500) {
      turn_events_log.push(`${s[id].name}: wanted to develop but insufficient capital (${Math.round(s[id].capital)}).`);
      return;
    }
    s[id].capital -= spend;
    s[id].idle_capital = s[id].capital;
    s[id].production_capacity = Math.round(s[id].production_capacity * 1.10);
    s[id]._turns_without_develop = 0;
    turn_events_log.push(
      `${s[id].name} DEVELOPED: spent ${spend}, production_capacity now ${s[id].production_capacity}.`
    );
  });

  // 2. INVEST
  ids.forEach((id) => {
    const act = actions[id];
    if (!act || act.action !== 'invest') return;
    const target_id = act.target ? act.target.toLowerCase() : null;
    if (!target_id || !s[target_id] || target_id === id) {
      turn_events_log.push(`${s[id].name}: invest action had invalid target "${act.target}".`);
      return;
    }
    const raw_amount = act.amount || 300;
    const amount = Math.max(1, Math.min(raw_amount, Math.floor(s[id].capital)));
    if (amount < 1) {
      turn_events_log.push(`${s[id].name}: wanted to invest but insufficient capital.`);
      return;
    }
    s[id].capital -= amount;
    s[id].idle_capital = s[id].capital;

    if (s[id].investments_made[target_id]) {
      s[id].investments_made[target_id].amount += amount;
    } else {
      s[id].investments_made[target_id] = {
        amount: amount,
        return_rate: config.INVESTMENT_BASE_RETURN,
        last_dividend: 0,
        _turns_held: 0,
      };
    }
    if (s[target_id].investments_received[id]) {
      s[target_id].investments_received[id].amount += amount;
    } else {
      s[target_id].investments_received[id] = { amount: amount };
    }

    turn_events_log.push(
      `${s[id].name} INVESTED ${amount} in ${s[target_id].name}.`
    );
  });

  // 3. ACCEPT_DEAL (v2: accept = execute)
  // Processes before NEGOTIATE so same-turn proposals can't be immediately self-accepted.
  ids.forEach((id) => {
    const act = actions[id];
    if (!act || act.action !== 'accept_deal') return;
    const proposer_id = act.target ? act.target.toLowerCase() : null;
    if (!proposer_id || !s[proposer_id]) {
      turn_events_log.push(`${s[id].name}: accept_deal had invalid target "${act.target || 'null'}".`);
      return;
    }
    const proposals = state.pending_proposals[id] || [];
    const proposal_idx = proposals.findIndex((p) => p.proposal.proposer === proposer_id);
    if (proposal_idx === -1) {
      turn_events_log.push(
        `${s[id].name}: no pending proposal from ${s[proposer_id].name} to accept.`
      );
      return;
    }
    const { proposal } = proposals[proposal_idx];
    // Re-validate capital availability at execution time
    const { valid, errors } = validateProposal(state, proposal, proposer_id);
    if (!valid) {
      turn_events_log.push(
        `${s[id].name}: deal with ${s[proposer_id].name} cannot execute — ${errors.join(', ')}.`
      );
      state.pending_proposals[id].splice(proposal_idx, 1);
      return;
    }
    executeDeal(state, proposal, turn_events_log, executed_deals);
    state.pending_proposals[id].splice(proposal_idx, 1);
  });

  // 4. UNDERCUT (check NAP violations before applying)
  ids.forEach((id) => {
    const act = actions[id];
    if (!act || act.action !== 'undercut') return;
    if (s[id].production_capacity === 0) {
      turn_events_log.push(`${s[id].name}: Finance cannot undercut.`);
      return;
    }

    // v2: detect NAP violations before executing the undercut
    const nap_partners = (s[id].non_aggression_partners || []).filter((p) => s[p]);
    nap_partners.forEach((partner_id) => {
      betrayals.push({ sector_id: id, reason: 'attacked_after_nap', victim: partner_id });
      s[id].non_aggression_partners = s[id].non_aggression_partners.filter((p) => p !== partner_id);
      if (s[partner_id]) {
        s[partner_id].non_aggression_partners =
          s[partner_id].non_aggression_partners.filter((p) => p !== id);
      }
      turn_events_log.push(
        `NAP VIOLATED: ${s[id].name} undercutted while in peace with ${s[partner_id]?.name || partner_id}!`
      );
    });

    s[id].price_per_unit = Math.round(s[id].price_per_unit * 0.90 * 100) / 100;
    const stolen = 0.04;
    const others = ids.filter((oid) => oid !== id && s[oid]);
    const share_per_other = stolen / others.length;
    s[id].market_share += stolen;
    others.forEach((oid) => {
      s[oid].market_share -= share_per_other;
    });
    clampMarketShares(state);
    turn_events_log.push(
      `${s[id].name} UNDERCUT: price now ${s[id].price_per_unit}, market_share now ${s[id].market_share.toFixed(3)}.`
    );
  });

  // 5. LOBBY
  ids.forEach((id) => {
    const act = actions[id];
    if (!act || act.action !== 'lobby') return;
    if (s[id].capital < config.LOBBY_COST) {
      turn_events_log.push(`${s[id].name}: wanted to lobby but insufficient capital.`);
      return;
    }
    s[id].capital -= config.LOBBY_COST;
    s[id].idle_capital = s[id].capital;
    const success = rng.rand() < config.LOBBY_SUCCESS_RATE;
    if (success) {
      state._pending_lobby_winner = id;
      turn_events_log.push(`${s[id].name} LOBBY: SUCCESS — favorable event queued for next turn.`);
    } else {
      turn_events_log.push(`${s[id].name} LOBBY: failed (unlucky roll).`);
    }
  });

  // 6. NEGOTIATE — deliver message + submit structured proposal to pending queue
  ids.forEach((id) => {
    const act = actions[id];
    if (!act || act.action !== 'negotiate') return;
    const target_id = act.target ? act.target.toLowerCase() : null;
    if (!target_id || !s[target_id]) {
      turn_events_log.push(`${s[id].name}: negotiate had invalid target "${act.target}".`);
      return;
    }

    // Deliver regular message
    const msg = {
      from: id,
      content: act.message || '(no message)',
      turn_sent: state.turn,
    };
    if (!state.message_queues[target_id]) state.message_queues[target_id] = [];
    state.message_queues[target_id].push(msg);

    // Handle structured deal_proposal (v2)
    if (act.deal_proposal && typeof act.deal_proposal === 'object') {
      const proposal = {
        ...act.deal_proposal,
        proposer: id,          // enforce sender as proposer
        target: target_id,     // enforce action target
      };

      const { valid, errors } = validateProposal(state, proposal, id);
      if (!valid) {
        turn_events_log.push(
          `${s[id].name} → ${s[target_id].name}: proposal REJECTED by arbiter (${errors.join('; ')}).`
        );
      } else {
        // v2.2: lock escrow deposit on valid proposal submission
        const prop_commit = proposal.investment_amounts?.proposer || 0;
        const escrow_id = lockEscrow(state, id, prop_commit, proposal);
        if (escrow_id) {
          proposal._escrow_id = escrow_id;
          const deposit_amt = Math.round(prop_commit * (config.ESCROW_DEPOSIT_RATE || 0.20));
          turn_events_log.push(
            `ESCROW: ${s[id].name} locked ${deposit_amt} deposit for proposal → ${s[target_id].name}.`
          );
        }
        if (!state.pending_proposals[target_id]) state.pending_proposals[target_id] = [];
        state.pending_proposals[target_id].push({
          proposal,
          turn_sent: state.turn,
        });
        const amounts = proposal.investment_amounts || {};
        turn_events_log.push(
          `${s[id].name} → ${s[target_id].name}: PROPOSAL [${proposal.type}] ` +
          `amounts={proposer:${amounts.proposer || 0},target:${amounts.target || 0}} ` +
          `deadline=turn${proposal.deadline_turn || '∞'}.`
        );
      }
    } else {
      // Plain message (no structured proposal)
      const msgText = act.message || '(no message)';
      turn_events_log.push(`${s[id].name} → ${s[target_id].name}: "${msgText}"`);
    }
  });

  // 7. HOLD — no interest in v2 (depreciation already applied before actions)
  ids.forEach((id) => {
    const act = actions[id];
    if (!act || act.action !== 'hold') return;
    turn_events_log.push(
      `${s[id].name} HELD: no action (idle capital already depreciated this turn).`
    );
  });

  // Track turns without develop for event weighting
  ids.forEach((id) => {
    const act = actions[id];
    if (!act || act.action === 'develop') return;
    s[id]._turns_without_develop = (s[id]._turns_without_develop || 0) + 1;
  });

  return { executed_deals, betrayals };
}

// ── Deal violation check ──────────────────────────────────────────────────────
function checkDealViolations(state, actions, turn_events_log) {
  const s = state.sectors;
  state.active_deals = state.active_deals.filter((deal) => {
    if (!deal.accepted) {
      deal.turns_remaining--;
      return deal.turns_remaining > 0;
    }
    // Simple violation check: if deal includes "not undercut" and sector undercutted
    const terms = (deal.terms_text || '').toLowerCase();
    const act = actions[deal.sector_from];
    if (terms.includes('undercut') && terms.includes('not') && act && act.action === 'undercut') {
      const penalty = 0.03;
      if (s[deal.sector_from]) {
        s[deal.sector_from].market_share = Math.max(0.05, s[deal.sector_from].market_share - penalty);
        renormalizeMarketShares(state);
        turn_events_log.push(
          `DEAL VIOLATION: ${s[deal.sector_from].name} broke binding deal with ` +
          `${s[deal.sector_to]?.name || deal.sector_to}. Market share -${penalty}.`
        );
      }
      deal.turns_remaining--;
      return deal.turns_remaining > 0;
    }
    deal.turns_remaining--;
    return deal.turns_remaining > 0;
  });
}

// ── Revenue resolution ────────────────────────────────────────────────────────
function resolveRevenue(state, turn_events_log) {
  const s = state.sectors;
  const negatives = [];

  Object.keys(s).forEach((id) => {
    const prev_revenue = s[id].last_revenue || 0;
    let revenue = calculateRevenue(id, s[id], state);

    if (id === 'agriculture' && prev_revenue > 0) {
      const floored = applyAgricultureFloor(s[id], revenue, prev_revenue);
      if (floored > revenue) {
        revenue = floored;
        turn_events_log.push(`Agriculture Essential Floor applied: revenue floored at ${Math.round(revenue)}.`);
      }
    }

    if (id === 'finance' && state._finance_max_loss_per_turn != null && prev_revenue > 0) {
      const min_revenue = prev_revenue * (1 - state._finance_max_loss_per_turn);
      if (revenue < min_revenue) {
        revenue = min_revenue;
        turn_events_log.push(`Finance Stable Dividend protection: revenue floored at ${Math.round(revenue)}.`);
      }
    }

    s[id].last_revenue = Math.round(revenue * 100) / 100;
    s[id].capital += s[id].last_revenue;
    s[id].idle_capital = s[id].capital;

    if (revenue < 0) negatives.push(id);
  });

  // Finance Systemic Risk: if 2+ non-finance sectors had negative revenue
  if (negatives.filter((id) => id !== 'finance').length >= 2) {
    const wipeout = Math.round(s.finance.last_revenue * (1 - 0.45));
    s.finance.capital -= wipeout;
    s.finance.idle_capital = s.finance.capital;
    s.finance.last_revenue = Math.round(s.finance.last_revenue * 0.45);
    turn_events_log.push(
      `SYSTEMIC RISK triggered: Finance revenue wiped to ${s.finance.last_revenue} (${negatives.length} sectors in negative).`
    );
  }

  Object.keys(s).forEach((id) => {
    if (s[id].last_revenue < 0) {
      s[id].consecutive_negative_turns = (s[id].consecutive_negative_turns || 0) + 1;
    } else {
      s[id].consecutive_negative_turns = 0;
    }
  });

  state.turn_revenue_negatives = negatives;
}

// ── Debt costs ────────────────────────────────────────────────────────────────
function applyDebtCosts(state, turn_events_log) {
  Object.keys(state.sectors).forEach((id) => {
    const s = state.sectors[id];
    if (s.debt > 0) {
      const cost = Math.round(s.debt * config.DEBT_INTEREST_RATE * 100) / 100;
      s.capital -= cost;
      s.idle_capital = s.capital;
      turn_events_log.push(`${s.name} debt cost: -${cost} (${s.debt} debt @ ${config.DEBT_INTEREST_RATE * 100}%)`);
    }
  });
}

// ── Tick down time-limited events ─────────────────────────────────────────────
function tickEventCounters(state) {
  if (state._boom_turns_remaining > 0) {
    state._boom_turns_remaining--;
    if (state._boom_turns_remaining === 0) state._boom_market_multiplier = 1.0;
  }
  if (state._credit_crunch_turns_remaining > 0) {
    state._credit_crunch_turns_remaining--;
  }
  state._energy_spike_active = false;

  if (state.sectors.technology && state.sectors.technology._regulation_turns_remaining > 0) {
    state.sectors.technology._regulation_turns_remaining--;
    if (state.sectors.technology._regulation_turns_remaining === 0) {
      state.sectors.technology.true_growth_rate += 0.04;
    }
  }

  if (state.sectors.agriculture && state.sectors.agriculture._drought_turns_remaining > 0) {
    state.sectors.agriculture._drought_turns_remaining--;
  }
}

// ── Bankruptcy check ──────────────────────────────────────────────────────────
function checkBankruptcy(state, turn_events_log) {
  const newly_bankrupt = [];

  Object.keys(state.sectors).forEach((id) => {
    const s = state.sectors[id];
    if (s.consecutive_negative_turns >= 3 || (s.capital - s.debt) < -500) {
      if (s.consecutive_negative_turns >= 3) {
        newly_bankrupt.push(id);
      }
    }
  });

  newly_bankrupt.forEach((id) => {
    const s = state.sectors[id];
    const investors = Object.keys(s.investments_received);
    const lost_summary = investors.map((inv_id) => {
      const inv = state.sectors[inv_id];
      const amount = s.investments_received[id]?.amount || 0;
      if (inv && inv.investments_made[id]) {
        delete inv.investments_made[id];
      }
      return `${inv?.name || inv_id} lost ${amount}`;
    });

    turn_events_log.push(
      `BANKRUPTCY: ${s.name} sector has gone bankrupt! Investors lost: ${lost_summary.join(', ') || 'none'}.`
    );

    const share = s.market_share;
    const remaining = Object.keys(state.sectors).filter((oid) => oid !== id);
    const per_sector = share / remaining.length;
    remaining.forEach((oid) => {
      state.sectors[oid].market_share += per_sector;
    });

    state.bankrupt_sectors.push({ id, name: s.name, turn: state.turn });
    delete state.sectors[id];
    if (state.message_queues[id]) delete state.message_queues[id];
    if (state.pending_proposals[id]) delete state.pending_proposals[id];
  });

  if (newly_bankrupt.length > 0) renormalizeMarketShares(state);
}

// ── Rumor generation ──────────────────────────────────────────────────────────
function generateRumors(state, sector_id) {
  const s = state.sectors;
  const ids = Object.keys(s).filter((id) => id !== sector_id);
  const rumors = [];

  for (let i = 0; i < 2; i++) {
    const target_id = ids[Math.floor(rng.rand() * ids.length)];
    const target = s[target_id];
    const real = rng.rand() < 0.5;

    if (real) {
      if (target.consecutive_negative_turns >= 2) {
        rumors.push(`Unverified: ${target.name} has posted losses for multiple consecutive turns — may be in serious trouble.`);
      } else if (target.capital > 2000) {
        rumors.push(`Unverified: ${target.name} is reportedly sitting on a massive capital reserve.`);
      } else if (target.market_share > 0.30) {
        rumors.push(`Unverified: ${target.name}'s market dominance is drawing regulatory scrutiny.`);
      } else {
        rumors.push(`Unverified: ${target.name} sector is showing signs of steady growth this period.`);
      }
    } else {
      const fakes = [
        `Unverified: ${target.name} is reportedly close to a pricing breakthrough.`,
        `Unverified: ${target.name} turned down a major investment offer last turn.`,
        `Unverified: ${target.name} may be planning to lobby for regulatory protection.`,
        `Unverified: ${target.name} sources suggest a major restructuring is underway.`,
        `Unverified: ${target.name} is said to be considering aggressive undercutting next turn.`,
      ];
      rumors.push(fakes[Math.floor(rng.rand() * fakes.length)]);
    }
  }

  return rumors;
}

// ── Signal generation ─────────────────────────────────────────────────────────
function generateSignal(sector, last_action) {
  const signals = {
    develop: 'expanding production aggressively',
    invest: 'deployed capital into an unknown sector',
    negotiate: 'reached out to another sector — unknown outcome',
    accept_deal: 'accepted a deal — terms unknown',
    hold: sector.capital > 1500 ? 'sitting on large cash reserves' : 'conserving capital',
    undercut: 'cutting prices — may be in a price war',
    lobby: 'seeking political influence',
  };
  return signals[last_action] || 'activity unclear';
}

// ── Build player state ────────────────────────────────────────────────────────
function buildPlayerState(sector_id, state, last_actions) {
  const s = state.sectors[sector_id];
  const competitors = {};

  Object.keys(state.sectors).forEach((id) => {
    if (id === sector_id) return;
    const comp = state.sectors[id];
    const noise = 1 + (rng.rand() * 2 - 1) * config.NOISE_FACTOR;
    const estimated_capital = Math.round(comp.capital * noise);
    const last_action = last_actions[id]?.action || 'unknown';
    competitors[id] = {
      name: comp.name,
      estimated_capital,
      market_share: Math.round(comp.market_share * 1000) / 1000,
      last_action,
      signal: generateSignal(comp, last_action),
      trust_score: comp.trust_score,                         // v2: public trust score
      supply_chain_connected: comp.resources.input_received, // v2: are they supply-chain-linked?
    };
  });

  const messages = (state.message_queues[sector_id] || []).slice();
  state.message_queues[sector_id] = [];

  const investors_in_you = {};
  Object.keys(s.investments_received || {}).forEach((inv_id) => {
    investors_in_you[inv_id] = { amount: s.investments_received[inv_id].amount };
  });

  // v2: supply chain info for this sector
  const dep_id = SUPPLY_CHAIN_DEPS[sector_id];
  const supply_chain_info = {
    dependency: dep_id || null,
    dependency_name: dep_id && state.sectors[dep_id] ? state.sectors[dep_id].name : null,
    input_received: s.resources.input_received,
    primary_output: s.resources.primary_output,
    penalty_active: !s.resources.input_received,
  };

  // v2: public trust scores for all sectors
  const trust_scores = {};
  Object.keys(state.sectors).forEach((id) => {
    trust_scores[id] = {
      name: state.sectors[id].name,
      score: state.sectors[id].trust_score,
    };
  });

  // v2: pending proposals awaiting this sector's response (persist until deadline)
  const pending_proposals = (state.pending_proposals[sector_id] || []).filter(
    (p) => !p.proposal.deadline_turn || p.proposal.deadline_turn >= state.turn
  );

  // v2: invested capital = sum of all investments_made amounts
  const invested_capital = Object.values(s.investments_made).reduce(
    (sum, inv) => sum + inv.amount, 0
  );

  const enriched_investments = {};
  Object.entries(s.investments_made).forEach(([target_id, inv]) => {
    const syn = getSynergyMultiplier(state.sectors, sector_id, target_id);
    enriched_investments[target_id] = {
      ...inv,
      synergy_multiplier: syn,
      effective_return_rate: Math.round(inv.return_rate * syn * 1000) / 1000,
      turns_held: inv._turns_held || 0,
    };
  });

  return {
    turn: state.turn,
    total_turns: 15,
    your_sector: {
      id: sector_id,
      name: s.name,
      capital: Math.round(s.capital),
      idle_capital: Math.round(s.capital),      // v2: liquid undeployed cash
      invested_capital,                           // v2: capital locked in investments
      debt: s.debt,
      net_worth: Math.round(s.capital - s.debt),
      production_capacity: s.production_capacity,
      price_per_unit: s.price_per_unit,
      market_share: Math.round(s.market_share * 1000) / 1000,
      last_turn_revenue: s.last_revenue,
      trust_score: s.trust_score,               // v2: your own reputation
      non_aggression_partners: s.non_aggression_partners, // v2: active NAPs
      investments_made: enriched_investments,
      investors_in_you,
      supply_chain: supply_chain_info,           // v2: supply chain status
      escrow_locked: Object.values(state.escrow || {})
        .filter(e => e.sector_id === sector_id)
        .reduce((sum, e) => sum + e.amount, 0), // v2.2: capital locked in pending proposals
    },
    market_overview: {
      total_market_size: config.MARKET_SIZE,
      competitors,
    },
    trust_scores,                                // v2: all public trust scores
    rumors: generateRumors(state, sector_id),
    messages,
    pending_proposals,                           // v2: structured proposals awaiting your response
    hidden_agenda: s.hidden_agenda || null,      // v2.4: your secret mission (only visible to you)
    memory: s.memory
      ? {
          recent_turns: s.memory.episodic_log,
          opponent_profiles: s.memory.opponent_profiles,
          strategic_reflection: s.memory.strategic_reflection,
        }
      : null,                                    // v2.3: episodic memory & opponent modeling
    escrow_locked: Object.values(state.escrow || {})
      .filter(e => e.sector_id === sector_id)
      .reduce((sum, e) => sum + e.amount, 0),   // v2.2: total capital locked in escrow
    available_actions: ['develop', 'invest', 'negotiate', 'accept_deal', 'hold', 'undercut', 'lobby'],
    action_guide: {
      develop: 'Spend ≥500 capital → production_capacity +10%',
      invest: 'Send capital to another sector → earn ~6% return per turn; strengthens supply chain link',
      negotiate: 'Send message + optional structured deal_proposal to one sector',
      accept_deal: 'Accept a pending deal_proposal from target sector — arbiter AUTOMATICALLY executes all terms',
      hold: 'Do nothing — WARNING: idle capital depreciates 5% per turn regardless',
      undercut: 'Cut price_per_unit 10% → steal ~0.04 market_share (breaks any NAP with affected sectors)',
      lobby: 'Pay 800 capital → 60% chance of favorable event next turn',
    },
    respond_with_json: {
      action: '<one of the available_actions>',
      target: '<sector id (lowercase) if required, else null>',
      amount: '<integer if action requires capital, else null>',
      message: '<string to send to target for negotiate, or null>',
      deal_proposal: {
        type: '<trade_pact | non_aggression | joint_venture>',
        investment_amounts: { proposer: '<integer>', target: '<integer>' },
        return_split: '<0.0–1.0, proposer share of joint returns>',
        duration_turns: '<integer, how many turns this deal lasts>',
        deadline_turn: '<integer, last turn target can accept>',
      },
      reasoning: '<1-2 sentences of internal strategy — NOT shown to other players>',
    },
  };
}

// ── v2.4: Hidden agenda assignment & evaluation ───────────────────────────────
function assignHiddenAgendas(state) {
  const ids = Object.keys(state.sectors);
  const shuffled = [...HIDDEN_AGENDAS].sort(() => rng.rand() - 0.5);
  ids.forEach((id, i) => {
    const agenda = shuffled[i % shuffled.length];
    state.sectors[id].hidden_agenda = {
      id: agenda.id,
      name: agenda.name,
      description: agenda.description,
    };
    state.sectors[id]._starting_capital = state.sectors[id].capital;
    state.sectors[id]._supply_connected_turns = 0;
  });
}

function tickSupplyChainCounters(state) {
  Object.keys(state.sectors).forEach((id) => {
    const s = state.sectors[id];
    if (s.resources && s.resources.input_received) {
      s._supply_connected_turns = (s._supply_connected_turns || 0) + 1;
    }
  });
}

function evaluateHiddenAgendas(state) {
  const results = {};
  Object.keys(state.sectors).forEach((id) => {
    const s = state.sectors[id];
    if (!s.hidden_agenda) return;
    const agenda = HIDDEN_AGENDAS.find(a => a.id === s.hidden_agenda.id);
    if (!agenda) return;
    const bonus = agenda.evaluate(s, state, id);
    s._agenda_score = bonus;
    results[id] = { agenda: s.hidden_agenda.name, bonus };
  });
  state.hidden_agenda_scores = results;
  return results;
}

// ── Score calculation ─────────────────────────────────────────────────────────
// ── v2.8: Activity-weighted composite score ───────────────────────────────────
// 40% Capital Rank | 30% Activity Score | 20% Synergy Score | 10% Deals Score
// + Hidden Agenda bonus (flat add, not weighted)
function calculateScore(sector, state, sector_id) {
  const ids = Object.keys(state.sectors);

  // ── Component 1: Capital Rank (40%) ──────────────────────────────────────
  // rank 1 → 1000 pts, rank last → 0 pts (linear interpolation)
  const net_worths = ids
    .map((id) => ({ id, nw: state.sectors[id].capital - state.sectors[id].debt }))
    .sort((a, b) => b.nw - a.nw);
  const capital_rank = net_worths.findIndex((x) => x.id === sector_id);
  const n = ids.length;
  const capital_score = n > 1
    ? Math.round((1 - capital_rank / (n - 1)) * 1000)
    : 1000;

  // ── Component 2: Activity Score (30%) ────────────────────────────────────
  const total_invested = Object.values(sector.investments_made)
    .reduce((sum, inv) => sum + inv.amount, 0);
  const deals_participated = (state.active_deals || []).filter(
    (d) => d.accepted && (d.sector_from === sector_id || d.sector_to === sector_id)
  ).length;
  const trust_growth = sector.trust_score - 500;

  const invested_norm  = Math.min(total_invested / 5000, 1.0);
  const deals_norm     = Math.min(deals_participated / 5, 1.0);
  const trust_norm     = Math.min(Math.max(trust_growth / 500, -1.0), 1.0);
  const activity_score = Math.round((invested_norm * 0.5 + deals_norm * 0.3 + trust_norm * 0.2) * 1000);

  // ── Component 3: Synergy Score (20%) ─────────────────────────────────────
  // 1.0→0 pts, 1.5→333 pts, 2.0→667 pts, 3.0→1000 pts
  let max_syn = 1.0;
  ids.forEach((oid) => {
    if (oid === sector_id) return;
    const syn = getSynergyMultiplier(state.sectors, sector_id, oid);
    if (syn > max_syn) max_syn = syn;
  });
  const synergy_score = Math.round(((max_syn - 1.0) / 2.0) * 1000);

  // ── Component 4: Deals Completed (10%) ───────────────────────────────────
  const deals_score = Math.min(deals_participated * 200, 1000);

  // ── Hidden agenda bonus (flat, not weighted) ──────────────────────────────
  const agenda_bonus = sector._agenda_score || 0;

  // ── Weighted composite ────────────────────────────────────────────────────
  const composite = Math.round(
    capital_score  * 0.40 +
    activity_score * 0.30 +
    synergy_score  * 0.20 +
    deals_score    * 0.10
  );

  sector._score_components = {
    capital_score,
    activity_score,
    synergy_score,
    deals_score,
    composite,
    agenda_bonus,
  };

  return composite + agenda_bonus;
}

function calculateScores(state) {
  const scores = {};
  Object.keys(state.sectors).forEach((id) => {
    scores[id] = {
      name: state.sectors[id].name,
      score: calculateScore(state.sectors[id], state, id),
      trust_score: state.sectors[id].trust_score,
      model: state.sectors[id].owner_model,
      player_type: state.sectors[id].player_type,
    };
  });
  return scores;
}

// ── v2.5: Adaptive event engine — stagnation tax & regulatory scrutiny ───────
function applyStagnationTax(state, actions, turn_events_log) {
  const ids = Object.keys(state.sectors);
  const all_held = ids.every((id) => {
    const act = actions[id]?.action;
    return !act || act === 'hold';
  });
  if (!all_held) return false;

  const rate = config.STAGNATION_TAX_RATE || 0.05;
  turn_events_log.push(
    `STAGNATION TAX: All sectors held this turn — extra ${rate * 100}% capital penalty applied.`
  );
  ids.forEach((id) => {
    const s = state.sectors[id];
    const tax = Math.round(s.capital * rate);
    s.capital -= tax;
    s.idle_capital = s.capital;
    turn_events_log.push(`  ${s.name}: -${tax} stagnation tax.`);
  });
  return true;
}

function applyRegulatorySscrutiny(state, turn_events_log) {
  const threshold = config.REGULATORY_SCRUTINY_THRESHOLD || 0.50;
  const penalty   = config.REGULATORY_SCRUTINY_PENALTY   || 0.04;

  Object.keys(state.sectors).forEach((id) => {
    const s = state.sectors[id];
    if (s.market_share > threshold) {
      s.market_share = Math.max(0.05, s.market_share - penalty);
      turn_events_log.push(
        `REGULATORY SCRUTINY: ${s.name} dominates market (>${Math.round(threshold * 100)}%) ` +
        `— market_share reduced by ${penalty} to ${s.market_share.toFixed(3)}.`
      );
      renormalizeMarketShares(state);
    }
  });
}

// ── v2.7: Forced investment rounds ───────────────────────────────────────────
// Every FORCED_INVEST_INTERVAL turns, sectors must deploy ≥30% of capital.
// Non-compliant sectors pay 25% tax on the shortfall.
function applyForcedInvestmentTax(state, actions, turn_events_log) {
  const interval = config.FORCED_INVEST_INTERVAL || 3;
  if (state.turn % interval !== 0) return;

  const min_rate = config.FORCED_INVEST_MIN_RATE || 0.30;
  const tax_rate = config.FORCED_INVEST_TAX_RATE || 0.25;

  Object.keys(state.sectors).forEach((id) => {
    const s = state.sectors[id];
    // Use capital snapshot from before this turn's actions (stored by updateSectorMemory)
    const capital_before = s._prev_capital || s.capital;
    const required_deploy = Math.round(capital_before * min_rate);

    const act = actions[id]?.action;
    const deployed_actions = ['invest', 'develop', 'lobby', 'accept_deal'];
    const did_deploy = deployed_actions.includes(act);

    let amount_deployed = 0;
    if (did_deploy) {
      if (act === 'invest' || act === 'develop') {
        amount_deployed = actions[id]?.amount || 0;
      } else if (act === 'lobby') {
        amount_deployed = config.LOBBY_COST || 800;
      } else if (act === 'accept_deal') {
        // accept_deal deploys capital via deal terms — count as meeting the minimum
        amount_deployed = required_deploy;
      }
    }

    if (amount_deployed >= required_deploy) {
      turn_events_log.push(
        `FORCED INVEST (turn ${state.turn}): ${s.name} compliant — deployed ${amount_deployed} ` +
        `(required ≥${required_deploy}).`
      );
      return;
    }

    const shortfall = required_deploy - amount_deployed;
    const tax = Math.round(shortfall * tax_rate);
    const actual_tax = Math.min(tax, Math.floor(s.capital));

    s.capital -= actual_tax;
    s.idle_capital = s.capital;

    turn_events_log.push(
      `FORCED INVEST (turn ${state.turn}): ${s.name} NON-COMPLIANT — ` +
      `deployed ${amount_deployed} vs required ${required_deploy}. ` +
      `Tax: -${actual_tax} (25% of ${shortfall} shortfall).`
    );
  });
}

// ── v2.10: Diminishing investment returns ─────────────────────────────────────
// Each held investment loses INVESTMENT_DECAY_RATE per turn, floored at INVESTMENT_MIN_RETURN.
// New investments always start at INVESTMENT_BASE_RETURN and track _turns_held from 0.
function applyInvestmentDecay(state, turn_events_log) {
  const decay  = config.INVESTMENT_DECAY_RATE || 0.003;
  const min_rr = config.INVESTMENT_MIN_RETURN || 0.01;

  Object.keys(state.sectors).forEach((investor_id) => {
    const s = state.sectors[investor_id];
    Object.keys(s.investments_made).forEach((target_id) => {
      const inv = s.investments_made[target_id];

      // Initialize turn counter on legacy investments that predate this feature
      if (inv._turns_held == null) inv._turns_held = 0;
      inv._turns_held++;

      const prev_rr = inv.return_rate;
      inv.return_rate = Math.max(min_rr, Math.round((inv.return_rate - decay) * 10000) / 10000);

      if (inv.return_rate < prev_rr) {
        turn_events_log.push(
          `INVESTMENT DECAY: ${s.name}→${state.sectors[target_id]?.name || target_id} ` +
          `return_rate ${(prev_rr * 100).toFixed(2)}% → ${(inv.return_rate * 100).toFixed(2)}% ` +
          `(held ${inv._turns_held} turns).`
        );
      }
    });
  });
}

// ── v2.9: Negotiation deadline escalation ────────────────────────────────────
// Proposals older than NEGOTIATION_FREE_TURNS cost the proposer 5%/turn.
// At NEGOTIATION_AUTOMATCH_TURNS, if target has a reciprocal proposal, deals are auto-executed.
function applyNegotiationEscalation(state, turn_events_log) {
  const free_turns   = config.NEGOTIATION_FREE_TURNS    || 2;
  const tax_per_turn = config.NEGOTIATION_TAX_PER_TURN  || 0.05;
  const tax_cap      = config.NEGOTIATION_TAX_CAP       || 0.20;
  const automatch_at = config.NEGOTIATION_AUTOMATCH_TURNS || 5;

  const executed_by_automatch = [];

  Object.keys(state.pending_proposals).forEach((target_id) => {
    if (!state.sectors[target_id]) return;

    state.pending_proposals[target_id] = state.pending_proposals[target_id].filter((p) => {
      const proposer_id = p.proposal.proposer;
      const proposer    = state.sectors[proposer_id];
      if (!proposer) return false;

      const age = state.turn - (p.turn_sent || state.turn);

      // Free window — no action
      if (age <= free_turns) return true;

      // Escalating tax on proposer
      const excess_turns = Math.min(age - free_turns, Math.round(tax_cap / tax_per_turn));
      const rate = Math.min(excess_turns * tax_per_turn, tax_cap);
      const tax  = Math.round(proposer.capital * rate);
      if (tax > 0) {
        proposer.capital -= tax;
        proposer.idle_capital = proposer.capital;
        turn_events_log.push(
          `NEGOTIATION TAX: ${proposer.name} -${tax} (proposal to ${state.sectors[target_id]?.name} ` +
          `age=${age} turns, rate=${Math.round(rate * 100)}%).`
        );
      }

      // Auto-match at threshold — execute if target has a reciprocal proposal pending
      if (age >= automatch_at) {
        const reciprocal = (state.pending_proposals[proposer_id] || []).find(
          (rp) => rp.proposal.proposer === target_id
        );
        if (reciprocal) {
          const { valid } = validateProposal(state, p.proposal, proposer_id);
          if (valid) {
            const dummy_log = [];
            executeDeal(state, p.proposal, dummy_log, executed_by_automatch);
            dummy_log.forEach((m) => turn_events_log.push(`AUTO-MATCH: ${m}`));
            // Remove reciprocal proposal too
            state.pending_proposals[proposer_id] = (state.pending_proposals[proposer_id] || [])
              .filter((rp) => rp !== reciprocal);
            return false; // remove current proposal (executed)
          }
        }
        // No reciprocal — keep taxing (expiry handles deadline removal)
      }

      return true;
    });
  });

  if (executed_by_automatch.length > 0) {
    turn_events_log.push(
      `AUTO-MATCH executed ${executed_by_automatch.length} deal(s) from stale mutual proposals.`
    );
    executed_by_automatch.forEach(({ proposer, target }) => {
      if (state.sectors[proposer]) {
        state.sectors[proposer].trust_score = Math.min(
          config.TRUST_SCORE_MAX,
          state.sectors[proposer].trust_score + 30
        );
      }
      if (state.sectors[target]) {
        state.sectors[target].trust_score = Math.min(
          config.TRUST_SCORE_MAX,
          state.sectors[target].trust_score + 30
        );
      }
    });
  }

  return executed_by_automatch;
}

// ── v2.3: Persistent episodic memory & opponent modeling ──────────────────────
function updateSectorMemory(state, sector_id, actions_taken, turn_events_log) {
  const s = state.sectors[sector_id];
  if (!s || !s.memory) return;

  const act = actions_taken[sector_id] || {};
  const prev_capital = s._prev_capital || s.capital;

  // --- episodic_log ---
  const entry = {
    turn: state.turn,
    action: act.action || 'unknown',
    target: act.target || null,
    amount: act.amount || null,
    revenue: s.last_revenue,
    capital_after: Math.round(s.capital),
    capital_delta: Math.round(s.capital - prev_capital),
    supply_connected: s.resources.input_received,
  };
  s.memory.episodic_log.push(entry);
  if (s.memory.episodic_log.length > 5) s.memory.episodic_log.shift();
  s._prev_capital = s.capital;

  // --- opponent_profiles ---
  Object.keys(state.sectors).forEach((oid) => {
    if (oid === sector_id) return;
    const oact = actions_taken[oid];
    if (!oact) return;

    if (!s.memory.opponent_profiles[oid]) {
      s.memory.opponent_profiles[oid] = {
        recent_actions: [],
        hold_count: 0,
        undercut_count: 0,
        invest_count: 0,
        deals_with_me: { proposed_to_me: 0, i_accepted: 0, they_accepted: 0, betrayals: 0 },
      };
    }
    const prof = s.memory.opponent_profiles[oid];
    prof.recent_actions.push(oact.action);
    if (prof.recent_actions.length > 3) prof.recent_actions.shift();
    if (oact.action === 'hold')     prof.hold_count++;
    if (oact.action === 'undercut') prof.undercut_count++;
    if (oact.action === 'invest')   prof.invest_count++;
  });

  // track proposals sent to me this turn
  (state.pending_proposals[sector_id] || []).forEach((p) => {
    const prof = s.memory.opponent_profiles[p.proposal.proposer];
    if (prof) prof.deals_with_me.proposed_to_me++;
  });
}

function computeStrategicReflection(state, sector_id) {
  const s = state.sectors[sector_id];
  if (!s) return null;

  // capital trend from episodic log
  const log = s.memory.episodic_log;
  let capital_trend = 'stable';
  if (log.length >= 2) {
    const recent_delta = log.slice(-2).reduce((sum, e) => sum + e.capital_delta, 0);
    if (recent_delta > 100)  capital_trend = 'growing';
    if (recent_delta < -100) capital_trend = 'declining';
  }

  // best synergy opportunity
  let best_synergy = null;
  let best_synergy_gap = Infinity;
  Object.keys(state.sectors).forEach((oid) => {
    if (oid === sector_id) return;
    const my_inv    = (s.investments_made[oid]?.amount || 0);
    const their_inv = (state.sectors[oid]?.investments_made?.[sector_id]?.amount || 0);
    const min_mutual = Math.min(my_inv, their_inv);
    const tiers = config.SYNERGY_RETURN_TIERS || [
      { min_mutual: 500, multiplier: 3.0 },
      { min_mutual: 300, multiplier: 2.0 },
      { min_mutual: 100, multiplier: 1.5 },
    ];
    const next_tier = tiers.slice().reverse().find(t => min_mutual < t.min_mutual);
    if (next_tier) {
      const gap = next_tier.min_mutual - min_mutual;
      if (gap < best_synergy_gap) {
        best_synergy_gap = gap;
        best_synergy = {
          with: oid,
          current_min_mutual: min_mutual,
          next_multiplier: next_tier.multiplier,
          gap_to_next_tier: gap,
        };
      }
    }
  });

  // most threatening competitor (highest capital)
  let threat = null;
  let threat_capital = -Infinity;
  Object.keys(state.sectors).forEach((oid) => {
    if (oid === sector_id) return;
    if (state.sectors[oid].capital > threat_capital) {
      threat_capital = state.sectors[oid].capital;
      threat = oid;
    }
  });

  return {
    computed_turn: state.turn,
    capital_trend,
    supply_chain_connected: s.resources.input_received,
    best_synergy_opportunity: best_synergy,
    most_threatening_competitor: threat
      ? { id: threat, capital: Math.round(threat_capital) }
      : null,
  };
}

module.exports = {
  INITIAL_SECTORS,
  SUPPLY_CHAIN_DEPS,
  createInitialState,
  buildPlayerState,
  resolveActions,
  resolveRevenue,
  getSynergyMultiplier,
  resolveInvestmentDividends,
  applyDebtCosts,
  applyCapitalDepreciation,
  resolveSupplyChain,
  applyUniqueMechanics,
  checkSynergies,
  checkBankruptcy,
  checkDealViolations,
  tickEventCounters,
  renormalizeMarketShares,
  clampMarketShares,
  calculateScore,
  calculateScores,
  updateTrustScores,
  validateProposal,
  executeDeal,
  lockEscrow,
  releaseEscrow,
  updateSectorMemory,
  computeStrategicReflection,
  assignHiddenAgendas,
  evaluateHiddenAgendas,
  tickSupplyChainCounters,
  HIDDEN_AGENDAS,
  applyStagnationTax,
  applyRegulatorySscrutiny,
  applyForcedInvestmentTax,
  applyNegotiationEscalation,
  applyInvestmentDecay,
};
