import { CHAPTERS } from './data/script.js';
import { ARTIFACTS } from './data/artifacts.js';
import tapeUrl from './ui/tape-strip.png';

/* ═══════════ 配置 ═══════════ */
const DEFAULTS = {
  curves: { mugiFaithStart: 70, kinuFaithStart: 80, kinuLaborStart: 100, syncStart: 400 },
  labor: { costPerAct: 14, recoveryRate: 0.34, exhaustThreshold: 18 },
  coupling: { mugiToKinu: 0.5, kinuToMugi: 0.4 },
  flow: { irreversibleYear: 2017, declineThreshold: 80, weekSlots: 3, totalWeeks: 8 },
  options: { showTradeStamp: true, forceDualView: true, skipPrologueTutorial: false }
};
let CFG = merge(DEFAULTS, window.__museGameConfig ?? {});
function merge(a, b) {
  const o = {};
  for (const k of Object.keys(a)) {
    o[k] = (a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]))
      ? { ...a[k], ...(b?.[k] ?? {}) } : (b?.[k] ?? a[k]);
  }
  return o;
}
window.addEventListener('muse:config-updated', e => {
  CFG = merge(DEFAULTS, e.detail ?? {});
  applyConfig();
});
function applyConfig() {
  // 未开局时同步初始值;已开局时上限/阈值类参数立即生效
  if (!S.started) {
    S.mf = CFG.curves.mugiFaithStart;
    S.kf = CFG.curves.kinuFaithStart;
    S.kl = CFG.curves.kinuLaborStart;
    S.sync = CFG.curves.syncStart;
  }
  S.mf = clamp(S.mf); S.kf = clamp(S.kf); S.kl = clamp(S.kl);
  S.sync = Math.max(0, Math.min(CFG.curves.syncStart, S.sync));
  drawHud();
  if (S.node?.t === 'week') renderWeek();
}
const clamp = v => Math.max(0, Math.min(100, v));

/* ═══════════ 状态 ═══════════ */
const S = {
  started: false,
  mf: DEFAULTS.curves.mugiFaithStart,
  kf: DEFAULTS.curves.kinuFaithStart,
  kl: DEFAULTS.curves.kinuLaborStart,
  sync: DEFAULTS.curves.syncStart,
  trades: 0,
  irreversible: false,
  exhausted: false,
  ci: 0, ni: 0,
  node: null,
  view: 'n',
  unlocked: new Set(),
  found: new Set(),
  week: 1,
  weekLog: [],
  petals: 0
};
const declineIndex = () => 100 - S.mf + S.trades * 5;

/* ═══════════ DOM 骨架(常驻,不重建) ═══════════ */
const app = document.getElementById('app');
app.innerHTML = `
<div class="book">
  <div class="hud">
    <div class="gauge g-mugi" id="g-mf"><div class="lab">麦 · 信念</div><div class="num">70</div><div class="track"><div class="fill"></div></div></div>
    <div class="gauge g-kinu" id="g-kf"><div class="lab">绢 · 信念</div><div class="num">80</div><div class="track"><div class="fill"></div></div></div>
    <div class="gauge g-kinu g-labor" id="g-kl"><div class="lab">绢 · 情感劳动</div><div class="num">100</div><div class="track"><div class="fill"></div></div></div>
    <div class="sync" id="g-sync">
      <div class="rings"><div class="ring r1"></div><div class="ring r2"></div></div>
      <div class="num">400</div><div class="arrow" id="sync-arrow">可回升 ↑</div>
    </div>
    <button class="helpbtn" id="help-open" title="操作与机制">书</button>
  </div>

  <div class="stage">
    <div class="photo" id="photo">
      <img class="bg" id="bg" alt="" />
    </div>
    <img class="tape t1" src="${tapeUrl}" alt="" />
    <img class="tape t2" src="${tapeUrl}" alt="" />
    <div id="cast"></div>
    <img class="bouquet" id="bouquet" src="assets/ui/dried-bouquet.png" alt="" />
    <button class="switch" id="switch" hidden>切到 绢</button>
  </div>

  <div class="script" id="script"></div>

  <div class="veil" id="veil" hidden></div>

  <div class="help" id="help" hidden>
    <div class="sheet" id="help-sheet"></div>
  </div>
</div>`;

const el = id => document.getElementById(id);
const $bg = el('bg'), $photo = el('photo'), $script = el('script'),
  $veil = el('veil'), $help = el('help'), $sheet = el('help-sheet'),
  $switch = el('switch'), $cast = el('cast'), $bouquet = el('bouquet');

/* ═══════════ HUD ═══════════ */
function drawHud() {
  set('g-mf', S.mf, S.mf);
  set('g-kf', S.kf, S.kf);
  set('g-kl', S.kl, S.kl);
  const sy = el('g-sync');
  sy.querySelector('.num').textContent = Math.round(S.sync);
  const k = S.sync / Math.max(1, CFG.curves.syncStart);
  sy.querySelector('.r1').style.transform = `translateX(${(1 - k) * 9}px)`;
  sy.querySelector('.r2').style.transform = `translateX(${-(1 - k) * 9}px)`;
  function set(id, num, pct) {
    const g = el(id);
    g.querySelector('.num').textContent = Math.round(num);
    g.querySelector('.fill').style.width = Math.max(0, Math.min(100, pct)) + '%';
  }
}
function hurt(id) {
  const g = el(id);
  g.classList.remove('hurt'); void g.offsetWidth; g.classList.add('hurt');
}

/* 曲线结算 + 双线耦合 */
function applyFx(fx) {
  if (!fx) return;
  const before = { mf: S.mf, kf: S.kf, kl: S.kl };
  if (fx.mf) S.mf = clamp(S.mf + fx.mf);
  if (fx.kf) S.kf = clamp(S.kf + fx.kf);
  if (fx.kl) S.kl = clamp(S.kl + fx.kl);
  if (fx.trade) S.trades += fx.trade;
  if (fx.sync) S.sync = Math.max(0, Math.min(CFG.curves.syncStart,
    S.sync + (S.irreversible && fx.sync > 0 ? 0 : fx.sync)));

  // 麦信念下降 → 绢情感劳动额外消耗
  if (fx.mf && fx.mf < 0) S.kl = clamp(S.kl + fx.mf * CFG.coupling.mugiToKinu);
  // 绢耗竭 → 麦信念额外下降
  if (S.kl <= CFG.labor.exhaustThreshold) {
    if (!S.exhausted) { S.exhausted = true; showExhaust(); }
    S.mf = clamp(S.mf - 3 * CFG.coupling.kinuToMugi);
  } else S.exhausted = false;

  if (S.mf < before.mf) hurt('g-mf');
  if (S.kf < before.kf) hurt('g-kf');
  if (S.kl < before.kl) { hurt('g-kl'); dropPetal(); }
  drawHud();
}
function dropPetal() {
  const p = document.createElement('img');
  p.className = 'petal'; p.src = 'assets/ui/petal.png'; p.alt = '';
  const r = $bouquet.getBoundingClientRect(), b = document.querySelector('.book').getBoundingClientRect();
  p.style.right = (b.right - r.right + 8 + Math.random() * 26) + 'px';
  p.style.top = (r.top - b.top + 10 + Math.random() * 40) + 'px';
  document.querySelector('.book').appendChild(p);
  p.addEventListener('animationend', () => p.remove());
  S.petals++;
  $bouquet.style.opacity = Math.max(.4, .9 - S.petals * 0.03);
}

/* ═══════════ 演出层 ═══════════ */
function veil(html, onGo, goLabel = '继续') {
  $veil.innerHTML = html + `<button class="go" id="veil-go">${goLabel}</button>`;
  $veil.hidden = false;
  $veil.classList.remove('fadein'); void $veil.offsetWidth; $veil.classList.add('fadein');
  el('veil-go').onclick = () => { $veil.hidden = true; onGo && onGo(); };
}

/* ═══════════ 标题屏 ═══════════ */
function titleScreen() {
  $bg.src = 'assets/backgrounds/crossing-day.png';
  $photo.classList.add('faded');
  veil(`<div class="tt">花 束</div>
    <div class="st">般 的 恋 爱</div>
    <div class="rule"></div>
    <p>五年，两个人，同一件事里两种看见。<br>没有谁做错了什么。</p>
    <p style="font-size:11.5px;color:#7a776e;margin-top:14px">本次收录：序幕 · 第一幕 · 第二幕</p>`,
    () => { S.started = true; startMusic(); runChapter(0); }, '翻开第一页');
}

/* ═══════════ 章节推进 ═══════════ */
function runChapter(i) {
  S.ci = i; S.ni = 0;
  const c = CHAPTERS[i];
  veil(`<div class="era">${c.title}<em>${c.subtitle}</em></div>`, step, '　');
}
function step() {
  const c = CHAPTERS[S.ci];
  if (S.ni >= c.nodes.length) {
    if (S.ci + 1 < CHAPTERS.length) return runChapter(S.ci + 1);
    return;
  }
  S.node = c.nodes[S.ni++];
  render(S.node);
}

function setBg(src, view) {
  if (src && $bg.getAttribute('src') !== src) $bg.src = src;
  $photo.classList.toggle('faded', S.irreversible);
  $photo.classList.remove('push'); void $photo.offsetWidth; $photo.classList.add('push');
  drawCast(view);
}
function drawCast(view) {
  S.view = view || 'n';
  const want = view === 'm' ? 'mugi' : view === 'k' ? 'kinu' : null;
  if (!want) { $cast.innerHTML = ''; return; }
  const cur = $cast.firstElementChild;
  if (cur && cur.dataset.who === want) return;
  $cast.innerHTML = '';
  const img = document.createElement('img');
  img.dataset.who = want;
  img.className = 'portrait in ' + (want === 'mugi' ? 'left' : 'right');
  img.src = `assets/characters/${want === 'mugi' ? 'mugi' : 'kinu'}-bright.png`;
  img.alt = '';
  if (S.irreversible) img.style.filter = 'saturate(.55) drop-shadow(0 4px 8px rgba(60,45,20,.3))';
  $cast.appendChild(img);
}

/* ── 渲染分发 ── */
function render(n) {
  $switch.hidden = true; $switch.classList.remove('pulse');
  if (n.t === 's') return renderScene(n);
  if (n.t === 'c') return renderChoice(n);
  if (n.t === 'fx') return renderFx(n);
  if (n.t === 'week') { setBg('assets/backgrounds/apartment.png', 'n'); return renderWeek(); }
  if (n.t === 'report') return renderReport();
}

/* ── 叙事场景:逐句推进 ── */
let lineIdx = 0;
function renderScene(n) {
  setBg(n.bg, n.view);
  lineIdx = 0;
  $script.innerHTML = `<div class="who" id="who"></div><div class="txt" id="txt"></div><div class="next">点击继续 ▸</div>`;
  showLine(n);
  $script.onclick = () => {
    lineIdx++;
    if (lineIdx >= n.lines.length) {
      $script.onclick = null;
      if (n.fx) applyFx(n.fx);
      step();
    } else showLine(n);
  };
}
const NAME = { m: '山 音 麦', k: '八 谷 绢', n: '' };
function showLine(n) {
  const [who, text] = n.lines[lineIdx];
  const w = el('who'), t = el('txt');
  w.className = 'who ' + who; w.textContent = NAME[who];
  t.className = 'txt ' + who;
  t.innerHTML = '';
  [...text].forEach((ch, i) => {
    const s = document.createElement('span');
    s.className = 'ch'; s.textContent = ch;
    s.style.animationDelay = (i * 16) + 'ms';
    t.appendChild(s);
  });
  if (who !== 'n') drawCast(who);
}

/* ── 选择点 ── */
function renderChoice(n) {
  setBg(n.bg, n.view);
  $script.onclick = null;
  const box = document.createElement('div');
  $script.innerHTML = `<div class="who ${n.view}">${NAME[n.view] || '　'}</div>`;
  box.className = 'choices';
  box.innerHTML = `<div class="prompt">${n.prompt}</div>`;
  n.opts.forEach((o, i) => {
    const b = document.createElement('button');
    b.className = 'opt'; b.type = 'button';
    b.style.animationDelay = (60 + i * 70) + 'ms';
    b.innerHTML = `<span>${dim(o.text)}</span>`;
    b.onclick = () => pick(n, o, b, box);
    box.appendChild(b);
  });
  $script.appendChild(box);
}
// 「下流志向」阶段:积极措辞被抹去
function dim(t) {
  if (declineIndex() <= CFG.flow.declineThreshold) return t;
  return t.replace(/太好了/g, '也就那样')
    .replace(/开心/g, '不算难受')
    .replace(/终于/g, '反正')
    .replace(/最好/g, '还行的');
}
function pick(n, o, btn, box) {
  [...box.querySelectorAll('.opt')].forEach(b => {
    b.disabled = true;
    if (b !== btn) b.classList.add('dim');
  });
  btn.classList.add('picked');
  if (CFG.options.showTradeStamp && o.stamp) {
    const s = document.createElement('span');
    s.className = 'stamp'; s.textContent = o.stamp;
    btn.appendChild(s);
  }
  applyFx(o.fx);
  const note = document.createElement('div');
  note.className = 'fxnote';
  note.textContent = [o.fx?.note, o.tip].filter(Boolean).join('　·　');
  box.appendChild(note);

  const tail = [n.after, n.after2].filter(Boolean);
  const go = document.createElement('button');
  go.className = 'opt'; go.type = 'button';
  go.style.marginTop = '4px';
  go.innerHTML = '<span>▸ 继续</span>';
  go.onclick = () => {
    if (tail.length) render({ t: 's', bg: n.bg, view: n.view, lines: tail });
    else step();
  };
  box.appendChild(go);
  box.scrollTop = box.scrollHeight;
}

/* ── 演出节点 ── */
function renderFx(n) {
  if (n.kind === 'era') {
    setBg(n.bg, 'n');
    return veil(`<div class="era">${n.era}</div>`, step, '　');
  }
  if (n.kind === 'artifact') {
    const a = ARTIFACTS[n.id]; S.found.add(n.id);
    return veil(`<img class="art" src="${a.img}" alt="" />
      <div class="artname">${a.name}</div>
      <div class="st" style="margin-top:6px">物证 · ${a.era}</div>
      <div class="rule" style="margin:14px auto"></div>
      <div class="dual">
        <div class="m"><b>麦 说</b>${a.mugi}</div>
        <div class="k"><b>绢 说</b>${a.kinu}</div>
      </div>`, step, '夹进册子');
  }
  if (n.kind === 'irreversible') {
    if (S.irreversible) return step();
    S.irreversible = true;
    const ar = el('sync-arrow');
    ar.classList.remove('struck'); void ar.offsetWidth; ar.classList.add('struck');
    setTimeout(() => { ar.textContent = '不可回升'; }, 460);
    $photo.classList.add('faded');
    switchMusic();
    return veil(`<div class="era">2017 年</div>
      <div class="rule" style="margin:18px auto"></div>
      <p>从这一年起，同步率不会再上升了。</p>
      <p>他们还会一起去书店，还会一起看展，还会做完全一样的事。<br>那个数字只是不再回来。</p>`,
      step, '知道了');
  }
  if (n.kind === 'unlock') return renderUnlock(n.which);
  if (n.kind === 'switch') return step();
  step();
}
const LESSON = {
  trade: {
    t: '交易属性',
    b: '从现在起，每一个社交选项都会被盖上一枚印章，标明它在这个世界里的交易性质。<br><br>包括你想选的那个"纯粹"的选项。<br>你跳不出这个框架——这就是麦学到的东西。'
  },
  labor: {
    t: '情感劳动',
    b: '绢每一次主动开口、安慰、安排、收拾，都会消耗情感劳动值。<br><br>它恢复得只有消耗速度的三分之一，因为这个世界不把它算作工作。<br><br>耗尽时她会沉默。在麦的眼里，那叫"她变了"。'
  },
  switch: {
    t: '两个视角',
    b: '页边这枚纸标可以把册子翻到另一个人那一页。<br><br>同一个下午，同一家书店，两个人写下的东西不一样。<br><br>现在点它，看看绢那半页写了什么。'
  }
};
function renderUnlock(which) {
  S.unlocked.add(which);
  if (CFG.options.skipPrologueTutorial) return step();
  const L = LESSON[which];
  veil(`<div class="st">机 制 解 锁</div>
    <div class="artname" style="margin-top:10px">${L.t}</div>
    <div class="rule" style="margin:16px auto"></div>
    <p>${L.b}</p>`, () => {
    if (which === 'switch' && CFG.options.forceDualView) return dualViewLesson();
    step();
  }, '记下了');
}
function dualViewLesson() {
  setBg('assets/backgrounds/dessert-shop.png', 'k');
  $script.onclick = null;
  $script.innerHTML = `<div class="who n"></div>
    <div class="txt n">试着点右边那枚纸标，把册子翻到麦那一页。</div>`;
  $switch.hidden = false;
  $switch.textContent = '翻到 麦';
  $switch.classList.add('pulse');
  $switch.onclick = () => {
    $switch.hidden = true; $switch.classList.remove('pulse');
    render({ t: 's', bg: 'assets/backgrounds/night-street.png', view: 'm', lines: [
      ['m', '同一个晚上，我在回家的路上。我不知道甜品店发生了什么。'],
      ['m', '我以后也不会知道。她不会说，因为说了也没有用。'],
      ['n', '很好。这就是这个游戏要你做的事：看两遍，然后明白他们为什么会走散。']
    ]});
  };
}
function showExhaust() {
  const g = el('g-kl');
  g.querySelector('.lab').textContent = '绢 · 情 感 耗 竭';
  g.querySelector('.lab').style.color = 'var(--seal)';
}

/* ── 第二幕周循环 ── */
const MUGI_ACTS = [
  { k: 'ot', label: '加班', fx: { mf: -4, sync: -8 }, log: '麦加班到末班车。回来时她已经睡了，猫在他的枕头上。' },
  { k: 'be', label: '陪伴', fx: { sync: 12, kl: 6 }, log: '麦提议去看展。这周是他先开口的——绢在电车上一直在笑。' },
  { k: 'dr', label: '画画', fx: { mf: 5, sync: -4 }, log: '麦在桌角画了一整晚。他很久没有这么安静地高兴了。' },
  { k: 'ka', label: '见海人', fx: { mf: -6, trade: 1 }, log: '海人又在说他的电影，和他女朋友"愿意为梦想付出"的事。麦没接话。' }
];
const KINU_ACTS = [
  { k: 'in', label: '主动约他出门', labor: true, fx: { sync: 10 }, log: '绢订了 live 的票、查了路线、算好了他加班的时间。他很开心。' },
  { k: 'ct', label: '照顾猫', labor: true, fx: { sync: 3 }, log: '疫苗、驱虫、换砂。麦回来时只看见一只干净的猫。' },
  { k: 'wr', label: '自己写东西', fx: { kf: 6, kl: 12, sync: -6 }, log: '绢在写自己的东西。她关掉了聊天窗口，这是本周唯一属于她的两小时。' },
  { k: 'mo', label: '应付母亲', labor: true, fx: { kf: -5 }, log: '母亲又打来了。绢说"我们很好"，说了四遍。' }
];
function renderWeek() {
  $script.onclick = null;
  const total = CFG.flow.totalWeeks, slots = CFG.flow.weekSlots;
  if (S.week > total) {
    $switch.hidden = true;
    return veil(`<div class="era">${total} 周之后</div>
      <div class="rule" style="margin:18px auto"></div>
      <p>日子就是这样过去的。<br>没有一周出了错，可是有些东西一直在少。</p>`, step, '继续');
  }
  S.weekUsed = S.weekUsed ?? 0;
  $script.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'week';
  const used = S.weekUsed;
  const slotHtml = Array.from({ length: slots }, (_, i) =>
    `<div class="slot${i < used ? ' used' : ''}"></div>`).join('');
  box.innerHTML = `<div class="wkhead"><b>第 ${S.week} / ${total} 周</b><div class="slots">${slotHtml}</div></div>`;

  const mkRow = (title, acts, isK) => {
    const c = document.createElement('div');
    c.innerHTML = `<div class="wkcol">${title}</div>`;
    const w = document.createElement('div'); w.className = 'wkopts';
    acts.forEach(a => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'wkopt' + (isK ? ' k' : '');
      const drained = a.labor && S.kl <= CFG.labor.exhaustThreshold;
      b.textContent = drained ? '（沉默）' : a.label;
      if (drained || used >= slots) b.disabled = true;
      b.onclick = () => doAct(a, isK);
      w.appendChild(b);
    });
    c.appendChild(w);
    return c;
  };
  box.appendChild(mkRow('麦 的 一 周', MUGI_ACTS, false));
  box.appendChild(mkRow('绢 的 一 周', KINU_ACTS, true));

  const log = document.createElement('div');
  log.className = 'wklog';
  log.textContent = S.weekLog[S.weekLog.length - 1] || '把这一周的时间分给他们。';
  box.appendChild(log);

  if (used >= slots) {
    const go = document.createElement('button');
    go.type = 'button'; go.className = 'wkopt'; go.style.marginTop = '2px';
    go.textContent = '▸ 过完这一周';
    go.onclick = () => {
      S.week++; S.weekUsed = 0;
      // 情感劳动缓慢恢复
      S.kl = clamp(S.kl + CFG.labor.costPerAct * CFG.labor.recoveryRate);
      if (S.week === 5) S.irreversible || renderFxSoft();
      drawHud(); renderWeek();
    };
    box.appendChild(go);
  }
  $script.appendChild(box);
}
function renderFxSoft() { /* 第5周悄悄进入不可逆前夜,不打断节奏 */ }
function doAct(a, isK) {
  const fx = { ...a.fx };
  if (a.labor) fx.kl = (fx.kl || 0) - CFG.labor.costPerAct;
  applyFx(fx);
  S.weekLog.push(a.log);
  S.weekUsed++;
  renderWeek();
}

/* ── 幕末体检报告 ── */
function renderReport() {
  $switch.hidden = true;
  const di = Math.round(declineIndex());
  const rows = [
    ['麦 · 信念', Math.round(S.mf)],
    ['绢 · 信念', Math.round(S.kf)],
    ['绢 · 情感劳动', Math.round(S.kl)],
    ['同步率', Math.round(S.sync) + '%'],
    ['见证的交易', S.trades + ' 次'],
    ['预期凋敝指数', di]
  ].map(([k, v]) => `<div class="row"><span>${k}</span><s>${v}</s></div>`).join('');
  let verdict;
  if (S.kl <= CFG.labor.exhaustThreshold)
    verdict = '绢已经不再主动了。麦会觉得她变了——他不知道她只是花完了。';
  else if (S.sync < CFG.curves.syncStart * 0.6)
    verdict = '同步率掉了一大截，而他们两个都还以为一切正常。';
  else
    verdict = '看起来还很好。花束最漂亮的时候，也正是它已经离开土壤的时候。';
  const near = di >= CFG.flow.declineThreshold ? '麦已经站在「下流志向」的门口：他会在行动之前就先放弃。' :
    '麦还没有完全凋敝。第三幕会替他补上最后几刀。';

  veil(`<div class="rep">
    <div class="rt">关 系 体 检 报 告</div>
    <div class="st" style="text-align:center;margin:8px 0 14px">2017 年夏 · 三轩茶屋</div>
    ${rows}
    <div class="verdict">${verdict}<br><br>${near}</div>
    <div class="seal">未完<br>待续</div>
    <div class="verdict" style="font-size:11.5px;color:#7a776e">本次开发收录到第二幕为止。第三幕「时序错位」、第四幕「温柔告别」与储气罐结局尚未实现。</div>
  </div>`, () => location.reload(), '从头再看一遍');
}

/* ═══════════ 帮助层 ═══════════ */
el('help-open').onclick = () => { buildHelp(); $help.hidden = false; };
function buildHelp() {
  const m = [];
  if (S.unlocked.has('trade')) m.push(['交易属性', '每个社交选项都会被盖章标明它的交易性质。连"纯粹"的选项也算一笔交易——这是设计，不是 bug。']);
  if (S.unlocked.has('labor')) m.push(['情感劳动', '绢每次主动付出都会消耗它，恢复只有消耗的三分之一。见底后她的"主动"选项变成（沉默）。']);
  if (S.unlocked.has('switch')) m.push(['两个视角', '页边纸标可翻到另一个人那一页。关键场景会强制两边各走一遍。']);
  if (S.irreversible) m.push(['不可逆的同步率', '2017 年起同步率只降不升。做同样的事也不会回到那个数字。']);
  const gal = Object.entries(ARTIFACTS).map(([k, a]) => {
    const got = S.found.has(k);
    return `<div class="cell${got ? '' : ' locked'}">
      ${got ? `<img src="${a.img}" alt="">` : '<div style="height:60px"></div>'}
      <b>${got ? a.name : '？？？'}</b>
      ${got ? `<p class="m">麦：${a.mugi}</p><p class="k">绢：${a.kinu}</p>` : ''}
    </div>`;
  }).join('');
  $sheet.innerHTML = `<h3>册 子 的 用 法</h3>
    <h4>操作</h4>
    <p>点文字区推进对话。选项点一下即确认，不能反悔。<br>页边的纸标切换视角；本页角标随时打开这张说明。</p>
    ${m.map(([t, b]) => `<h4>${t}</h4><p>${b}</p>`).join('')}
    <h4>物证册</h4>
    <div class="gal">${gal}</div>
    <button class="close" id="help-close">合 上</button>`;
  el('help-close').onclick = () => { $help.hidden = true; };
}
$help.onclick = e => { if (e.target === $help) $help.hidden = true; };

/* ═══════════ 音乐(首次交互后启动) ═══════════ */
let audioA, audioB, musicOn = false;
function startMusic() {
  if (musicOn) return;
  musicOn = true;
  audioA = new Audio('assets/audio/bgm-bright.wav');
  audioA.loop = true; audioA.volume = 0;
  audioA.play().then(() => fade(audioA, 0.5)).catch(() => {});
}
function switchMusic() {
  if (!musicOn) return;
  fade(audioA, 0);
  if (!audioB) {
    audioB = new Audio('assets/audio/bgm-distant.wav');
    audioB.loop = true; audioB.volume = 0;
  }
  audioB.play().then(() => fade(audioB, 0.45)).catch(() => {});
}
function fade(a, to) {
  const from = a.volume, t0 = performance.now();
  const tick = () => {
    const k = Math.min(1, (performance.now() - t0) / 1400);
    a.volume = from + (to - from) * k;
    if (k < 1) requestAnimationFrame(tick);
    else if (to === 0) a.pause();
  };
  tick();
}
document.addEventListener('visibilitychange', () => {
  if (!musicOn) return;
  const cur = (S.irreversible && audioB) ? audioB : audioA;
  if (!cur) return;
  if (document.hidden) cur.pause();
  else cur.play().catch(() => {});
});

/* ═══════════ 启动 ═══════════ */
applyConfig();
titleScreen();
