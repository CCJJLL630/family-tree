export function demoFamily() {
  const p = (id, name, gender, birth, alias = '', notes = '') => ({ id, name, gender, birth, alias, notes, city: '浙江 · 杭州', occupation: '', death: '', photo: '' });
  const parent = (from, to) => ({ from, to, type: 'parent', kind: 'biological' });
  const spouse = (from, to) => ({ from, to, type: 'spouse' });
  return { version: 1, selfId: 'lin-an', people: [
    p('grandpa', '林远山', 'male', '1942-04', '爷爷', '示例人物（虚构）。喜欢书法，每年春节都会为家人写春联。'),
    p('grandma', '沈兰', 'female', '1945-09', '奶奶', '示例人物（虚构）。记得家里每个人爱吃的菜。'),
    p('father', '林建国', 'male', '1970-03-12', '', '示例人物（虚构）。年轻时的老照片还收在书柜里。'),
    p('mother', '许芳', 'female', '1973-06', '', '示例人物（虚构）。喜欢种花，也喜欢给花拍照片。'),
    p('uncle', '林建明', 'male', '1967-08', '大伯', '示例人物（虚构）。过年总是最早到的那一个。'),
    p('aunt-in-law', '周敏', 'female', '1969', '', '示例人物（虚构）。'),
    p('aunt', '林晓梅', 'female', '1976', '小姑', '示例人物（虚构）。'),
    p('lin-an', '林安', 'male', '1998-05-21', '安安', '示例人物（虚构）。从这一代开始，把家人的故事记下来。'),
    p('sister', '林悦', 'female', '2003-11', '小悦', '示例人物（虚构）。喜欢旅行，正在整理家人的合照。'),
    p('cousin', '林清', 'female', '1995-07', '清清', '示例人物（虚构）。'),
    p('wife', '陈禾', 'female', '1999-02', '', '示例人物（虚构）。')
  ], relations: [spouse('grandpa', 'grandma'), spouse('father', 'mother'), spouse('uncle', 'aunt-in-law'), spouse('lin-an', 'wife'),
    ...['father', 'uncle', 'aunt'].flatMap(id => [parent('grandpa', id), parent('grandma', id)]),
    ...['lin-an', 'sister'].flatMap(id => [parent('father', id), parent('mother', id)]), parent('uncle', 'cousin'), parent('aunt-in-law', 'cousin')]
  };
}
