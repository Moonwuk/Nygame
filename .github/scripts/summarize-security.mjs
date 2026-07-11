#!/usr/bin/env node
// Aggregates every scanner's output (SARIF + pnpm-audit + TruffleHog NDJSON + per-tool
// status sentinels) from a directory tree into one Markdown report.
// Pure Node (no external deps — avoids the unpinned-install supply-chain vector).
//   node .github/scripts/summarize-security.mjs <inputDir> <outFile>
//
// TRUST: the report LEADS with a scan-confirmation table built from per-job status
// sentinels (`status-<key>.json`, written AFTER each scan with the real exit/outcome).
// A scanner that silently fails (docker pull error swallowed by the step) leaves no
// confirmed sentinel → it is flagged "⚠️ scan NOT confirmed", never a quiet "0".
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const inputDir = process.argv[2] ?? 'reports';
const outFile = process.argv[3] ?? 'security-report.md';
const sha = (process.env.GITHUB_SHA ?? '').slice(0, 7);
const ref = process.env.GITHUB_REF_NAME ?? '';
const runUrl =
  process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : '';

// Each entry is a distinct diversity axis (method / source / surface), not a clone.
const EXPECTED = [
  { key: 'semgrep', name: 'Semgrep — SAST (паттерны)' },
  { key: 'codeql', name: 'CodeQL — SAST (data-flow/taint)' },
  { key: 'gitleaks', name: 'Gitleaks — секреты (дерево)' },
  { key: 'trufflehog', name: 'TruffleHog — секреты (история + верификация)' },
  { key: 'osv', name: 'OSV-Scanner — SCA (osv.dev)' },
  { key: 'audit', name: 'pnpm audit — SCA (GHSA)' },
  { key: 'trivy-fs', name: 'Trivy fs — vuln/secret/IaC' },
  { key: 'trivy-image', name: 'Trivy image — базовая ОС образа' },
  { key: 'zizmor', name: 'zizmor — безопасность workflow' },
  { key: 'scorecard', name: 'OpenSSF Scorecard — постура', mainOnly: true },
  { key: 'sbom', name: 'Syft — SBOM (CycloneDX)' },
];

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const LEVELS = ['error', 'warning', 'note', 'none'];
const ICON = { error: '🔴', warning: '🟠', note: '🔵', none: '⚪' };
const RANK = { error: 3, warning: 2, note: 1, none: 0 };
const norm = (lvl) => (LEVELS.includes(lvl) ? lvl : 'warning');

const files = walk(inputDir);
const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

// --- per-tool status sentinels (the fail-open detector) ---
const sentinels = new Map(); // key -> { ok, exit? }
for (const f of files.filter(
  (f) => /(^|\/)status-[^/]+\.json$/.test(f) || /^status-/.test(basename(f)),
)) {
  const s = readJson(f);
  if (s && typeof s.key === 'string') sentinels.set(s.key, s);
}

// --- SARIF findings ---
const perTool = new Map();
const totals = { error: 0, warning: 0, note: 0, none: 0 };
const findings = [];
const sarifTools = new Set();
const toolOf = (name) => {
  if (!perTool.has(name)) perTool.set(name, { error: 0, warning: 0, note: 0, none: 0 });
  return perTool.get(name);
};
for (const f of files.filter((f) => f.endsWith('.sarif') || f.endsWith('.sarif.json'))) {
  const data = readJson(f);
  if (!data) continue;
  for (const run of data.runs ?? []) {
    const name = run.tool?.driver?.name ?? 'Unknown';
    sarifTools.add(name);
    for (const r of run.results ?? []) {
      const level = norm(r.level);
      toolOf(name)[level]++;
      totals[level]++;
      const loc = r.locations?.[0]?.physicalLocation;
      findings.push({
        tool: name,
        level,
        rule: r.ruleId ?? '',
        path: loc?.artifactLocation?.uri ?? '',
        line: loc?.region?.startLine ?? '',
        msg: (r.message?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 140),
      });
    }
  }
}

// --- TruffleHog NDJSON (one finding per line; .Verified marks a live credential) ---
const thFile = files.find((f) => /(^|\/)trufflehog\.json$/.test(f));
if (thFile) {
  let verified = 0;
  let unverified = 0;
  for (const line of readFileSync(thFile, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    if (o.DetectorName === undefined && o.SourceMetadata === undefined) continue;
    const isV = o.Verified === true;
    if (isV) verified++;
    else unverified++;
    const level = isV ? 'error' : 'note';
    toolOf('TruffleHog')[level]++;
    totals[level]++;
    findings.push({
      tool: 'TruffleHog',
      level,
      rule: String(o.DetectorName ?? 'secret') + (isV ? ' (VERIFIED)' : ''),
      path: '',
      line: '',
      msg: isV ? 'Verified live credential' : 'Unverified potential secret',
    });
  }
  if (verified || unverified) sarifTools.add('TruffleHog');
}

// --- pnpm audit ---
let auditLine = '_не запускался_';
const auditFile = files.find((f) => /pnpm-audit\.json$/.test(f));
if (auditFile) {
  const a = readJson(auditFile);
  const v = a?.metadata?.vulnerabilities ?? {};
  const total =
    (v.critical ?? 0) + (v.high ?? 0) + (v.moderate ?? 0) + (v.low ?? 0) + (v.info ?? 0);
  auditLine =
    a == null
      ? '⚠️ отчёт нечитаем'
      : total === 0
        ? '✅ 0 уязвимостей'
        : `🔴 critical ${v.critical ?? 0} · 🟠 high ${v.high ?? 0} · moderate ${v.moderate ?? 0} · low ${v.low ?? 0}`;
}

// --- pnpm run check ---
let checkLine = '_неизвестно_';
const checkFile = files.find((f) => /check-status\.json$/.test(f));
if (checkFile) {
  const o = readJson(checkFile)?.check;
  if (o) checkLine = o === 'success' ? '✅ зелёный (lint+typecheck+test)' : `⚠️ ${o}`;
}

const sboms = files.filter((f) => /\.cdx\.json$/i.test(f)).map((f) => basename(f));

// --- scan-confirmation (fail-open detector) ---
const isMain = ref === 'main';
const confirm = EXPECTED.map((t) => {
  const s = sentinels.get(t.key);
  // Confirmed if the job wrote a sentinel with ok=true. Defensive fallback: a tool
  // whose SARIF is present with a driver counts as confirmed even without a sentinel.
  const ok =
    (s && s.ok === true) ||
    (!s && t.key === 'sbom' && sboms.length > 0) ||
    (!s && t.key === 'audit' && auditFile != null);
  // A main-only job (Scorecard) that's absent off `main` was SKIPPED by design —
  // not a fail-open, so it must not raise the "NOT confirmed" alarm.
  let state;
  if (ok) state = 'ok';
  else if (t.mainOnly && !isMain && !s) state = 'skipped';
  else state = 'bad';
  return { ...t, state };
});
const okCount = confirm.filter((c) => c.state === 'ok').length;
const skipped = confirm.filter((c) => c.state === 'skipped');
const bad = confirm.filter((c) => c.state === 'bad');

findings.sort((a, b) => RANK[b.level] - RANK[a.level] || a.tool.localeCompare(b.tool));
const CAP = 30;

const L = [];
L.push('## 🛡️ Security scan — сводный отчёт');
L.push('');
L.push(
  `**Коммит:** \`${sha || '—'}\`${ref ? ` · **ветка:** \`${ref}\`` : ''}${runUrl ? ` · [лог прогона](${runUrl})` : ''}`,
);
L.push('');

// TRUST FIRST: did every scanner actually run?
L.push(
  `### 🔎 Подтверждение сканов — ${okCount}/${EXPECTED.length}${skipped.length ? ` (+${skipped.length} пропущено)` : ''}`,
);
if (bad.length) {
  L.push('');
  L.push(
    `> **⚠️ ВНИМАНИЕ: ${bad.length} скан(ов) НЕ подтверждены** — отчёт по ним нельзя считать «чисто». Не доверяй «0 находок» от них. См. лог прогона.`,
  );
}
L.push('');
L.push('| Сканер | Подтверждён |');
L.push('| --- | --- |');
const CELL = {
  ok: '✅ просканировано',
  skipped: '⏭ пропущено (только на main)',
  bad: '⚠️ **НЕ подтверждён**',
};
for (const c of confirm) L.push(`| ${c.name} | ${CELL[c.state]} |`);
L.push('');

L.push('| Серьёзность | Σ |');
L.push('| --- | --: |');
for (const l of LEVELS) L.push(`| ${ICON[l]} ${l} | ${totals[l]} |`);
L.push('');
L.push(`**pnpm run check:** ${checkLine}  `);
L.push(`**pnpm audit:** ${auditLine}  `);
L.push(`**SBOM (CycloneDX):** ${sboms.length ? `✅ ${sboms.join(', ')}` : '—'}`);
L.push('');

if (perTool.size) {
  L.push('### По инструментам');
  L.push('| Инструмент | 🔴 | 🟠 | 🔵 |');
  L.push('| --- | --: | --: | --: |');
  for (const [name, c] of [...perTool.entries()].sort())
    L.push(`| ${name} | ${c.error} | ${c.warning} | ${c.note} |`);
  L.push('');
}

if (findings.length) {
  L.push(`### Находки (топ ${Math.min(CAP, findings.length)} из ${findings.length})`);
  L.push('| | Инструмент | Правило | Где | Сообщение |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const f of findings.slice(0, CAP)) {
    const where = f.path ? `\`${f.path}${f.line ? ':' + f.line : ''}\`` : '—';
    L.push(
      `| ${ICON[f.level]} | ${f.tool} | \`${f.rule}\` | ${where} | ${f.msg.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')} |`,
    );
  }
  if (findings.length > CAP)
    L.push(`\n_…и ещё ${findings.length - CAP}. Полные SARIF — в артефактах прогона._`);
  L.push('');
} else {
  L.push(
    '_Сканеры не вернули находок (см. таблицу подтверждения выше — «0» значимо только для подтверждённых)._',
  );
  L.push('');
}

L.push('---');
L.push(
  'ℹ️ _Блокирующие сканеры (SEC-1): Semgrep, Gitleaks, OSV, Trivy fs/image — находка или сбой скана валит их джобу; остальные (CodeQL, TruffleHog, zizmor, Scorecard) — информационные. Разные движки/источники — для перекрёстной валидации; «0» достоверно только у подтверждённых сканеров. Полные SARIF/SBOM — в артефактах прогона._',
);

writeFileSync(outFile, L.join('\n'));
process.stdout.write(L.join('\n') + '\n');
