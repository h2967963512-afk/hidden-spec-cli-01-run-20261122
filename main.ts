// mend: apply an AI-written edit to a tree of text files, in one of four formats
// (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits). Implements SPEC.md v1 in full:
// the command line, output and exit codes, safe paths, format detection, three-tier
// line matching, unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON edits and
// all-or-nothing writes. Node 22, the standard library alone.
// Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; new: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---- files: lines, line break, final break (SPEC.md section 3) ----

interface FileLines {
  lines: string[];
  br: string;
  fin: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function joinFile(lines: string[], br: string, fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

// ---- matching lines at three tiers (SPEC.md section 5) ----

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** First line at or after `from` equal to a single line, at the first tier where one is. */
function findSingle(lines: string[], one: string, strict: boolean, from = 0): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === normLine(one, t)) return i;
    }
  }
  return null;
}

// ---- building the replacement lines ----

/** One line of N: `ctx` is its index in O when it is a context line, else null. */
interface NEnt {
  text: string;
  ctx: number | null;
  noNl: boolean;
}

function buildN(n: NEnt[], o: string[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const reindent = tier === 2 && o.length > 0;
  const f = reindent ? leadingWs(fileLines[pos] ?? '') : '';
  const p = reindent ? leadingWs(o[0]!) : '';
  for (const e of n) {
    if (e.ctx !== null) {
      out.push(fileLines[pos + e.ctx]!);
      continue;
    }
    let s = e.text;
    if (reindent && s !== '' && s.trim() !== '' && s.startsWith(p)) s = f + s.slice(p.length);
    out.push(s);
  }
  return out;
}

// ---- applying hunks (SPEC.md section 6) ----

interface Hunk {
  a: number;
  o: string[];
  n: NEnt[];
}

function applyHunks(lines: string[], br: string, fin: boolean, hunks: Hunk[], strict: boolean, path: string): { lines: string[]; fin: boolean } {
  let d = 0;
  let cur = lines;
  let curFin = fin;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const found = findTier(cur, h.o, strict);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bd = Math.abs(best - target);
      for (const p of found.occ) {
        const dd = Math.abs(p - target);
        if (dd < bd) {
          best = p;
          bd = dd;
        }
      }
      const atEnd = best + h.o.length === cur.length;
      const rep = buildN(h.n, h.o, cur, best, found.tier);
      cur = [...cur.slice(0, best), ...rep, ...cur.slice(best + h.o.length)];
      if (atEnd) curFin = h.n.length === 0 ? true : !h.n[h.n.length - 1]!.noNl;
      d += h.n.length - h.o.length;
    } else {
      const ins = Math.min(h.a + d, cur.length);
      const atEnd = ins === cur.length;
      const rep = h.n.map((e) => e.text);
      cur = [...cur.slice(0, ins), ...rep, ...cur.slice(ins)];
      if (atEnd && h.n.length > 0) curFin = !h.n[h.n.length - 1]!.noNl;
      d += h.n.length;
    }
  }
  return { lines: cur, fin: curFin };
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- unified diffs (SPEC.md section 6) ----

interface UniSection {
  oldP: string | null;
  newP: string | null;
  gitOld: string | null;
  gitNew: string | null;
  renFrom: string | null;
  renTo: string | null;
  newFile: boolean;
  deleted: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function headerPath(line: string): string {
  const t = line.slice(4);
  const tab = t.indexOf('\t');
  return (tab >= 0 ? t.slice(0, tab) : t).trim();
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?: |$)/;
  const diffRe = /^diff --git a\/(.+?) b\/(.+)$/;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = diffRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldP: null, newP: null, gitOld: m[1]!, gitNew: m[2]!, renFrom: null, renTo: null, newFile: false, deleted: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      interface BE {
        kind: string;
        text: string;
        empty: boolean;
        noNl: boolean;
      }
      const body: BE[] = [];
      let j = i + 1;
      while (j < n) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          body.push({ kind: ' ', text: '', empty: true, noNl: false });
          j += 1;
          continue;
        }
        const c = bl[0]!;
        if (c === ' ' || c === '-' || c === '+') {
          body.push({ kind: c, text: bl.slice(1), empty: false, noNl: false });
          j += 1;
          continue;
        }
        if (c === '\\') {
          if (body.length > 0) body[body.length - 1]!.noNl = true;
          j += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.empty) body.pop();
      const o: string[] = [];
      const nn: NEnt[] = [];
      for (const e of body) {
        if (e.kind === ' ') {
          o.push(e.text);
          nn.push({ text: e.text, ctx: o.length - 1, noNl: e.noNl });
        } else if (e.kind === '-') {
          o.push(e.text);
        } else {
          nn.push({ text: e.text, ctx: null, noNl: e.noNl });
        }
      }
      cur.hunks.push({ a, o, n: nn });
      inHeader = false;
      i = j;
      continue;
    }
    if (line.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (cur !== null && inHeader) {
          cur.oldP = headerPath(line);
          cur.newP = headerPath(lines[i + 1]!);
        } else {
          cur = { oldP: headerPath(line), newP: headerPath(lines[i + 1]!), gitOld: null, gitNew: null, renFrom: null, renTo: null, newFile: false, deleted: false, hunks: [] };
          sections.push(cur);
          inHeader = true;
        }
        i += 2;
        continue;
      }
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('+++ ')) {
        cur.newP = headerPath(line);
      } else if (line.startsWith('rename from ')) {
        cur.renFrom = line.slice(12).trim();
      } else if (line.startsWith('rename to ')) {
        cur.renTo = line.slice(10).trim();
      } else if (line.startsWith('new file mode')) {
        cur.newFile = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.deleted = true;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    const oldRaw = s.oldP ?? s.renFrom ?? s.gitOld;
    const newRaw = s.newP ?? s.renTo ?? s.gitNew;
    const oldIsNull = oldRaw === '/dev/null';
    const newIsNull = newRaw === '/dev/null';
    let oldP: string | null = oldRaw === null || oldIsNull ? null : stripAB(oldRaw);
    let newP: string | null = newRaw === null || newIsNull ? null : stripAB(newRaw);
    if (oldP === null) oldP = newP;
    if (newP === null) newP = oldP;
    const isCreate = oldIsNull || s.newFile;
    const isDelete = newIsNull || s.deleted;
    if (isCreate) {
      const p = newP!;
      const hunks = s.hunks;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: NEnt[] = [];
        for (const h of hunks) for (const e of h.n) if (e.ctx === null) plus.push(e);
        let text = '';
        if (plus.length > 0) {
          text = plus.map((e) => e.text).join('\n') + (!plus[plus.length - 1]!.noNl ? '\n' : '');
        }
        tree.now.set(p, text);
      });
    } else if (isDelete) {
      const p = oldP!;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else if (oldP !== null && newP !== null && oldP !== newP) {
      const op = oldP;
      const np = newP;
      const hunks = s.hunks;
      edits.push((tree) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (!safe(np)) throw new Fail('unsafe', np);
        const before = tree.get(op);
        if (before === null) throw new Fail('missing', op);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const f = splitFile(before);
        const res = applyHunks(f.lines, f.br, f.fin, hunks, strict, op);
        (res as unknown as { br: string }).br = f.br;
        tree.now.set(np, joinFile(res.lines, res.br, res.fin));
        tree.now.set(op, null);
        tree.moves.push({ old: op, new: np });
      });
    } else {
      const p = (oldP ?? newP)!;
      const hunks = s.hunks;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        const f = splitFile(before);
        const res = applyHunks(f.lines, f.br, f.fin, hunks, strict, p);
        (res as unknown as { br: string }).br = f.br;
        tree.now.set(p, joinFile(res.lines, res.br, res.fin));
      });
    }
  }
  return edits;
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function makeReplaceEdit(p: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    const pos = found.occ[0]!;
    const rep = buildN(
      newLines.map((t) => ({ text: t, ctx: null, noNl: false })),
      oldLines,
      f.lines,
      pos,
      found.tier,
    );
    const out = [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos + oldLines.length)];
    tree.now.set(p, joinFile(out, f.br, f.fin));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let boundary = 0;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let k = searchLine - 1; k >= boundary; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let j = searchLine + 1;
    let eq = -1;
    while (j < n) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      j += 1;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let k = eq + 1;
    let end = -1;
    while (k < n) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
      k += 1;
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, end);
    edits.push(makeReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    boundary = end + 1;
    i = end + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOVE = '*** Move to: ';

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NEnt[];
}

function isSectionStart(l: string): boolean {
  return l.startsWith(V_ADD) || l.startsWith(V_DEL) || l.startsWith(V_UPD);
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith(V_ADD)) {
      const p = line.slice(V_ADD.length).trim();
      const raw: { text: string; idx: number }[] = [];
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (isSectionStart(l)) break;
        raw.push({ text: l, idx: j });
        j += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const fileLines: string[] = [];
      for (const r of raw) {
        const l = r.text;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (blank(l)) fileLines.push('');
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      i = j;
      continue;
    }
    if (line.startsWith(V_DEL)) {
      const p = line.slice(V_DEL.length).trim();
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (isSectionStart(l)) break;
        if (!blank(l)) throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      i = j;
      continue;
    }
    if (line.startsWith(V_UPD)) {
      const p = line.slice(V_UPD.length).trim();
      const raw: { text: string; idx: number }[] = [];
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (isSectionStart(l)) break;
        raw.push({ text: l, idx: j });
        j += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      let moveTo: string | null = null;
      let seenBody = false;
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const startChunk = (anchor: string | null): void => {
        cur = { anchor, eof: false, o: [], n: [] };
        chunks.push(cur);
      };
      for (const r of raw) {
        const l = r.text;
        if (!seenBody && blank(l)) continue;
        if (!seenBody && l.startsWith(V_MOVE)) {
          moveTo = l.slice(V_MOVE.length).trim();
          seenBody = true;
          continue;
        }
        if (l.startsWith('@@')) {
          const a = l.slice(2).trim();
          startChunk(a === '' ? null : a);
          seenBody = true;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) startChunk(null);
          cur!.eof = true;
          cur = null;
          seenBody = true;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) startChunk(null);
          const text = l === '' ? '' : l.slice(1);
          if (l === '' || l[0] === ' ') {
            const oi = cur!.o.length;
            cur!.o.push(text);
            cur!.n.push({ text, ctx: oi, noNl: false });
          } else if (l[0] === '-') {
            cur!.o.push(text);
          } else {
            cur!.n.push({ text, ctx: null, noNl: false });
          }
          seenBody = true;
          continue;
        }
        throw new Exit2(`error: parse ${r.idx + 1}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const f = splitFile(before);
        let curLines = f.lines;
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const at = findSingle(curLines, ch.anchor, strict, cursor);
            if (at === null) throw new Fail('no-match', p);
            cursor = at + 1;
          }
          if (ch.o.length === 0) {
            const ins = ch.eof ? curLines.length : cursor;
            const rep = ch.n.map((e) => e.text);
            curLines = [...curLines.slice(0, ins), ...rep, ...curLines.slice(ins)];
            cursor = ins + rep.length;
          } else {
            const found = findTier(curLines, ch.o, strict, cursor);
            if (!found) throw new Fail('no-match', p);
            let occ = found.occ;
            if (ch.eof) occ = occ.filter((pos) => pos + ch.o.length === curLines.length);
            if (occ.length === 0) throw new Fail('no-match', p);
            const pos = occ[0]!;
            const rep = buildN(ch.n, ch.o, curLines, pos, found.tier);
            curLines = [...curLines.slice(0, pos), ...rep, ...curLines.slice(pos + ch.o.length)];
            cursor = pos + rep.length;
          }
        }
        const text = joinFile(curLines, f.br, f.fin);
        if (moveTo !== null) {
          tree.now.set(moveTo, text);
          tree.now.set(p, null);
          tree.moves.push({ old: p, new: moveTo });
        } else {
          tree.now.set(p, text);
        }
      });
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const m of tree.moves) {
    const o = changed.get(m.old);
    const n2 = changed.get(m.new);
    if (o !== undefined && o.was !== null && o.now === null && n2 !== undefined && n2.was === null && n2.now !== null) {
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
      usedOld.add(m.old);
      usedNew.add(m.new);
    }
  }
  for (const [p, c] of changed) {
    if (usedOld.has(p) || usedNew.has(p)) continue;
    rows.push({ key: p, text: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    const dels = [...tree.now.keys()].filter((p) => tree.now.get(p) === null).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const p of dels) rmSync(p, { force: true });
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
