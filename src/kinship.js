import relationship from '../node_modules/relationship.js/dist/relationship.min.mjs';

const dictionary = relationship.data;
const preferred = new Set(['爸爸', '妈妈', '丈夫', '妻子', '爷爷', '奶奶', '外公', '外婆', '孙子', '孙女', '外孙', '外孙女', '伯父', '叔叔', '姑姑', '姨妈', '舅舅', '姑父', '姨父', '舅妈', '嫂子', '弟媳', '儿媳']);
const MAX_STEPS = 12, MAX_VARIANTS = 64;

function nameOf(aliases) {
  const name = aliases.find(value => preferred.has(value)) || aliases[0];
  return name.replace(/^(姑表|舅表|姨表|姨)([哥姐弟妹])$/, '表$2');
}

function lookup(tokens, sourceGender) {
  const keys = [...new Set([tokens.join(','), tokens.map(token => token.replace(/^[ol]([bs])$/, 'x$1')).join(',')])];
  const entries = keys.map(key => dictionary.get(key)).filter(Boolean);
  const common = entries.flat().find(value => preferred.has(value));
  if (common) return [common];
  if (entries.length) return [nameOf(entries[0])];
  const sex = sourceGender === 'male' ? 1 : 0;
  for (const key of keys) {
    const aliases = dictionary.get(`${sex},${key}`);
    if (aliases) return [nameOf(aliases)];
  }
  return [];
}

function edgeOptions(step, from, to, older) {
  const genders = to.gender === 'unknown' ? ['male', 'female'] : [to.gender];
  return genders.flatMap(gender => {
    const male = gender === 'male';
    if (step.code === 'p') return [male ? 'f' : 'm'];
    if (step.code === 'c') return [male ? 's' : 'd'];
    if (step.code === 's') return [male ? 'h' : 'w'];
    const senior = older(to, from), suffix = male ? 'b' : 's';
    return (senior === null ? ['o', 'l'] : [senior ? 'o' : 'l']).map(rank => rank + suffix);
  });
}

function literalChain(path, steps, older) {
  return steps.map((step, i) => {
    const to = path[i + 1], male = to.gender === 'male', female = to.gender === 'female';
    if (step.code === 'p') return male ? '父亲' : female ? '母亲' : '父亲或母亲';
    if (step.code === 'c') return male ? '儿子' : female ? '女儿' : '子女';
    if (step.code === 's') return male ? '丈夫' : female ? '妻子' : '配偶';
    const senior = older(to, path[i]);
    return male ? senior === null ? '兄弟' : senior ? '哥哥' : '弟弟' : female ? senior === null ? '姐妹' : senior ? '姐姐' : '妹妹' : '兄弟姐妹';
  }).join('的');
}

export function resolveKinship(path, steps, older) {
  const chain = literalChain(path, steps, older);
  const uncertain = reason => ({ title: `${chain}（${reason}）`, candidates: [], status: 'uncertain', reasons: [reason], chain });
  if (steps.some(step => step.kind === 'adoptive' || step.kind === 'step')) {
    const reason = `${steps.some(step => step.kind === 'adoptive') ? '收养' : '继亲'}关系，称呼待确认`;
    return uncertain(reason);
  }
  const code = steps.map(step => step.code).join('');
  // A terminology library must not turn unrecorded shared parents or marriages into facts.
  const unsafe = { bp: '未确认共同父母', bb: '不能推断兄弟姐妹关系具有传递性', cp: '未确认双方为配偶', ps: '未确认与你的亲子关系', sc: '未确认与你的亲子关系', ss: '不能推断配偶关系具有传递性' };
  for (let i = 0; i < code.length - 1; i++) if (unsafe[code.slice(i, i + 2)]) return uncertain(unsafe[code.slice(i, i + 2)]);
  if (steps.length > MAX_STEPS) return { ...uncertain('关系链过长，超过自动称谓范围'), status: 'unsupported' };

  let variants = [[]];
  for (const [i, step] of steps.entries()) {
    const options = edgeOptions(step, path[i], path[i + 1], older);
    if (variants.length * options.length > MAX_VARIANTS) return uncertain('性别或长幼资料不足，候选组合过多，请补充资料');
    variants = variants.flatMap(tokens => options.map(token => [...tokens, token]));
  }

  const anchor = steps[0]?.code === 's' ? 1 : 0;
  const end = steps.at(-1)?.code === 's' ? steps.length - 1 : steps.length;
  const generation = steps.slice(anchor, end).reduce((sum, step) => sum + (step.code === 'p' ? 1 : step.code === 'c' ? -1 : 0), 0);
  const cousinAge = generation === 0 && steps[end - 1]?.code === 'c';
  const senior = cousinAge ? older(path[end], path[anchor]) : null;
  const sourceGenders = path[0].gender === 'unknown' ? ['male', 'female'] : [path[0].gender];
  if (variants.length * sourceGenders.length * (cousinAge && senior === null ? 2 : 1) > MAX_VARIANTS) return uncertain('性别或长幼资料不足，候选组合过多，请补充资料');
  const candidates = new Set(), ageGroups = new Map(), genderGroups = new Map();
  let unmatched = false, missingAge = false, missingGender = false;
  function record(sourceGender, tokens, titles) {
    if (!titles.length) return;
    const key = sourceGender + ':' + tokens.map(token => token.replace(/&[ol]$/, '').replace(/^[ol]([bs])$/, 'x$1')).join(',');
    const signature = [...titles].sort().join('|');
    if (ageGroups.has(key) && ageGroups.get(key) !== signature) missingAge = true;
    ageGroups.set(key, signature);
    const genderKey = tokens.map(token => token.replace(/^[fm]$/, 'p').replace(/^[hw]$/, 'sp').replace(/^[sd](&[ol])?$/, 'c$1').replace(/^([ol])[bs]$/, '$1b')).join(',');
    if (genderGroups.has(genderKey) && genderGroups.get(genderKey) !== signature) missingGender = true;
    genderGroups.set(genderKey, signature);
  }
  for (const sourceGender of sourceGenders) for (const tokens of variants) {
    let titles = [];
    if (cousinAge) {
      const rankedResults = (senior === null ? ['o', 'l'] : [senior ? 'o' : 'l']).map(rank => {
        const ranked = [...tokens]; ranked[end - 1] += `&${rank}`;
        const found = lookup(ranked, sourceGender);
        record(sourceGender, ranked, found);
        return found;
      });
      titles = rankedResults.flat();
      if (titles.length && rankedResults.some(found => !found.length)) unmatched = true;
    }
    if (!titles.length) { titles = lookup(tokens, sourceGender); record(sourceGender, tokens, titles); }
    if (!titles.length) unmatched = true;
    titles.forEach(title => candidates.add(title));
  }
  if (!candidates.size) return { ...uncertain('称谓词库未覆盖，已保留完整关系链'), status: 'unsupported' };
  const reasons = [];
  if (candidates.size > 1 && missingGender) reasons.push('性别待确认');
  if (candidates.size > 1 && missingAge) reasons.push('长幼待确认');
  if (unmatched) reasons.push('部分候选关系未被词库覆盖');
  return {
    title: [...candidates].join('或') + (reasons.length ? `（${reasons.join('；')}）` : ''),
    candidates: [...candidates], status: candidates.size === 1 && !unmatched ? 'resolved' : 'uncertain', reasons, chain
  };
}
