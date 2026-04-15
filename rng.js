'use strict';

// Mulberry32 — fast seeded PRNG with good distribution.
// Returns floats in [0, 1) like Math.random().
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = seed + 0x6d2b79f5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

let _rand = Math.random.bind(Math); // default: unseeded (random behavior)
let _current_seed = null;

function seed(s) {
  _current_seed = s;
  _rand = mulberry32(s);
}

function rand() {
  return _rand();
}

function getCurrentSeed() {
  return _current_seed;
}

// Seed from CLI arg --seed=N or env GAME_SEED=N.
// Call once at startup before any rand() calls.
function initFromEnv() {
  const cli_arg = process.argv.find((a) => a.startsWith('--seed='));
  if (cli_arg) {
    const n = parseInt(cli_arg.split('=')[1], 10);
    if (!isNaN(n)) { seed(n); return n; }
  }
  const env_seed = process.env.GAME_SEED;
  if (env_seed) {
    const n = parseInt(env_seed, 10);
    if (!isNaN(n)) { seed(n); return n; }
  }
  // No seed provided — use random seed, log it for reproducibility
  const random_seed = Math.floor(Math.random() * 2 ** 32);
  seed(random_seed);
  return random_seed;
}

module.exports = { seed, rand, getCurrentSeed, initFromEnv };
