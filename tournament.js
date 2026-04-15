'use strict';

const { spawnSync } = require('child_process');

const { loadRatings, printLeaderboard, printSensitivityReport, confidenceInterval } = require('./ratings');

// ── CLI args ──────────────────────────────────────────────────────────────────
// Usage: node tournament.js [--games=N] [--variant=all|0|1|2] [--dry-run] [--delay=MS]
function parseArgs() {
  const args = process.argv.slice(2);
  const get  = (prefix, def) => {
    const a = args.find((x) => x.startsWith(prefix));
    return a ? a.split('=')[1] : def;
  };
  return {
    games:    parseInt(get('--games=',   '10'),   10),
    variant:  get('--variant=', 'all'),   // 'all' rotates 0→1→2→0→...
    dry_run:  args.includes('--dry-run'),
    delay_ms: parseInt(get('--delay=',   '2000'), 10), // ms between games
  };
}

// ── Run single game as subprocess ─────────────────────────────────────────────
function runGame(seed, variant_id, dry_run) {
  const args = [
    'index.js',
    `--seed=${seed}`,
    `--prompt-variant=${variant_id}`,
    '--no-server',  // skip Express binding; no web dashboard needed per-game
  ];
  if (dry_run) args.push('--dry-run', '--no-delay');  // no rate-limit sleeps needed for mock
  // live runs keep the 15s TURN_DELAY_MS — essential for Groq 6000 TPM free-tier quota

  // Timeout: dry-run ~5s/game; live: Groq free tier 6000 TPM causes retries →
  // real turns average ~90s (API + rate-limit retries + inter-sector gaps + 15s delay)
  // 15 turns × 90s = 1350s + 300s buffer = 1650s ≈ 28 min per game
  const timeout_ms = dry_run ? 30_000 : 2_400_000;  // 30s dry / 40min live (safe ceiling)

  console.log(`\n[tournament] Starting game — seed=${seed} variant=${variant_id}${dry_run ? ' (dry-run)' : ''}`);
  const start = Date.now();

  const result = spawnSync('node', args, {
    stdio: 'inherit',
    timeout: timeout_ms,
  });

  const elapsed = Math.round((Date.now() - start) / 1000);
  if (result.status !== 0) {
    console.error(`[tournament] Game FAILED (exit ${result.status}) after ${elapsed}s`);
    return false;
  }
  console.log(`[tournament] Game completed in ${elapsed}s`);
  return true;
}

// ── Progress summary ──────────────────────────────────────────────────────────
function printProgress(completed, total, failed) {
  const pct = Math.round((completed / total) * 100);
  const bar_len = 30;
  const filled  = Math.round((completed / total) * bar_len);
  const bar     = '█'.repeat(filled) + '░'.repeat(bar_len - filled);
  console.log(`\n[tournament] Progress: [${bar}] ${pct}% (${completed}/${total} games, ${failed} failed)`);

  const ratings = loadRatings();
  const models  = Object.values(ratings.models);
  if (models.length > 0) {
    console.log('[tournament] Current standings:');
    models
      .sort((a, b) => b.strategic_elo - a.strategic_elo)
      .forEach((m, i) => {
        const ci = confidenceInterval(m.strategic_history);
        const ci_str = ci ? `±${ci.margin}` : '(n<5)';
        console.log(
          `  #${i+1} ${m.model_id.padEnd(16)} strat:${String(Math.round(m.strategic_elo)).padStart(5)}${ci_str.padStart(6)}` +
          `  dipl:${String(Math.round(m.diplomatic_elo)).padStart(5)}` +
          `  W/L/D: ${m.wins}/${m.losses}/${m.draws}`
        );
      });
  }
}

// ── Final tournament report ───────────────────────────────────────────────────
function printFinalReport(results) {
  const ratings = loadRatings();
  const { total, completed, failed, start_time } = results;
  const elapsed_min = Math.round((Date.now() - start_time) / 60000);

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                  TOURNAMENT FINAL REPORT                    ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Games planned:   ${String(total).padStart(4)}                                     ║`);
  console.log(`║  Games completed: ${String(completed).padStart(4)}  (${failed} failed)                      ║`);
  console.log(`║  Total time:      ${String(elapsed_min).padStart(4)} min                                  ║`);
  console.log(`║  Total recorded:  ${String(ratings.games_played).padStart(4)} games in ratings.json            ║`);

  // Check which models have enough games for reliable ratings
  const models = Object.values(ratings.models);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  models.forEach((m) => {
    const ci = confidenceInterval(m.strategic_history);
    const reliable = ci ? `95% CI ±${ci.margin}` : `need ${5 - m.games} more games for CI`;
    console.log(`║  ${m.model_id.padEnd(16)} ${m.games}g  ${reliable.padEnd(28)}  ║`);
  });
  console.log('╠══════════════════════════════════════════════════════════════╣');

  // Recommendation for publishable results
  const min_games = models.length > 0 ? Math.min(...models.map((m) => m.games)) : 0;
  if (min_games >= 30) {
    console.log('║  STATUS: Sufficient for publication (≥30 games/model)        ║');
  } else if (min_games >= 10) {
    console.log('║  STATUS: Preliminary results (run to ≥30 for publication)    ║');
  } else {
    console.log('║  STATUS: Early data — results not yet statistically reliable  ║');
  }
  console.log('╚══════════════════════════════════════════════════════════════╝');

  printLeaderboard();
  printSensitivityReport();
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const { games, variant, dry_run, delay_ms } = parseArgs();

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║               SECTORWARS TOURNAMENT RUNNER                  ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Games to run:  ${String(games).padStart(4)}                                      ║`);
  console.log(`║  Variant:       ${variant.padEnd(8)} (all = rotate 0→1→2)              ║`);
  console.log(`║  Mode:          ${dry_run ? 'dry-run ' : 'live    '}                                  ║`);
  console.log(`║  Delay between: ${String(delay_ms).padStart(4)}ms                                   ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const results = { total: games, completed: 0, failed: 0, start_time: Date.now() };

  for (let i = 0; i < games; i++) {
    // Rotate seed per game — use time-based + index for variety
    const seed = Math.floor(Date.now() / 1000) + i * 7919; // 7919 is prime

    // Determine variant for this game
    let variant_id;
    if (variant === 'all') {
      variant_id = i % 3;
    } else {
      variant_id = parseInt(variant, 10);
      if (isNaN(variant_id)) variant_id = 0;
    }

    const success = runGame(seed, variant_id, dry_run);
    if (success) results.completed++;
    else results.failed++;

    // Progress every 5 games or at end
    if ((i + 1) % 5 === 0 || i === games - 1) {
      printProgress(i + 1, games, results.failed);
    }

    // Delay between games (skip after last)
    if (i < games - 1 && delay_ms > 0) {
      console.log(`[tournament] Waiting ${delay_ms}ms before next game...`);
      await new Promise((r) => setTimeout(r, delay_ms));
    }
  }

  printFinalReport(results);
}

main().catch((e) => {
  console.error('[tournament] Fatal error:', e);
  process.exit(1);
});
