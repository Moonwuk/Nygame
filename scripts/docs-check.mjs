// scripts/docs-check.mjs — `pnpm run docs-check`: целостность графа знаний в docs/.
//
// docs/ — это и есть граф знаний проекта (сотни перекрёстных ссылок между
// state.md / backlog.md / роадмапами), и рабочее соглашение требует «сверять
// доки с реальностью». Этот скрипт делает исполняемой ровно одну гарантию:
// каждая ссылка на .md-файл указывает на существующий файл, а зонные теги
// backlog'а берутся из известного словаря (правило «один кирпич — одна зона»
// живёт на блоках; словарь не даёт зонам тихо расползаться опечатками).
//
// Без зависимостей, как prototype/doctor.mjs. Части:
//   1. Markdown-ссылки `[текст](путь.md)` — резолв относительно файла-источника.
//   2. Backtick-упоминания `имя.md` — резолв от корня, от файла, либо по
//      уникальному имени файла в репозитории (так доки и ссылаются друг на друга).
//   3. Словарь зон в docs/backlog.md: каждый тег `[зона]` ∈ известному набору
//      (комбинированные `[a/b]` проверяются почастно).
//
// Осознанные исключения — с причиной и датой (конвенция .trivyignore):
//   - docs/reviews/** не проверяется: это ДАТИРОВАННЫЕ исторические снапшоты,
//     им позволено ссылаться на имена, актуальные на их дату (в т.ч. на
//     предложенные и отклонённые доки).
//   - ALLOW: точечные forward-ссылки на ещё не созданные файлы.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, normalize, basename, sep } from 'node:path';

const ROOT = normalize(join(import.meta.dirname, '..'));

/** Каталоги, в которые обход не заходит (не наш контент / артефакты). */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.claude']);

/** Датированные исторические снапшоты — ссылки в них не проверяются (см. шапку). */
const HISTORICAL = [normalize('docs/reviews')];

/** Осознанные forward-ссылки на ещё не созданные файлы (причина + дата). */
const ALLOW = new Set([
  'core-engine.md', // запланированный архитектурный док — GDD §5.2 прямо зовёт его «ещё не созданным» · 2026-07
  'SECURITY.md', // политика раскрытия уязвимостей — подзадача SEC-8 secure-sdlc-roadmap, файла ещё нет · 2026-07
  'playtest-logs/2026-06-26-notes.md', // пример имени файла, который СОЗДАЁТ автор плейтеста по шаблону · 2026-07
]);

/** Словарь зон backlog'а — зеркалит легенду «## Зоны» в docs/backlog.md. */
const ZONES = new Set(['core', 'act', 'srv', 'cli', 'proto', 'data', 'docs', 'sec', 'ops']);

// --- обход репозитория ---------------------------------------------------------

/** Все файлы репо (рекурсивно, включая скрытые каталоги вроде .github). */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

const allFiles = walk(ROOT).map((f) => normalize(f).slice(ROOT.length + 1));
const fileSet = new Set(allFiles);
// имя файла → сколько раз встречается (для резолва «голых» упоминаний `имя.md`)
const byBasename = new Set(allFiles.map((f) => basename(f)));

const mdFiles = allFiles.filter(
  // `sep`, не '/': normalize даёт платформенный разделитель — с '/' историческое
  // исключение не срабатывало на Windows и локальный гейт краснел на чистом main.
  (f) => f.endsWith('.md') && !HISTORICAL.some((h) => f.startsWith(h + sep)),
);

// --- проверки ------------------------------------------------------------------

const problems = [];

/** Существует ли цель `ref`, упомянутая в файле `src`? */
function resolves(src, ref) {
  const target = ref.replace(/#.*$/, ''); // ссылка на секцию — проверяем файл
  if (target === '' || target.includes('*')) return true; // якорь / шаблон-маска — не файл
  if (ALLOW.has(target)) return true;
  const fromRoot = normalize(target.replace(/^\//, ''));
  if (fileSet.has(fromRoot)) return true;
  const fromFile = normalize(join(dirname(src), target));
  if (fileSet.has(fromFile)) return true;
  // «голое» упоминание `имя.md` — так доки ссылаются друг на друга через каталоги
  return byBasename.has(basename(target));
}

for (const file of mdFiles) {
  const text = readFileSync(join(ROOT, file), 'utf8');

  // 1. markdown-ссылки [..](x.md) — только относительные (http/mailto не наши)
  for (const m of text.matchAll(/\]\(([^)\s]+?\.md)(#[^)]*)?\)/g)) {
    const ref = m[1];
    if (/^[a-z]+:/i.test(ref)) continue; // http(s)://, mailto:
    if (!resolves(file, ref)) problems.push(`${file}: битая ссылка → ${ref}`);
  }

  // 2. backtick-упоминания `x.md` (в т.ч. с путём)
  for (const m of text.matchAll(/`([A-Za-z0-9._/*-]+\.md)`/g)) {
    if (!resolves(file, m[1])) problems.push(`${file}: висячее упоминание → \`${m[1]}\``);
  }
}

// 3. словарь зон backlog'а
const backlog = readFileSync(join(ROOT, 'docs/backlog.md'), 'utf8');
for (const m of backlog.matchAll(/`\[([a-z/+-]+)\]`/g)) {
  for (const part of m[1].split('/')) {
    if (!ZONES.has(part)) {
      problems.push(`docs/backlog.md: неизвестная зона \`[${m[1]}]\` (словарь: ${[...ZONES].join(', ')})`);
      break;
    }
  }
}

// --- вердикт ---------------------------------------------------------------------

if (problems.length > 0) {
  console.error(`docs-check: ${problems.length} проблем(ы) целостности docs/:\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(
    '\nПравь ссылку/зону, либо — для осознанной forward-ссылки — добавь её в ALLOW\n' +
      'внутри scripts/docs-check.mjs с причиной и датой (конвенция .trivyignore).',
  );
  process.exit(1);
}
console.log(`docs-check: OK — ${mdFiles.length} md-файлов, ссылки целы, зоны из словаря.`);
