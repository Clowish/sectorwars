# SectorWars Changelog

## v2.0.0 — 2026-04-11

Based on the research report `sectorwars_raport.md` which identified structural causes for
HOLD dominance, zero deal execution, and event repetition in v1. Six mechanism-design fixes
implemented in priority order.

---

### 1. Capital Depreciation (`config.js`, `arbiter.js`, `index.js`)

**Problem:** HOLD was the dominant strategy — idle capital earned 2% interest at zero risk,
making passive accumulation rational. Over 15 turns a full-HOLD player lost nothing.

**Change:**
- Added `IDLE_CAPITAL_DEPRECIATION_RATE: 0.05` to `config.js`.
- New function `applyCapitalDepreciation(state, turn_events_log)` in `arbiter.js` — runs at
  the start of every turn before any other mechanics, applying `-5%` to each sector's liquid
  capital regardless of action chosen.
- Removed the `CASH_INTEREST_RATE` (2%) bonus from the HOLD action. HOLD now reads:
  *"no action — idle capital already depreciated this turn."*
- Added `idle_capital` field to each sector in `INITIAL_SECTORS`, kept in sync with `capital`
  on every write. Exposed as `idle_capital` and `invested_capital` (sum of `investments_made`)
  in `buildPlayerState` so models can distinguish liquid cash from deployed capital.

**Effect:** Net HOLD return is now `-5%/turn`. After 10 consecutive HOLD turns a sector loses
~40% of its starting cash. Invest earns +6%/turn return — a +11pp advantage over HOLD.

---

### 2. Accept = Execute (`arbiter.js`, `models.js`, `prompts.js`)

**Problem:** 45 proposals in v1 produced zero executed deals. Accepting a proposal in natural
language did not prevent the accepting model from choosing HOLD on the same turn.

**Change:**
- Added `accept_deal` to `VALID_ACTIONS` in `models.js` and to `available_actions` in
  `buildPlayerState`.
- New action `accept_deal` with `target: <proposer_sector_id>`: when processed, `resolveActions`
  calls `executeDeal()` which **automatically transfers capital, records investments, sets NAP
  flags, and logs the active deal** — no separate execution step.
- `resolveActions` now returns `{ executed_deals, betrayals }` (previously void) so callers can
  pass results to trust score updates.
- `executeDeal(state, proposal, turn_events_log, executed_deals)` added to `arbiter.js`: handles
  all three deal types (`trade_pact`, `non_aggression`, `joint_venture`), clamps transfer amounts
  to actual available capital, and pushes to `state.active_deals`.

---

### 3. Supply Chain Interdependency (`config.js`, `arbiter.js`, `index.js`)

**Problem:** The flat economy allowed full HOLD with no trade penalty. Sectors had no structural
reason to interact.

**Change:**
- Added `SUPPLY_CHAIN_DEPS` constant in `arbiter.js`:
  `technology←energy`, `finance←technology`, `agriculture←finance`, `energy←agriculture`.
- Added `resources` object to every sector in `INITIAL_SECTORS`:
  `{ primary_output, input_source, input_received }`. `input_received` is `false` by default
  and updated each turn.
- New function `resolveSupplyChain(state, turn_events_log)` — called before `resolveRevenue`
  each turn. Checks whether a sector has any investment relationship (either direction) with its
  dependency sector. Sets `s[id].resources.input_received = true/false`.
- `calculateRevenue` applies `SUPPLY_CHAIN_SELF_PRODUCE_REVENUE_MULTIPLIER: 0.6` (40% penalty)
  when `input_received` is `false`. Finance's fee component and all production-sector revenues
  are multiplied. Dividend income is unaffected (already a separate flow).
- Added `SUPPLY_CHAIN_SELF_PRODUCE_REVENUE_MULTIPLIER: 0.6` to `config.js`.
- Supply chain status (`supply_chain_connected`, `resources`) included in `turn_summary` and in
  `buildPlayerState` under `your_sector.supply_chain` and `competitors[id].supply_chain_connected`.

**Effect:** A sector with no trade links earns only 60% of baseline revenue every turn.
The circular dependency (E→T→F→A→E) means investing in your dependency also benefits your
dependency's dependency, creating natural coalition pressure.

---

### 4. Structured Proposal Protocol (`arbiter.js`, `prompts.js`)

**Problem:** Free-form `deal_proposal.terms` strings were unparseable by the arbiter, making
automatic enforcement impossible and proposals cheap talk.

**Change:**
- `deal_proposal` in the negotiate action is now a structured object:
  ```json
  {
    "type": "trade_pact | non_aggression | joint_venture",
    "investment_amounts": { "proposer": 300, "target": 200 },
    "return_split": 0.5,
    "duration_turns": 3,
    "deadline_turn": 7
  }
  ```
  (`proposer` and `target` sector IDs are filled in from the action's sender and `target` field
  by the arbiter — models cannot spoof them.)
- New `validateProposal(state, proposal, proposer_id)` in `arbiter.js` checks:
  - `type` is one of `trade_pact`, `non_aggression`, `joint_venture`
  - `target` sector exists and is not bankrupt
  - `deadline_turn` is in the future
  - proposer has enough capital for their `investment_amounts.proposer` share
  Returns `{ valid: bool, errors: string[] }`. Invalid proposals are rejected with a log message
  before they reach the target's queue.
- Valid proposals are stored in `state.pending_proposals[target_id]` and remain visible in the
  target's `buildPlayerState` until accepted or deadline passes.
- `expirePendingProposals(state, turn, log)` in `index.js` removes stale proposals each turn.
- `prompts.js` updated with explicit deal_proposal schema in `respond_with_json` and a
  per-action guide explaining the protocol.

---

### 5. Event Cooldown (`config.js`, `events.js`)

**Problem:** The same event (e.g., Energy Price Spike) could fire on consecutive turns, creating
distorted game states and making benchmark results non-reproducible.

**Change:**
- Added `EVENT_COOLDOWN_TURNS: 4` to `config.js`.
- `state.event_cooldowns: {}` (`{ [event_id]: last_turn_triggered }`) added to `createInitialState`.
- `drawEvent` in `events.js` now filters candidates: any event whose `event_cooldowns[id]` entry
  was set within the last 4 turns is excluded from the weighted draw. If all events are on cooldown,
  returns `null` (no event that turn).
- After selecting an event, `state.event_cooldowns[selected.id] = current_turn` is recorded.
- Lobby-triggered `infrastructure_bill` (weight=0) bypasses the cooldown pool entirely.

**Effect:** Any event type can fire at most once per 4 turns. With 7 drawable events and a 15-turn
game, the system guarantees variety and prevents the 6× consecutive Energy Spike seen in v1.

---

### 6. Reputation Ledger (`config.js`, `arbiter.js`, `index.js`, `prompts.js`)

**Problem:** No mechanism rewarded promise-keeping or punished betrayal. All interactions were
effectively single-shot.

**Change:**
- Added `TRUST_SCORE_INITIAL: 500`, `TRUST_SCORE_MAX: 1000`, `TRUST_SCORE_MIN: 0` to `config.js`.
- Added `trust_score: 500` and `non_aggression_partners: []` to every sector in `INITIAL_SECTORS`.
- New function `updateTrustScores(state, actions, executed_deals, betrayals, log)` in `arbiter.js`,
  called each turn after `resolveActions`:
  - **+50** to both parties of every executed deal
  - **+10** to any sector that chose `invest` this turn
  - **−100** for general betrayals
  - **−150** for `attacked_after_nap` (undercutting while holding a non-aggression pact)
- NAP violation detection in the `UNDERCUT` block of `resolveActions`: before applying the
  undercut, any `non_aggression_partners` entry for the undercutter is checked, a betrayal event
  is recorded, and the NAP is removed from both sides.
- `calculateScore` includes a trust bonus: `Math.round((trust_score - 500) * 0.3)`, giving a
  range of −150 (score 0) to +150 (score 1000) points.
- Trust scores are exposed publicly in `buildPlayerState` under `trust_scores` and in competitor
  info. Included in `turn_summary` and final standings console output.

---

### Supporting changes

- **`models.js` mock:** Rotates through `invest → negotiate → accept_deal → develop → hold` to
  exercise all v2 code paths during `--dry-run`. Generates valid structured proposals with correct
  `deadline_turn` values.
- **`index.js` turn order (v2):**
  1. `applyCapitalDepreciation` (new)
  2. `resolveSupplyChain` (new)
  3. `applyUniqueMechanics`
  4. Apply pending event
  5. `resolveRevenue` + `resolveInvestmentDividends`
  6. `applyDebtCosts`
  7. `checkSynergies`
  8. `expirePendingProposals` (new)
  9. Get model actions
  10. `resolveActions` → returns `{ executed_deals, betrayals }`
  11. `updateTrustScores` (new)
  12. `checkDealViolations`
  13. `checkBankruptcy`
  14. `drawEvent` (now with cooldown)
  15. `tickEventCounters` + `clampMarketShares`
- **`turn_summary`** extended with: `idle_capital`, `invested_capital`, `trust_score`,
  `supply_chain_connected`, `resources`, `non_aggression_partners`, `active_deals`,
  `executed_deals_this_turn`.
- **Console output:** Per-turn trust score line added; final standings show trust alongside score.
