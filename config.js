require('dotenv').config();

module.exports = {
  TOTAL_TURNS: 15,
  TURN_DELAY_MS: 5000,   // 4 providers with separate rate limits — 5s between turns is sufficient
  API_TIMEOUT_MS: 25000,
  MAX_RETRIES: 2,
  MARKET_SIZE: 5000,
  DEBT_INTEREST_RATE: 0.03,
  CASH_INTEREST_RATE: 0.02,
  INVESTMENT_BASE_RETURN: 0.06,
  NOISE_FACTOR: 0.20,
  LOBBY_SUCCESS_RATE: 0.60,
  LOBBY_COST: 800,

  // v2: Capital depreciation — idle capital loses 5% per turn (kills HOLD dominance)
  IDLE_CAPITAL_DEPRECIATION_RATE: 0.05,

  // v2: Supply chain — revenue multiplier when no trade link to dependency sector
  // 0.6 = self-producing at 3× cost leaves only ~60% net value (1 - 2/3 overhead)
  SUPPLY_CHAIN_SELF_PRODUCE_REVENUE_MULTIPLIER: 0.6,

  // Delay between retry attempts inside callModelWithFallback.
  // At 6 000 TPM (100 tokens/s) a Qwen3 think block uses ~1 500 tokens; waiting
  // 8 s is a reasonable middle ground across multiple providers.
  RETRY_DELAY_MS: 8000,

  // v2: Event cooldown — no event type repeats within this many turns
  EVENT_COOLDOWN_TURNS: 4,

  // v2: Reputation ledger — starting trust score and bounds
  TRUST_SCORE_INITIAL: 500,
  TRUST_SCORE_MAX: 1000,
  TRUST_SCORE_MIN: 0,
// v2.1: Superlinear synergy returns — tiers based on minimum mutual investment amount.
// Multiplier applies to return_rate for BOTH sides of a mutual investment.
// Tiers checked in descending order; first match wins.
SYNERGY_RETURN_TIERS: [
  { min_mutual: 500, multiplier: 3.0 },
  { min_mutual: 300, multiplier: 2.0 },
  { min_mutual: 100, multiplier: 1.5 },
],

  // v2.2: Escrow deposits — fraction of proposer's investment_amounts.proposer locked on proposal
  ESCROW_DEPOSIT_RATE: 0.20,
  // Cooperation bonus returned on top of deposit when deal executes
  ESCROW_COOPERATION_BONUS_RATE: 0.20,

  // v2.5: Adaptive event engine
  STAGNATION_TAX_RATE: 0.05,          // extra capital loss when ALL sectors HOLD same turn
  REGULATORY_SCRUTINY_THRESHOLD: 0.50, // market_share above this triggers regulatory penalty
  REGULATORY_SCRUTINY_PENALTY: 0.04,   // market_share reduction applied to dominant sector
  EVENT_FORECAST_TURNS: 2,             // how many turns ahead events are forecast (was 1)

  // v2.7: Forced investment rounds — every 3 turns
  FORCED_INVEST_INTERVAL: 3,           // every N turns is a forced-invest turn
  FORCED_INVEST_MIN_RATE: 0.30,        // sector must deploy ≥30% of capital
  FORCED_INVEST_TAX_RATE: 0.25,        // tax on shortfall if requirement not met

  // v2.9: Negotiation deadline escalation
  NEGOTIATION_FREE_TURNS: 2,           // turns without cost
  NEGOTIATION_TAX_PER_TURN: 0.05,      // % of proposer capital per turn above free window
  NEGOTIATION_TAX_CAP: 0.20,           // max cumulative tax rate (capped at 4 turns escalation)
  NEGOTIATION_AUTOMATCH_TURNS: 5,      // turns waiting before engine tries auto-match

  // v2.10: Diminishing investment returns
  INVESTMENT_DECAY_RATE: 0.003,        // return_rate drops 0.3% per turn held
  INVESTMENT_MIN_RETURN: 0.01,         // floor return_rate (1%) — never decays to 0
};
