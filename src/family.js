import { resolveKinship } from './kinship.js';

export const STORAGE_KEY = 'family-tree.v1';
export const emptyFamily = () => ({ version: 1, selfId: '', people: [], relations: [] });

function dateRange(value) {
  if (!value) return null;
  if (!/^\d{4}(-\d{2}){0,2}$/.test(value)) throw new Error('日期请填写 YYYY、YYYY-MM 或 YYYY-MM-DD');
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || (month !== undefined && (month < 1 || month > 12)) || (day !== undefined && (day < 1 || day > days[month - 1]))) throw new Error('日期不存在');
  return [year * 10000 + (month || 1) * 100 + (day || 1), year * 10000 + (month || 12) * 100 + (day || days[(month || 12) - 1])];
}

export function validateData(input) {
  if (!input || input.version !== 1 || !Array.isArray(input.people) || !Array.isArray(input.relations)) throw new Error('不是受支持的家谱备份（version: 1）');
  if (input.people.length > 500 || input.relations.length > 2000) throw new Error('第一版支持最多 500 人、2000 条关系');
  const ids = new Set();
  const people = input.people.map(p => {
    if (!p || typeof p.id !== 'string' || !p.id || p.id.length > 100 || ids.has(p.id)) throw new Error('人物编号缺失或重复');
    ids.add(p.id);
    const result = { id: p.id };
    for (const [field, max] of Object.entries({ name: 60, alias: 100, birth: 10, death: 10, city: 100, occupation: 100, notes: 5000, photo: 200000 })) {
      const value = p[field] ?? '';
      if (typeof value !== 'string' || value.length > max) throw new Error(`${p.name || '人物'}的 ${field} 字段格式错误或过长`);
      result[field] = value.trim();
    }
    if (!result.name) throw new Error('请填写姓名');
    if (!['male', 'female', 'unknown'].includes(p.gender)) throw new Error('性别字段无效');
    result.gender = p.gender;
    const birth = dateRange(result.birth), death = dateRange(result.death);
    if (birth && death && birth[0] > death[1]) throw new Error(`${result.name}的去世时间不能早于出生时间`);
    if (result.photo && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(result.photo)) throw new Error('照片必须是本机导入的 JPEG、PNG 或 WebP 图片');
    return result;
  });
  if (typeof input.selfId !== 'string' || (input.selfId && !ids.has(input.selfId))) throw new Error('“我是谁”指向不存在的人物');
  const keys = new Set();
  const relations = input.relations.map(r => {
    if (!r || !ids.has(r.from) || !ids.has(r.to) || r.from === r.to || !['parent', 'spouse', 'sibling'].includes(r.type)) throw new Error('亲属关系包含无效人物或类型');
    const pair = r.type !== 'parent' ? [r.from, r.to].sort() : [r.from, r.to];
    const key = JSON.stringify([r.type, ...pair]);
    if (keys.has(key)) throw new Error('存在重复亲属关系');
    keys.add(key);
    if (r.type === 'parent' && !['biological', 'adoptive', 'step'].includes(r.kind)) throw new Error('请指定亲生、收养或继亲关系');
    return r.type === 'parent' ? { from: r.from, to: r.to, type: r.type, kind: r.kind } : { from: pair[0], to: pair[1], type: r.type };
  });
  const children = new Map(people.map(p => [p.id, []]));
  relations.filter(r => r.type === 'parent').forEach(r => children.get(r.from).push(r.to));
  const visiting = new Set(), done = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('父母子女关系形成循环，请检查祖先与后代');
    if (done.has(id)) return;
    visiting.add(id); children.get(id).forEach(visit); visiting.delete(id); done.add(id);
  }
  people.forEach(p => visit(p.id));
  function descends(from, to) {
    const queue = [...children.get(from)], seen = new Set();
    while (queue.length) { const id = queue.shift(); if (id === to) return true; if (!seen.has(id)) { seen.add(id); queue.push(...children.get(id)); } }
    return false;
  }
  for (const r of relations.filter(r => r.type === 'spouse')) {
    if (descends(r.from, r.to) || descends(r.to, r.from)) throw new Error('祖先与后代不能设置为配偶');
  }
  const clean = { version: 1, selfId: input.selfId, people, relations };
  for (const r of relations.filter(r => r.type === 'sibling')) {
    if (descends(r.from, r.to) || descends(r.to, r.from)) throw new Error('祖先与后代不能设置为兄弟姐妹');
    if (keys.has(JSON.stringify(['spouse', r.from, r.to]))) throw new Error('同一对成员不能同时设置为配偶和兄弟姐妹');
  }
  if (relations.some(r => r.type === 'sibling') && !generationLevels(clean, peerGroups(clean))) throw new Error('兄弟姐妹的同辈关系与父母辈分冲突，请检查');
  return clean;
}

export function siblingsOf(data, id) {
  const parents = new Set(data.relations.filter(r => r.type === 'parent' && r.kind === 'biological' && r.to === id).map(r => r.from));
  const automatic = new Set(data.relations.filter(r => r.type === 'parent' && r.kind === 'biological' && parents.has(r.from)).map(r => r.to));
  const manual = new Set(data.relations.filter(r => r.type === 'sibling' && (r.from === id || r.to === id)).map(r => r.from === id ? r.to : r.from));
  return data.people.filter(p => p.id !== id && (automatic.has(p.id) || manual.has(p.id))).map(p => ({ id: p.id, manual: manual.has(p.id), automatic: automatic.has(p.id) }));
}

export const MAX_BACKUP_BYTES = 15_000_000;
const byteLength = text => new TextEncoder().encode(text).byteLength;

export async function parseBackupFile(file) {
  if (file.size > MAX_BACKUP_BYTES) throw new Error('备份文件过大（上限 15 MB）');
  return parseBackup(await file.text());
}
export function parseBackup(text) {
  if (typeof text !== 'string' || byteLength(text) > MAX_BACKUP_BYTES) throw new Error('备份文件过大（上限 15 MB）');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('备份不是有效的 JSON，文件可能损坏'); }
  return validateData(parsed);
}
export function loadData(storage) {
  const text = storage.getItem(STORAGE_KEY);
  if (text === null) return emptyFamily();
  try { return parseBackup(text); } catch (error) { throw new Error(`本机家谱损坏或格式不受支持，请先导出原始备份再恢复。${error.message}`); }
}
export function saveData(storage, data) {
  const clean = validateData(data);
  const text = JSON.stringify(clean);
  if (byteLength(text) > MAX_BACKUP_BYTES) throw new Error('家谱超过备份容量（15 MB），请减少照片大小');
  try { storage.setItem(STORAGE_KEY, text); } catch { throw new Error('本机存储不足或不可用，未保存本次修改；请备份并减少照片'); }
  return clean;
}
export async function saveIfUnchanged(storage, data, expectedText, locks) {
  if (!locks?.request) throw new Error('浏览器不支持安全的跨页面保存，请使用新版浏览器并通过 localhost 或 HTTPS 打开');
  return locks.request(STORAGE_KEY, () => {
    if (storage.getItem(STORAGE_KEY) !== expectedText) throw new Error('家谱已在其他页面修改。请刷新后再编辑，以免覆盖更新');
    const clean = saveData(storage, data);
    return { data: clean, text: JSON.stringify(clean) };
  });
}
export function removePerson(data, id) {
  return validateData({ ...data, selfId: data.selfId === id ? '' : data.selfId, people: data.people.filter(p => p.id !== id), relations: data.relations.filter(r => r.from !== id && r.to !== id) });
}

function older(a, b) {
  const x = dateRange(a.birth), y = dateRange(b.birth);
  if (!x || !y) return null;
  return x[1] < y[0] ? true : x[0] > y[1] ? false : null;
}

export function describeRelationship(data, fromId, toId) {
  const byId = new Map(data.people.map(p => [p.id, p]));
  const empty = { candidates: [], path: [], steps: [], alternatives: [], reasons: [] };
  if (!byId.has(fromId) || !byId.has(toId)) return { ...empty, title: '请选择两位成员', status: 'unselected' };
  if (fromId === toId) return { ...empty, title: '本人', candidates: ['本人'], path: [byId.get(fromId)], status: 'resolved' };
  const graph = new Map(data.people.map(p => [p.id, new Map()]));
  function edge(a, b, code, kind = 'biological') {
    const key = `${b}:${code}`, existing = graph.get(a).get(key);
    if (!existing || existing.kind === 'manual') graph.get(a).set(key, { id: b, code, kind, from: a });
  }
  for (const r of data.relations) {
    if (r.type === 'parent') { edge(r.from, r.to, 'c', r.kind); edge(r.to, r.from, 'p', r.kind); }
    else if (r.type === 'spouse') { edge(r.from, r.to, 's'); edge(r.to, r.from, 's'); }
  }
  for (const parent of data.people) {
    const kids = [...graph.get(parent.id).values()].filter(e => e.code === 'c' && e.kind === 'biological');
    for (const a of kids) for (const b of kids) if (a.id !== b.id) edge(a.id, b.id, 'b');
  }
  for (const r of data.relations.filter(r => r.type === 'sibling')) {
    edge(r.from, r.to, 'b', 'manual'); edge(r.to, r.from, 'b', 'manual');
  }
  const queue = [fromId], distance = new Map([[fromId, 0]]), previous = new Map([[fromId, []]]);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor], depth = distance.get(current);
    if (distance.has(toId) && depth >= distance.get(toId)) break;
    for (const e of graph.get(current).values()) {
      if (!distance.has(e.id)) { distance.set(e.id, depth + 1); previous.set(e.id, []); queue.push(e.id); }
      if (distance.get(e.id) === depth + 1) previous.get(e.id).push(e);
    }
  }
  if (!distance.has(toId)) return { ...empty, title: '尚未找到亲属关系', status: 'disconnected' };
  const alternatives = [], maxPaths = 32;
  const labels = { p: '父母', c: '子女', b: '兄弟姐妹', s: '配偶' };
  function collect(id, reversed) {
    if (alternatives.length > maxPaths) return;
    if (id === fromId) {
      const steps = [...reversed].reverse().map(e => ({ ...e, label: (e.kind === 'adoptive' ? '收养·' : e.kind === 'step' ? '继亲·' : e.kind === 'manual' ? '手动·' : '') + labels[e.code] }));
      const path = [byId.get(fromId), ...steps.map(e => byId.get(e.id))];
      alternatives.push({ ...resolveKinship(path, steps, older), path, steps });
    } else {
      for (const e of previous.get(id)) collect(e.from, [...reversed, e]);
    }
  }
  collect(toId, []);
  const truncated = alternatives.length > maxPaths;
  if (truncated) alternatives.length = maxPaths;
  const candidates = [...new Set(alternatives.flatMap(result => result.candidates))];
  const reasons = [...new Set(alternatives.flatMap(result => result.reasons))];
  if (new Set(alternatives.map(result => result.title)).size > 1) reasons.unshift('存在多条最短关系路径');
  if (truncated) reasons.push('路径过多，仅展示前 32 条，结果可能不完整');
  const unresolved = alternatives.some(result => result.status !== 'resolved');
  const title = (candidates.length ? candidates.join('或') : alternatives[0].chain) + (reasons.length ? `（${reasons.join('；')}）` : '');
  const status = !truncated && alternatives.every(result => result.status === 'unsupported') ? 'unsupported' : truncated || unresolved || candidates.length > 1 ? 'uncertain' : 'resolved';
  return { ...alternatives[0], title, candidates, reasons, alternatives, status };
}

function peerGroups(data, includeSpouses = false) {
  const group = new Map(data.people.map(p => [p.id, p.id]));
  function root(id) { while (group.get(id) !== id) id = group.get(id); return id; }
  data.relations.filter(r => r.type === 'sibling' || (includeSpouses && r.type === 'spouse')).forEach(r => group.set(root(r.to), root(r.from)));
  return new Map(data.people.map(p => [p.id, root(p.id)]));
}
function generationLevels(data, groups) {
  const levels = new Map(data.people.map(p => [groups.get(p.id), 0]));
  const parents = data.relations.filter(r => r.type === 'parent');
  for (let round = 0; round <= data.people.length; round++) {
    let changed = false;
    for (const r of parents) {
      const a = groups.get(r.from), b = groups.get(r.to);
      if (levels.get(b) <= levels.get(a)) { levels.set(b, levels.get(a) + 1); changed = true; }
    }
    if (!changed) return new Map(data.people.map(p => [p.id, levels.get(groups.get(p.id))]));
  }
  return null;
}
export function layoutTree(data) {
  const ranks = generationLevels(data, peerGroups(data, true)) || generationLevels(data, peerGroups(data));
  const couples = new Map(data.people.map(p => [p.id, p.id]));
  function root(id) { while (couples.get(id) !== id) id = couples.get(id); return id; }
  for (const r of data.relations) {
    if (r.type === 'spouse' && ranks.get(r.from) === ranks.get(r.to)) couples.set(root(r.to), root(r.from));
  }
  const generations = new Map(), neighbors = new Map(data.people.map(p => [p.id, []]));
  for (const p of data.people) {
    const level = ranks.get(p.id), couple = root(p.id);
    if (!generations.has(level)) generations.set(level, new Map());
    const row = generations.get(level);
    if (!row.has(couple)) row.set(couple, []);
    row.get(couple).push({ ...p, x: 0, y: 45 + level * 160 });
  }
  const rows = [...generations].sort(([a], [b]) => a - b).map(([, row]) => [...row.values()]);
  const nodes = rows.flat(2), byId = new Map(nodes.map(n => [n.id, n]));
  for (const r of data.relations.filter(r => r.type !== 'spouse')) {
    const weight = r.type === 'parent' ? 1 : 0.25;
    neighbors.get(r.from).push({ node: byId.get(r.to), weight });
    neighbors.get(r.to).push({ node: byId.get(r.from), weight });
  }
  for (const row of rows) {
    const members = row.flat();
    members.forEach((node, i) => { node.x = (i - (members.length - 1) / 2) * 190; });
  }
  const score = () => data.relations.reduce((sum, r) => sum + (r.type === 'sibling' ? 0.25 : 1) * ((byId.get(r.from).x - byId.get(r.to).x) / 190) ** 2, 0);
  let bestScore = score(), best = nodes.map(n => n.x);
  // Alternate generations so both ancestors and descendants guide ordering, not opaque IDs.
  for (let round = 0; round < 8; round++) for (const sweep of [rows, [...rows].reverse()]) {
    for (const row of sweep) {
      const targets = new Map(row.flat().map(node => {
        const links = neighbors.get(node.id), weight = links.reduce((sum, link) => sum + link.weight, 0);
        return [node.id, { x: weight ? links.reduce((sum, link) => sum + link.node.x * link.weight, 0) / weight : node.x, weight: weight || 1 }];
      }));
      const blocks = row.map(members => {
        members.sort((a, b) => targets.get(a.id).x - targets.get(b.id).x);
        const weight = members.reduce((sum, n) => sum + targets.get(n.id).weight, 0);
        const x = members.reduce((sum, n, i) => sum + (targets.get(n.id).x - i * 190) * targets.get(n.id).weight, 0) / weight;
        return { members, weight, x, center: x + (members.length - 1) * 95 };
      }).sort((a, b) => a.center - b.center);
      // Weighted isotonic compaction keeps couples together and at least 30px between cards.
      const pools = [];
      let offset = 0;
      for (const block of blocks) {
        block.offset = offset;
        offset += block.members.length * 190;
        pools.push({ blocks: [block], weight: block.weight, sum: (block.x - block.offset) * block.weight });
        while (pools.length > 1) {
          const right = pools.at(-1), left = pools.at(-2);
          if (left.sum / left.weight <= right.sum / right.weight) break;
          pools.pop(); left.blocks.push(...right.blocks); left.weight += right.weight; left.sum += right.sum;
        }
      }
      for (const pool of pools) for (const block of pool.blocks) {
        block.members.forEach((node, i) => { node.x = pool.sum / pool.weight + block.offset + i * 190; });
      }
      row.splice(0, row.length, ...blocks.map(block => block.members));
    }
    const currentScore = score();
    if (currentScore < bestScore) { bestScore = currentScore; best = nodes.map(n => n.x); }
  }
  nodes.forEach((node, i) => { node.x = best[i]; });
  const min = nodes.length ? Math.min(...best) : 0, max = nodes.length ? Math.max(...best) : 0;
  const span = nodes.length ? max - min + 160 : 0, width = Math.max(650, span + 60);
  nodes.forEach(node => { node.x += (width - span) / 2 - min; });
  return { nodes, width, height: Math.max(400, (Math.max(0, ...ranks.values()) + 1) * 160 + 70) };
}
