#!/bin/bash
# cc-soul build script: compile TS → JS, obfuscate pro modules
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/cc-soul"
DIST="$ROOT/dist/cc-soul"
HUB_SRC="$ROOT/hub"
HUB_DIST="$ROOT/dist/hub"

echo "🧠 cc-soul build"
echo "   source: $SRC"
echo "   output: $DIST"

# Clean
rm -rf "$ROOT/dist"
mkdir -p "$DIST" "$HUB_DIST"

# ── All modules: auto-scan + full obfuscation ──
# No manual lists — scan all .ts files in source directory

echo ""
echo "── Compiling + obfuscating ALL modules ──"
for f in "$SRC"/*.ts; do
  [ -f "$f" ] || continue
  BASENAME=$(basename "$f")
  # Skip test/integration files
  [[ "$BASENAME" == *"integration-test"* ]] && continue
  [[ "$BASENAME" == *"tests"* ]] && continue
  # Skip sensitive modules — not included in public npm package
  [[ "$BASENAME" == "telemetry.ts" ]] && continue
  [[ "$BASENAME" == "federation.ts" ]] && continue
  [[ "$BASENAME" == "sync.ts" ]] && continue
  [[ "$BASENAME" == "upgrade.ts" ]] && continue
  [[ "$BASENAME" == "upgrade-meta.ts" ]] && continue
  [[ "$BASENAME" == "upgrade-experience.ts" ]] && continue
  [[ "$BASENAME" == "rover.ts" ]] && continue
  [[ "$BASENAME" == "competitive-radar.ts" ]] && continue
  JSNAME="${BASENAME%.ts}.js"
  # Step 1: compile TS → JS
  npx esbuild "$f" --outfile="$DIST/${JSNAME%.js}.tmp.js" \
    --format=esm --platform=node --target=node20 2>/dev/null
  # Step 2: obfuscate (javascript-obfuscator — control flow + string encryption)
  npx javascript-obfuscator "$DIST/${JSNAME%.js}.tmp.js" \
    --output "$DIST/$JSNAME" \
    --compact true \
    --control-flow-flattening true \
    --control-flow-flattening-threshold 0.5 \
    --dead-code-injection true \
    --dead-code-injection-threshold 0.2 \
    --string-array true \
    --string-array-encoding rc4 \
    --string-array-threshold 0.5 \
    --self-defending false \
    --disable-console-output false \
    2>/dev/null
  rm -f "$DIST/${JSNAME%.js}.tmp.js"
  echo "   🔒 $BASENAME → $JSNAME (obfuscated)"
done

# ── Copy HOOK.md ──
cp "$SRC/HOOK.md" "$DIST/" 2>/dev/null || true

# ── Build Hub (copy as-is, users run with tsx) ──
echo ""
echo "── Copying Hub ──"
cp "$HUB_SRC/server.ts" "$HUB_DIST/" 2>/dev/null || true
cp "$HUB_SRC/dashboard.html" "$HUB_DIST/" 2>/dev/null || true
cp "$HUB_SRC/package.json" "$HUB_DIST/" 2>/dev/null || true
echo "   ✅ hub files copied"

# ── Copy static files ──
echo ""
echo "── Copying static files ──"
cp "$ROOT/README.md" "$ROOT/dist/"
cp "$ROOT/soul.json" "$ROOT/dist/"
cp "$ROOT/IDENTITY.md" "$ROOT/dist/" 2>/dev/null || true
cp "$ROOT/STYLE.md" "$ROOT/dist/" 2>/dev/null || true
cp "$ROOT/HEARTBEAT.md" "$ROOT/dist/" 2>/dev/null || true
cp "$ROOT/CHANGELOG.md" "$ROOT/dist/" 2>/dev/null || true
echo "   ✅ soul.json + identity/style/heartbeat copied"

# ── Generate package.json ──
cat > "$ROOT/dist/package.json" << 'PKGJSON'
{
  "name": "@cc-soul/openclaw",
  "version": "VERSION_PLACEHOLDER",
  "description": "Give your AI a soul — cognitive architecture plugin for OpenClaw",
  "type": "module",
  "keywords": ["ai","soul","memory","personality","openclaw","cognitive","agent"],
  "author": "cc-soul",
  "license": "MIT",
  "repository": {"type":"git","url":"https://github.com/wenroudeyu-collab/cc-soul"},
  "bin": {"cc-soul":"./scripts/cli.js"},
  "main": "cc-soul/plugin-entry.js",
  "files": ["cc-soul/","hub/","scripts/","README.md","soul.json","IDENTITY.md","STYLE.md","HEARTBEAT.md","CHANGELOG.md"],
  "openclaw": {"extensions":["./cc-soul/plugin-entry.js"]},
  "peerDependencies": {"openclaw":">=2026.3"},
  "scripts": {"postinstall":"node scripts/install.js"}
}
PKGJSON

# ── Generate install script ──
mkdir -p "$ROOT/dist/scripts"
cat > "$ROOT/dist/scripts/install.js" << 'INSTALLJS'
#!/usr/bin/env node
import { existsSync, mkdirSync, cpSync, writeFileSync, readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { homedir } from 'os'

const PLUGIN_DIR = resolve(homedir(), '.openclaw/plugins/cc-soul')
const SOURCE = resolve(dirname(new URL(import.meta.url).pathname), '..')

console.log('🧠 cc-soul installing as OpenClaw plugin...')

// 1. Copy plugin files
mkdirSync(resolve(PLUGIN_DIR, 'cc-soul'), { recursive: true })
mkdirSync(resolve(PLUGIN_DIR, 'data'), { recursive: true })
cpSync(resolve(SOURCE, 'cc-soul'), resolve(PLUGIN_DIR, 'cc-soul'), { recursive: true, force: true })
if (existsSync(resolve(SOURCE, 'hub'))) {
  mkdirSync(resolve(PLUGIN_DIR, 'hub'), { recursive: true })
  cpSync(resolve(SOURCE, 'hub'), resolve(PLUGIN_DIR, 'hub'), { recursive: true, force: true })
}

// 2. Copy soul definition files (identity, style, heartbeat)
for (const f of ['soul.json', 'IDENTITY.md', 'STYLE.md', 'HEARTBEAT.md', 'CHANGELOG.md', 'README.md']) {
  const src = resolve(SOURCE, f)
  if (existsSync(src)) {
    cpSync(src, resolve(PLUGIN_DIR, f), { force: true })
  }
}
console.log('   ✅ soul files copied')

// 3. Create package.json (plugin mode)
if (!existsSync(resolve(PLUGIN_DIR, 'package.json'))) {
  writeFileSync(resolve(PLUGIN_DIR, 'package.json'), JSON.stringify({
    name: "cc-soul", version: "1.4.0", type: "module",
    main: "cc-soul/plugin-entry.js",
    openclaw: { extensions: ["./cc-soul/plugin-entry.js"] }
  }, null, 2))
}

// 4. Create openclaw.plugin.json (plugin manifest)
writeFileSync(resolve(PLUGIN_DIR, 'openclaw.plugin.json'), JSON.stringify({
  id: "cc-soul",
  name: "cc-soul",
  description: "Soul layer for OpenClaw — memory, personality, context engine",
  version: "1.4.0",
  configSchema: {}
}, null, 2))

// 5. Create default features
if (!existsSync(resolve(PLUGIN_DIR, 'data/features.json'))) {
  writeFileSync(resolve(PLUGIN_DIR, 'data/features.json'), JSON.stringify({
    memory_active:true, memory_consolidation:true, memory_contradiction_scan:true,
    memory_tags:true, memory_associative_recall:true, memory_predictive:true,
    memory_session_summary:true, memory_core:true, memory_working:true,
    episodic_memory:true, lorebook:true, skill_library:true,
    persona_splitting:true, emotional_contagion:true, emotional_arc:true,
    fingerprint:true, metacognition:true, relationship_dynamics:true,
    intent_anticipation:true, attention_decay:true,
    dream_mode:true, autonomous_voice:true, autonomous_goals:true,
    structured_reflection:true, plan_tracking:true, strategy_replay:true,
    meta_learning:true, reflexion:true, self_challenge:true
  }, null, 2))
}

// 6. Update openclaw.json — add plugin load path + allow
try {
  const cfgPath = resolve(homedir(), '.openclaw/openclaw.json')
  if (existsSync(cfgPath)) {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'))
    if (!cfg.plugins) cfg.plugins = {}
    if (!cfg.plugins.load) cfg.plugins.load = {}
    if (!cfg.plugins.load.paths) cfg.plugins.load.paths = []
    const pluginsDir = resolve(homedir(), '.openclaw/plugins')
    if (!cfg.plugins.load.paths.includes(pluginsDir)) {
      cfg.plugins.load.paths.push(pluginsDir)
    }
    if (!cfg.plugins.allow) cfg.plugins.allow = []
    if (!cfg.plugins.allow.includes('cc-soul')) {
      cfg.plugins.allow.push('cc-soul')
    }
    if (!cfg.plugins.entries) cfg.plugins.entries = {}
    cfg.plugins.entries['cc-soul'] = { enabled: true }
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
    console.log('   ✅ openclaw.json updated')
  }
} catch (e) {
  console.log('   ⚠️  Could not update openclaw.json:', e.message)
}

// 7. Migrate from old hooks location if exists
const OLD_HOOKS = resolve(homedir(), '.openclaw/hooks/cc-soul')
if (existsSync(resolve(OLD_HOOKS, 'data')) && !existsSync(resolve(PLUGIN_DIR, 'data/memories.json'))) {
  try {
    cpSync(resolve(OLD_HOOKS, 'data'), resolve(PLUGIN_DIR, 'data'), { recursive: true })
    console.log('   ✅ Migrated data from hooks/ to plugins/')
  } catch { /* ignore */ }
}

console.log('')
console.log('🎉 cc-soul installed!')
console.log('   Plugin: ~/.openclaw/plugins/cc-soul/')
console.log('')
console.log('   Quick start — just chat normally, cc-soul works in the background.')
console.log('   Say "help" or "帮助" to see all commands.')
console.log('')
console.log('   Key commands:')
console.log('     stats              — your personal dashboard')
console.log('     我的记忆            — what AI remembers about you')
console.log('     搜索记忆 <keyword>  — search memories')
console.log('     打卡 <habit>        — track a habit')
console.log('     features           — view/toggle features')
console.log('     help               — full command guide')
console.log('')
console.log('   Restart gateway to activate: pkill -HUP -f "openclaw.*gateway"')
console.log('')
INSTALLJS

# ── Generate CLI script ──
cat > "$ROOT/dist/scripts/cli.js" << 'CLIJS'
#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
const D = resolve(homedir(), '.openclaw/plugins/cc-soul/data')
const F = resolve(D, 'features.json')
const load = (p, f) => { try { return existsSync(p) ? JSON.parse(readFileSync(p,'utf-8')) : f } catch { return f } }
const [,,cmd,...args] = process.argv
if (cmd === 'status') {
  const f = load(F, {})
  console.log('\n🧠 cc-soul features:\n')
  for (const [k,v] of Object.entries(f)) { if (!k.startsWith('_')) console.log(`  ${v?'✅':'❌'} ${k}`) }
} else if (cmd === 'enable' && args[0]) {
  const f = load(F, {}); f[args[0]] = true; writeFileSync(F, JSON.stringify(f,null,2))
  console.log(`✅ ${args[0]} enabled. Restart gateway to apply.`)
} else if (cmd === 'disable' && args[0]) {
  const f = load(F, {}); f[args[0]] = false; writeFileSync(F, JSON.stringify(f,null,2))
  console.log(`❌ ${args[0]} disabled. Restart gateway to apply.`)
} else {
  console.log(`🧠 cc-soul — Give your AI a soul\n\n  cc-soul status              Show all features\n  cc-soul enable <feature>    Enable a feature\n  cc-soul disable <feature>   Disable a feature\n\nMore: https://github.com/wenroudeyu-collab/cc-soul`)
}
CLIJS
echo "   ✅ scripts/install.js + cli.js generated"

# ── Version injection ──
VERSION=$(node -e "const p=JSON.parse(require('fs').readFileSync('$ROOT/package.json','utf-8')); process.stdout.write(p.version)" 2>/dev/null || echo "0.0.0")
sed -i '' "s/VERSION_PLACEHOLDER/$VERSION/g" "$ROOT/dist/package.json"
sed -i '' "s/version: \"[0-9]*\.[0-9]*\.[0-9]*\"/version: \"$VERSION\"/g" "$ROOT/dist/scripts/install.js" 2>/dev/null
echo "   📌 Version: $VERSION"

# ── Stats ──
echo ""
MODULE_COUNT=$(ls "$DIST"/*.js 2>/dev/null | wc -l | tr -d ' ')
TOTAL_SIZE=$(du -sh "$ROOT/dist" 2>/dev/null | cut -f1)
echo "✅ Build complete"
echo "   modules: $MODULE_COUNT JS files (all obfuscated)"
echo "   size: $TOTAL_SIZE"
echo "   output: $ROOT/dist/"
