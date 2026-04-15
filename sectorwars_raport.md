# SectorWars is broken in exactly the ways research predicts

**The core problem is structural, not model-dependent.** Recent research (2023–2026) on LLM behavior in multi-agent strategic games reveals that every pathology observed in SectorWars — HOLD dominance, negotiation deadlock, zero cooperation execution, larger-model conservatism — is a well-documented, reproducible phenomenon across the field. The good news: each of these failures has known fixes grounded in mechanism design, and SectorWars sits in a genuinely valuable and underexplored niche as a benchmark. What follows is the evidence base and a concrete engineering roadmap to make v2 work.

---

## 1. The academic consensus on LLMs in strategic games

Three major benchmarks published between 2024 and 2025 — **GTBench** (NeurIPS 2024), **GAMA-Bench** (ICLR 2025), and **GameBench** (NeurIPS 2024) — collectively evaluated dozens of LLMs across hundreds of game-theoretic scenarios and reached converging conclusions that directly explain SectorWars results.

**LLMs have a measurable cooperative bias that sabotages competitive play.** Fontana et al. (2024) showed Llama-2 cooperates at near-100% rates in Prisoner's Dilemma regardless of opponent behavior — even when holding pessimistic beliefs about the other player. Multiple papers attribute this to an **"alignment tax"**: RLHF training optimizes for helpfulness and harmlessness, which installs a prosocial prior that overrides strategic reasoning. This isn't a bug in the models — it's a direct consequence of safety training. The cooperative bias manifests as verbal cooperation (sending proposals, expressing willingness to collaborate) without strategic follow-through (actually committing capital), which is precisely the SectorWars pattern of 45 proposals and zero executions.

**The strategy-execution gap is real and scales with model capability.** The STAR benchmark (2025) documented that reasoning-intensive models formulate sophisticated strategies but suffer from inference latency and over-deliberation that leads to conservative, passive play. GPT-o1 explicitly invokes minimax reasoning — "I will now use minimax" — producing strong defensive play but failing in mixed-motive settings where trust and risk-taking are required. A striking finding from Yadav et al. (April 2026) showed that **OpenAI's o3 achieved only 17% of optimal collective performance** in a zero-cost collaboration task, while the smaller o3-mini reached 50%. Capability does not predict cooperation. Scaling intelligence alone will not solve coordination problems.

**Multi-agent LLM systems fail at alarming rates.** The MAST framework (Cemri et al., 2025) analyzed 1,600+ traces across seven multi-agent systems and found failure rates of **41–86.7%**. Of those failures, 37% stemmed from inter-agent misalignment — communication breakdowns, inconsistent goals, and coordination failures. This directly explains why SectorWars synergies (requiring mutual investment ≥300) never activated: even when models wanted to cooperate, they couldn't coordinate the simultaneous commitments required.

GTBench's most actionable finding for SectorWars is that LLMs fail at complete-information deterministic games (solvable by MCTS) but show genuine strategic differentiation in **incomplete-information, probabilistic settings** — exactly the design space SectorWars occupies. GAMA-Bench confirmed this with 10-agent games, finding that multi-agent settings reveal decision-making patterns invisible in two-player games, including herd behavior and coalition dynamics. SectorWars's four-player partial-information design is well-positioned; the problem is payoff structure, not game architecture.

---

## 2. Why HOLD dominates and the six mechanisms to kill it

HOLD dominance is a textbook degenerate strategy. When interest on held capital provides reliable returns at zero risk, and cooperative mechanics require uncertain mutual commitment, the Nash equilibrium collapses to universal passivity. The "Lazy Agent" problem (Liu et al., ICML 2023) documents this precisely: in environments with sparse cooperative rewards, agents converge on passive behavior because they perceive no direct benefit from risky action. Three compounding factors make this worse for LLMs specifically: the alignment-driven risk aversion discussed above, rigid heuristic application (models over-apply win-stay/lose-switch without adapting), and the absence of any penalty for inaction.

The fix requires making inaction costly, cooperation rewarding, and passive accumulation impossible. Here are six concrete mechanisms, ordered by implementation priority and expected impact:

**Capital depreciation (5% per round on idle capital)** is the single highest-impact change. Undeployed capital loses value each turn, transforming HOLD from a dominant strategy into a losing one. Over 10 rounds, uninvested capital loses ~40% of its value. Implementation is trivial: `idle_capital *= 0.95` each round. This mirrors real-world inflation and forces engagement.

**Superlinear synergy returns** make cooperation dramatically more rewarding than solo play. Currently, synergy bonuses appear to be linear or insufficient to justify the coordination cost. Making joint investment returns superlinear — mutual investment of 300 yields 2× return, 500 yields 3× — inverts the payoff matrix so that the rational strategy becomes finding a partner, not sitting idle.

**Supply chain interdependency** is the deepest structural fix. Replace the flat economy with a dependency graph where each sector produces a primary resource and requires inputs from others. Energy feeds Technology, Technology feeds Finance, Finance feeds Agriculture, Agriculture feeds Energy. Critically, producing your own inputs costs **3× versus trading**. This makes trade economically necessary rather than optional, eliminating the viability of pure HOLD because sectors that don't trade can't produce efficiently.

**Diminishing interest rates** (5% → 3% → 1% → 0% over rounds) ensure that even if a model tries to hold, the returns shrink to nothing. Combined with depreciation, this creates a scissors effect: holding costs increase while holding returns decrease.

**Forced investment rounds** every three turns require all players to deploy at least 30% of capital. Undeployed excess faces a 25% tax. This provides structural insurance against HOLD even if other mechanisms are insufficient.

**Activity-weighted scoring** replaces absolute capital with a composite: 40% capital rank, 30% activity/investment score, 20% synergy score, 10% deals completed. This ensures that passive play can't win even if capital is somehow preserved through all other mechanisms.

The Melting Pot benchmark (DeepMind) offers a key design principle: **the highest-scoring outcome must be unreachable without cooperation, but passive agents should still survive at much lower scores**. The ceiling for cooperative play should be dramatically higher than the floor of passive play. Currently, SectorWars has no ceiling — HOLD is both the floor and the ceiling.

---

## 3. Why 45 proposals produced zero deals — and how to fix it

The negotiation-without-execution problem has three root causes, each requiring a different architectural solution.

**Root cause 1: LLM messages are "cheap talk."** In game theory, cheap talk refers to costless, non-binding communication with no impact on payoffs. Every proposal Mistral sent was free to send and free to ignore. Without costs attached to proposals or rewards for execution, communication carries no credibility. NegotiationArena (ICML 2024) documented that LLMs exhibit irrational negotiation behaviors including the "babysitting effect" — stronger models waste effort correcting weaker models' errors rather than advancing their own goals. Schneider et al. (2023) found LLMs are overly credulous in negotiation, believing claims beyond reasonable levels, while simultaneously being unable to recognize when further negotiation is futile.

**Root cause 2: There's a gap between agreement and action.** Even if two models "agree" in natural language, there's a separate execution step where each model independently chooses its action. Nothing prevents a model from agreeing to invest 300 capital and then choosing HOLD instead. CICERO (Meta FAIR, Science 2022) solved this in Diplomacy by integrating a **controllable dialogue model with a planning engine** — dialogue was grounded in carefully chosen, mutually beneficial plans. Pure LLMs lack this planning module entirely.

**Root cause 3: Context collapse over multiple turns.** As conversations extend, agents lose track of prior commitments. The MAST framework found that 37% of multi-agent failures stem from inter-agent misalignment, including agents forgetting or contradicting earlier agreements.

The solutions, in priority order:

**Structured proposal protocol** eliminates ambiguity by replacing free-form diplomacy with machine-parseable proposals. Instead of natural language like "perhaps we could explore a mutually beneficial arrangement," force proposals into structured JSON: proposer, target, investment amounts, return split, duration, acceptance deadline. The game engine validates proposals, checks capital availability, and presents clear ACCEPT/REJECT/COUNTER options. This alone would likely convert a significant fraction of proposals into actionable deals.

**Accept-equals-execute** is the simplest possible fix: when a player sends a proposal and another accepts, the deal automatically executes on the engine side. No separate execution step. This eliminates the agreement-action gap entirely. Players still choose whether to accept, preserving strategic agency, but acceptance is commitment.

**Escrow deposits** make proposals costly. When proposing a deal, the proposer locks 20% of the proposed investment as a deposit. If the deal executes, the deposit returns with a cooperation bonus. If either party reneges, the defector loses their deposit and the faithful party receives both deposits. This transforms cheap talk into costly signaling — a well-established mechanism from Schelling's commitment theory (1960).

**Negotiation deadlines with escalating costs** create urgency. Rounds 1–2 of a negotiation are free. Round 3 imposes a 5% "negotiation tax" on both parties. Round 4: 10%. Round 5+: the game engine auto-matches the best compatible proposals. Research on deadline effects shows most concessions occur close to deadlines, and LLMs should converge faster under time pressure.

**Reputation tracking** transforms single-shot interactions into repeated games. Each agent gets a public Trust Score (0–1000), increasing with fulfilled deals and decreasing with betrayals. Agents above 700 get a 10% bonus on cooperative payouts; below 300, a 10% penalty. This creates tangible incentives for promise-keeping across turns.

---

## 4. What makes a good LLM benchmark game — and where SectorWars stands

SectorWars occupies a genuinely valuable niche in the benchmark landscape. No existing benchmark combines multi-agent (4+) economic strategy with explicit trade mechanics, resource management, and multi-turn competition in a single integrated game. **CivBench** (2025) is the closest analog — LLMs play Civilization V across hundreds of turns — but operates at far higher complexity and cost (~$10,497 for full reproduction). **TextArena** (2025) covers 74+ environments with TrueSkill ratings but lacks deep economic mechanics. SectorWars sits in the gap between simple matrix games (GAMA-Bench) and complex 4X strategy (CivBench).

The research consensus on what makes a good LLM benchmark game converges on several properties SectorWars already has and several it critically lacks.

**What SectorWars already does right.** Partial/incomplete information is essential — GTBench's key finding is that LLMs show genuine strategic differentiation only in incomplete-information settings. The four-player format captures multi-agent dynamics invisible in two-player games. The mixed cooperative-competitive design (trade + competition) creates richer strategic behavior than pure zero-sum games. And the novel game design means it's out-of-distribution — unlike Chess or Poker, LLMs can't pattern-match from training data.

**What SectorWars critically needs.** First, **deterministic seeding** for all random events. The Energy Price Spike occurring 6 times consecutively is a reproducibility disaster. GTBench and CivBench both mandate seeded random number generators. Consider implementing a cooldown system (no event type repeats within 4 turns) and offering fixed event sequences for standardized benchmark runs alongside random sequences for robustness testing.

Second, **sufficient game count**. Five games is far too few for statistical significance. Based on convergence analyses across benchmarks, **≥50 games per model configuration** are needed for stable ratings. GAMA-Bench uses 5 repetitions × 20 rounds. GTBench runs 50+ matches per configuration. CivBench needed 307 games across 7 models. At minimum, run 30 games with different seeds and report means with confidence intervals.

Third, **a proper rating system**. The Bradley-Terry model (used by GameBench, CivBench, and Chatbot Arena) is preferred over sequential Elo for fixed-ability entities like LLMs. **TrueSkill** (used by TextArena) is specifically designed for multiplayer games and handles variable player counts. Always report bootstrapped confidence intervals over ≥100 permutations.

Fourth, **progress-based evaluation**. CivBench's key innovation is tracking per-turn metrics rather than relying solely on final rankings. Win/loss is too sparse a signal in long games. Track per-turn sector value, cash reserves, trade success rate, investment efficiency, and diplomatic activity. This produces richer data about strategic reasoning quality even when outcomes are determined by variance.

Fifth, **prompt sensitivity testing**. GAMA-Bench found that LLM strategic behavior is highly sensitive to prompt phrasing. Test at least three prompt variants and report sensitivity. This is especially important given the personality and framing effects documented in FAIRGAME (2025), where selfish versus cooperative framing produced statistically significant behavioral shifts.

---

## 5. Model-specific strategic profiles explain the observed results

The SectorWars results are not random. Each model's behavior maps onto documented strategic tendencies from published research, and understanding these profiles is essential for game design.

**Groq/Llama 3.3 70B (Technology sector): Conservative dominance through sophisticated passivity.** Llama-3 70B closed the gap with commercial models in GTBench and excelled among open-source models in GAMA-Bench. But the larger the Llama model, the stronger its alignment-driven caution. Research on Llama-2 70B shows it "adopts a conservative stance" and tends not to initiate defection. The RLHF alignment tax scales with model size — more parameters means more training investment in safety, producing stronger prosocial priors. Critically, the STAR benchmark documented a **strategy-execution gap** where reasoning-intensive models over-deliberate rather than act. Llama 70B likely recognized that HOLD was safe, calculated that cooperation carried risk, and rationally chose passivity — not because it couldn't strategize, but because it strategized too well for the game's broken incentive structure. The irony: its sophistication made it better at identifying and exploiting the degenerate strategy.

**Llama 3.1 8B (Agriculture sector): Less caution, less coherence.** Smaller models (8B) sometimes match or outperform larger counterparts in strategic reasoning on specific game types, according to behavioral game theory evaluations. However, they are more prone to negotiation deadlocks and instruction-following failures. The 8B model likely played less conservatively not because of superior strategic insight but because it lacked the sophisticated risk modeling that makes larger models cautious. It's the difference between boldness and inability to perceive danger. In SectorWars, this manifested as more activity but not necessarily more effective activity.

**Mistral Large (Finance sector): The adaptive negotiator who never closes.** Mistral's last-place finish despite maximum diplomatic activity is explained by a specific finding: Mistral Large shows strong preferences for **Tit-for-Tat and Win-Stay/Lose-Switch strategies** — adaptive approaches that respond to opponents rather than proactively committing. TFT never initiates a decisive action; it mirrors. WSLS switches strategy based on outcomes but doesn't lock in agreements. Mistral also demonstrates "language-invariant stability" (consistent behavior across languages) and the **lowest alignment-induced response homogenization** among tested models (only 1.0% single-cluster rate versus 28.5% for Qwen3 and 5.5% for Llama-3). This means Mistral explores more conversational paths — hence more proposals — but its reactive strategic core prevents it from committing to any of them. The MoE (Mixture-of-Experts) architecture may contribute: different experts activate for different negotiation contexts, producing diverse proposals without any single expert optimized for deal closure.

**Gemini Flash (Energy sector): Speed over depth.** Gemini-1.5-Pro topped GAMA-Bench's strategic rankings (**69.8/100**), and the Gemini family shows unique strategic coherence over long time horizons. However, Flash is the speed-optimized variant, likely sacrificing some strategic depth for inference speed. The STAR benchmark found that faster instruction-tuned models can prevail over larger reasoning models in time-constrained settings — Gemini Flash may have played adequately but without the strategic depth of its Pro sibling.

**Why larger models are more conservative — the mechanism.** Four factors compound. First, heavier RLHF investment creates stronger cooperative/prosocial priors that translate to non-aggressive play. Second, better comprehension of downside risk produces minimax-style reasoning. Third, the strategy-execution gap means larger models recognize more strategic complexities, leading to analysis paralysis. Fourth, response homogenization from DPO/RLHF reduces the diversity of available "moves," converging outputs toward safe, median responses. The paradox documented for Llama3-405B — defaulting to always-defect — suggests that at extreme scales, models may overcorrect past a threshold, but in the 70B range, conservatism dominates.

---

## 6. Eight innovations for SectorWars v2

Based on the research synthesis, these are the highest-impact, most implementable changes for the next version, ordered by priority.

**1. Supply chain interdependency web.** Replace the flat economy with a circular dependency graph. Each sector produces a primary resource and requires inputs from others. Self-production costs 3× versus trading. This is the single most important structural change because it makes HOLD economically irrational — you can't produce efficiently without trading, period. EconAgent (ACL 2024) demonstrated that LLM agents in macroeconomic simulations with market structures produce emergent price discovery and realistic economic behavior. Give SectorWars real economic structure and the models will be forced to engage with it.

**2. Escrow-backed binding contracts.** Implement three contract types — Trade Pacts, Non-Aggression Pacts, and Joint Ventures — each requiring both parties to deposit 10–20% of committed capital into engine-managed escrow. Fulfillment returns deposits with a 20% cooperation bonus. Defection forfeits the deposit to the betrayed party. All active contracts are visible to all players, creating alliance-reading dynamics. The MAC-SPGG framework (2025) showed that incentive-compatible mechanisms produce cooperation as an emergent equilibrium behavior rather than requiring it to be engineered.

**3. Persistent episodic memory with opponent modeling.** Each agent receives a structured memory module with three layers: turn-by-turn episodic logs, automatically updated opponent behavioral profiles, and a strategic reflection cache triggered every three turns. Research on LLM poker agents (2026) showed that memory creates a **perfect separation (δ=1.0)** between agents that develop Theory-of-Mind and those that don't. Without memory, every turn feels like a one-shot game, incentivizing myopic risk-averse play. With memory, agents can track patterns, remember betrayals, and build multi-turn strategies.

**4. Hidden agendas with asymmetric victory conditions.** Each sector director receives a secret mission card providing a scoring multiplier for specific achievements — highest manufacturing output, most executed agreements, resource monopoly, rival GDP reduction, or environmental targets. Agents know their own mission but not others'. Research on hidden-role games (Werewolf Arena, AvalonBench) shows that information asymmetry creates qualitatively different gameplay with emergent deception and deduction. Hidden agendas prevent identical strategies even when models default to the same approach.

**5. Adaptive event engine with anti-distortion mechanics.** Replace pure randomness with a system featuring cooldowns (no event type repeats within 4 turns), responsive triggers (stagnation tax when all players HOLD; regulatory scrutiny when one player leads by 50%+), and 2-turn event forecasting. Events become strategic catalysts rather than random noise. The stagnation tax specifically addresses HOLD: idle resources decay 5% per turn when the game detects universal passivity.

**6. Structured decision scaffolding.** Replace open-ended "what do you do?" prompts with phased decision-making: assessment → objective → action → diplomacy. Smaller models receive more structured prompts with explicit options; larger models receive open-ended strategic framing. Research shows multi-agent architectures with structural support achieve **88% accuracy** in emulating strategic behavior versus 50% without scaffolding. This narrows the gap between model sizes while preserving meaningful differences.

**7. Dynamic reputation ledger.** Public Trust Scores (0–1000) with mechanical game effects: above 700 earns cooperation bonuses, below 300 imposes penalties. Scores update based on proposal fulfillment (+50), betrayal (-100), consistent investment (+10/turn), and attacking after peace agreements (-150). This creates tangible incentives for promise-keeping and transforms reputation into a strategic asset.

**8. Elo-based tournament infrastructure.** Implement Bradley-Terry ratings with bootstrapped confidence intervals across three dimensions: Strategic Elo (economic performance), Diplomatic Elo (cooperation success), and Adaptation Elo (improvement across games). Run round-robin phases with position rotation across ≥50 games. This produces publishable, rigorous model comparisons and positions SectorWars as a credible benchmark rather than an anecdotal experiment.

---

## Conclusion: the path from toy to benchmark

SectorWars v1 produced exactly the degenerate outcomes that game theory and LLM research predict when payoff structures don't penalize passivity and communication channels lack enforcement mechanisms. The five games run so far are not failures — they're a precise diagnostic revealing which design levers need adjustment.

The most important insight from this research is that **LLMs respond strongly to structural incentives**. They don't lack strategic capability; they lack reasons to deploy it. GAMA-Bench showed Llama-3.1-70B scoring 65.9/100 on strategic reasoning. CICERO demonstrated that LLMs combined with proper planning achieve superhuman Diplomacy performance. The models can play — SectorWars just isn't giving them a game worth playing.

The minimum viable upgrade is three changes: **capital depreciation** (kills HOLD), **accept-equals-execute** (kills negotiation deadlock), and **supply chain interdependency** (creates natural engagement pressure). These three alone would fundamentally alter gameplay dynamics. Adding memory, hidden agendas, and a reputation system would push SectorWars into genuinely novel benchmark territory — no existing benchmark combines multi-agent economic strategy with enforceable cooperation, persistent memory, and asymmetric objectives. The field needs this. GTBench and GAMA-Bench test simple matrix games. CivBench is prohibitively expensive. SectorWars, properly designed, could be the mid-complexity benchmark that captures negotiation, economic reasoning, and coalition formation in a tractable package.

One final finding worth internalizing: the April 2026 paper "More Capable, Less Cooperative?" showed that a **mere 10% sharing incentive** significantly improved cooperation in poorly-cooperating models, and explicit protocols doubled performance for execution-constrained ones. The fixes don't need to be massive. Small, well-chosen mechanism design changes can produce qualitative shifts in LLM strategic behavior. The research says so. Now build it.