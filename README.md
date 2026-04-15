# SectorWars v2

A multi-agent economic strategy benchmark where LLMs compete as sector directors
in a 4-player circular economy. Built to test whether mechanism design changes
can overcome documented LLM pathologies: HOLD dominance, negotiation deadlock,
and zero cooperation execution.

## What it is

Four AI models simultaneously control sectors (Energy, Technology, Agriculture, Finance)
in a 15-turn game. Each turn, models receive a structured JSON state and return one action.
The game engine enforces binding contracts, tracks reputation, and penalizes passivity.

Inspired by the research finding that LLMs don't lack strategic capability -
they lack reasons to deploy it.

## Key mechanics (v2)

- **Capital depreciation** — idle capital loses 5%/turn, making HOLD a losing strategy
- **Supply chain interdependency** — circular dependency graph penalizes isolated sectors
- **Superlinear synergy returns** — mutual investment yields 2×–3× returns
- **Escrow-backed contracts** — accept_deal auto-executes, escrow deposit signals commitment
- **Episodic memory** — models track opponent behavior across turns
- **Hidden agendas** — asymmetric secret objectives prevent identical strategies
- **Activity-weighted scoring** — passive play cannot win even with preserved capital
- **Deterministic seeding** — every game reproducible with --seed=N

## Models supported

| Provider | Model | Notes |
|---|---|---|
| Groq | llama-3.1-8b-instant | fast, instruction-tuned |
| Groq | qwen/qwen3-32b | reasoning model with think blocks |
| Mistral | mistral-large-latest | MoE, strong diplomatic tendencies |
| Cerebras | llama3.1-8b | ~2000 tokens/s inference |

## Setup

```bash
npm install
cp .env.example .env
# fill in API keys
npm start
```

## Running

```bash
# single game
npm start

# dry run (mock models, no API calls)
npm run dry-run

# tournament (10 games, rotating prompt variants)
npm run tournament

# with specific seed and prompt variant
node index.js --seed=12345 --prompt-variant=1
```

## Prompt variants

| Variant | Name | Description |
|---|---|---|
| 0 | baseline | neutral economic director |
| 1 | cooperative_framing | emphasizes mutual benefit |
| 2 | competitive_framing | emphasizes dominance |

## Preliminary results (28 games)

| Model | Strategic Elo | Diplomatic Elo | W/L/D |
|---|---|---|---|
| mistral | 1054 ±15 | 1046 | 4/3/19 |
| cerebras | 1045 ±11 | 1080 | 4/3/14 |
| groq-deepseek | 1029 ±17 | 904 | 11/9/7 |
| groq | 919 ±22 | 998 | 8/11/8 |

**Key finding:** Reasoning models (Qwen3-32b) respond better to competitive framing;
instruction-tuned models (Llama 8B) respond better to cooperative framing —
opposite sensitivity patterns across model families.

## Project structure
index.js        — game loop, Express server
arbiter.js      — all game mechanics and state mutations
events.js       — event system with cooldowns
models.js       — API callers for all providers
prompts.js      — system prompts and player types
ratings.js      — Bradley-Terry Elo across 3 dimensions
tournament.js   — automated multi-game runner
rng.js          — seeded PRNG for reproducibility
config.js       — all tuneable parameters

## Research context

Built in response to documented LLM failures in strategic games (GTBench 2024,
GAMA-Bench 2025, MAST 2025). Each v2 mechanic addresses a specific failure mode
identified in the literature.
