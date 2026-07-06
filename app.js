/* ============================================================
   博饼分账 app.js
   数据模型：一笔账 = 谁垫钱(payers) + 为谁花(split) + 怎么分摊
   分账：汇总每人净额 → 最少转账算法 → 谁转给谁
   ============================================================ */

const LS_KEY = 'bobing_v1';
const CURRENCY = 'S$';

/* ── 分类 ─────────────────────────────────────────────── */
const CATEGORIES = [
  { id: 'bobing',  name: '博饼奖金', emoji: '🎲' },
  { id: 'stay',    name: '住宿',     emoji: '🏨' },
  { id: 'food',    name: '餐饮',     emoji: '🍜' },
  { id: 'trans',   name: '交通',     emoji: '🚕' },
  { id: 'fun',     name: '娱乐',     emoji: '🎉' },
  { id: 'other',   name: '其他',     emoji: '🧧' },
];
const catOf = id => CATEGORIES.find(c => c.id === id) || CATEGORIES[5];

/* 博饼六个奖等 + 奖牌 */
const RANK_MEDALS = { '状元':'👑','对堂':'🎓','三红':'🔴','四进':'🀄','二举':'🎏','一秀':'🌸' };

/* 头像配色池：每次打开 app 随机分配一遍，不持久化 */
const AVATAR_COLORS = ['#D62828','#17A398','#118AB2','#E58E26','#2E8B57','#A4161A','#0E7C7B','#FF6B6B','#7d1113','#F6B93B'];
let avatarColorMap = {};
function avatarColor(id) {
  if (!avatarColorMap[id]) {
    const used = new Set(Object.values(avatarColorMap));
    const avail = AVATAR_COLORS.filter(c => !used.has(c));
    const pool = avail.length ? avail : AVATAR_COLORS;
    avatarColorMap[id] = pool[Math.floor(Math.random() * pool.length)];
  }
  return avatarColorMap[id];
}

/* 头像用可爱 emoji 池：每次打开 app 随机分配一遍，不持久化 */
const AVATAR_EMOJI = ['🐱','🐶','🐰','🐻','🐼','🐨','🦁','🐯','🦊','🐷','🐵','🐔','🐧','🦉','🐢','🐙','🦀','🐬','🐳','🦋','🐝','🐸','🦄','🐮','🐹','🦔'];
let avatarEmojiMap = {};
function avatarEmoji(id) {
  if (!avatarEmojiMap[id]) {
    const used = new Set(Object.values(avatarEmojiMap));
    const avail = AVATAR_EMOJI.filter(e => !used.has(e));
    const pool = avail.length ? avail : AVATAR_EMOJI;
    avatarEmojiMap[id] = pool[Math.floor(Math.random() * pool.length)];
  }
  return avatarEmojiMap[id];
}

/* ── 全局状态 ─────────────────────────────────────────── */
let S = null;
let currentTab = 'overview';
let isAdmin = sessionStorage.getItem('bobing_admin') === '1';

/* ── 种子数据（含题面那张博饼预算表） ─────────────────── */
function seed() {
  const people = [
    mkPerson('吴楚晓'),
    mkPerson('成员②'), mkPerson('成员③'), mkPerson('成员④'),
    mkPerson('成员⑤'), mkPerson('成员⑥'), mkPerson('成员⑦'), mkPerson('成员⑧'),
  ];
  const chargeId = people[0].id;
  return {
    version: 1,
    title: '2026 博饼',
    subtitle: '',
    currency: CURRENCY,
    admin_hash: '',                 // 首次解锁时设置
    people,
    bobing: {
      // 每个奖等自带购买负责人 buyers；一秀/二举各 2 人平分该奖数量
      prizes: [
        { rank: '状元', unit: 100, qty: 1,  buyers: [chargeId] },
        { rank: '对堂', unit: 55,  qty: 2,  buyers: [chargeId] },
        { rank: '三红', unit: 25,  qty: 4,  buyers: [chargeId] },
        { rank: '四进', unit: 15,  qty: 8,  buyers: [chargeId] },
        { rank: '二举', unit: 3,   qty: 16, buyers: [chargeId, ''] },
        { rank: '一秀', unit: 1,   qty: 32, buyers: [chargeId, ''] },
      ],
      participants: people.map(p => p.id),          // 8 人平摊 → 人均 63.75
    },
    expenses: [],
    updated_at: new Date().toISOString(),
  };
}
function mkPerson(name) { return { id: 'p' + Math.random().toString(36).slice(2, 8), name }; }
function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

/* ── 工具 ─────────────────────────────────────────────── */
function money(v) {
  const n = Math.round((v + 1e-9) * 100) / 100;
  const s = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return (S?.currency || CURRENCY) + s;
}
function personName(id) { const p = S.people.find(x => x.id === id); return p ? p.name : '？'; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ── 持久化 + 同步 ────────────────────────────────────── */
function saveLocal() { localStorage.setItem(LS_KEY, JSON.stringify(S)); }

/* 管理员写入：本地 + 云端（并每日自动备份一次） */
async function commit(msg) {
  S.updated_at = new Date().toISOString();
  saveLocal();
  render();
  const ok = await window.saveToCloud(S);
  toast(ok ? (msg || '已保存 ✓') : '云端保存失败，仅本地', ok ? 2000 : 3000);
  if (ok) autoBackup();
}

/* 每日自动备份：当天第一次写入时存一份 bobing_auto_YYYY-MM-DD */
async function autoBackup() {
  const today = new Date().toISOString().slice(0, 10);
  if (localStorage.getItem('bobing_auto_date') === today) return;
  try {
    await window.saveSnapshot('bobing_auto_' + today, S);
    localStorage.setItem('bobing_auto_date', today);
  } catch (e) { console.warn(e); }
}

/* ── 分账核心：把博饼当成一笔虚拟支出 ─────────────────── */
function prizeCost(p) { return (+p.unit || 0) * (+p.qty || 0); }
function bobingTotal() { return S.bobing.prizes.reduce((s, p) => s + prizeCost(p), 0); }

/* 由各奖 buyers 推导出每人的垫付总额（一个奖多个负责人 → 均分该奖金额） */
function bobingPayers() {
  const m = {};
  for (const p of S.bobing.prizes) {
    const bs = (p.buyers || []).filter(Boolean);
    if (!bs.length) continue;
    const each = prizeCost(p) / bs.length;
    bs.forEach(pid => m[pid] = (m[pid] || 0) + each);
  }
  return Object.entries(m).map(([person, paid]) => ({ person, paid }));
}
/* 尚未指定负责人的奖金（无人垫付，会导致账不平，用于提示） */
function bobingUnassigned() {
  return S.bobing.prizes.reduce((s, p) => s + ((p.buyers || []).filter(Boolean).length ? 0 : prizeCost(p)), 0);
}

function bobingItem() {
  return {
    id: 'bobing', title: '博饼奖金池', category: 'bobing',
    amount: bobingTotal(),
    payers: bobingPayers(),
    split: { mode: 'equal', among: S.bobing.participants || [] },
  };
}
function allItems() { return [bobingItem(), ...S.expenses]; }

/* 单笔账 → 每个受益人应承担的份额 {personId: amount} */
function sharesOf(it) {
  const out = {}; const sp = it.split || {};
  if (sp.mode === 'shares') {
    const sh = sp.shares || {}; const tot = Object.values(sh).reduce((a, b) => a + (+b || 0), 0) || 1;
    for (const [pid, s] of Object.entries(sh)) out[pid] = it.amount * (+s || 0) / tot;
  } else if (sp.mode === 'exact') {
    for (const [pid, a] of Object.entries(sp.exact || {})) out[pid] = +a || 0;
  } else { // equal
    const among = (sp.among || []).filter(pid => S.people.some(p => p.id === pid));
    if (!among.length) return out;
    const each = it.amount / among.length;
    among.forEach(pid => out[pid] = (out[pid] || 0) + each);
  }
  return out;
}

/* 汇总每人净额：垫付 - 应承担。正=别人欠他，负=他欠别人 */
function computeBalances() {
  const bal = {}; S.people.forEach(p => bal[p.id] = 0);
  for (const it of allItems()) {
    for (const pay of (it.payers || [])) if (bal[pay.person] != null) bal[pay.person] += (+pay.paid || 0);
    const sh = sharesOf(it);
    for (const [pid, owe] of Object.entries(sh)) if (bal[pid] != null) bal[pid] -= owe;
  }
  return bal;
}

/* 最少转账算法 */
function settle(bal) {
  const cred = [], debt = [];
  for (const [p, v] of Object.entries(bal)) {
    if (v > 0.005) cred.push({ p, v });
    else if (v < -0.005) debt.push({ p, v: -v });
  }
  cred.sort((a, b) => b.v - a.v); debt.sort((a, b) => b.v - a.v);
  const txns = []; let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const d = debt[i], c = cred[j];
    const amt = Math.min(d.v, c.v);
    txns.push({ from: d.p, to: c.p, amount: amt });
    d.v -= amt; c.v -= amt;
    if (d.v < 0.005) i++;
    if (c.v < 0.005) j++;
  }
  return txns;
}

/* ============================================================
   渲染
   ============================================================ */
function render() {
  document.getElementById('app-title').textContent = S.title || '博饼分账';
  const sub = document.getElementById('app-sub');
  sub.textContent = S.subtitle || '';
  sub.classList.toggle('hide', !S.subtitle);
  const lb = document.getElementById('lock-btn');
  lb.textContent = isAdmin ? '🔓' : '🔒';
  lb.classList.toggle('unlocked', isAdmin);

  const el = document.getElementById('content');
  if (currentTab === 'overview') el.innerHTML = viewOverview();
  else if (currentTab === 'bobing') el.innerHTML = viewBobing();
  else if (currentTab === 'expenses') el.innerHTML = viewExpenses();
  else if (currentTab === 'people') el.innerHTML = viewPeople();
  bindDynamic();
}

/* ── 总览 ─────────────────────────────────────────────── */
function viewOverview() {
  const bal = computeBalances();
  const txns = settle(bal);
  const total = allItems().reduce((s, it) => s + it.amount, 0);
  const n = S.people.length || 1;

  const settleHtml = txns.length
    ? txns.map(t => `
        <div class="txn">
          <span class="who">${esc(personName(t.from))}</span>
          <span class="arrow">→</span>
          <span class="who">${esc(personName(t.to))}</span>
          <span class="amt">${money(t.amount)}</span>
        </div>`).join('')
    : `<div class="settle-clear">🎊 大家两清，无需转账！</div>`;

  const balHtml = S.people.map(p => {
    const v = bal[p.id] || 0;
    const cls = v > 0.005 ? 'pos' : v < -0.005 ? 'neg' : 'zero';
    const txt = v > 0.005 ? `+${money(v)}` : v < -0.005 ? `-${money(-v)}` : money(0);
    const label = v > 0.005 ? '应收回' : v < -0.005 ? '需支出' : '已平';
    return `<div class="bal-row">
      <span class="avatar" style="background:${avatarColor(p.id)}">${avatarEmoji(p.id)}</span>
      <span class="nm">${esc(p.name)}</span>
      <span class="net ${cls}">${txt}<span style="font-size:10px;color:var(--ink-soft);margin-left:4px">${label}</span></span>
    </div>`;
  }).join('');

  return `
    <div class="section-hd"><h2><span>🧧</span>账目总览</h2></div>

    <div class="settle-hero">
      <h2>💰 谁转给谁</h2>
      <div class="hint">按下面转一圈，全场账目一次结清</div>
      ${settleHtml}
    </div>

    <div class="stat-row">
      <div class="stat"><div class="val">${money(total)}</div><div class="lab">总支出</div></div>
      <div class="stat gold"><div class="val">${money(total / n)}</div><div class="lab">人均</div></div>
      <div class="stat teal"><div class="val">${S.people.length}</div><div class="lab">参与人数</div></div>
    </div>

    <div class="card">
      <div class="card-title"><span class="emoji">🧮</span>每人余额明细</div>
      <div class="bal-list">${balHtml}</div>
    </div>

    ${isAdmin ? `
    <div class="card">
      <div class="card-title"><span class="emoji">☁️</span>云端备份与恢复</div>
      <p style="font-size:13px;color:var(--ink-soft);margin:0 0 12px">
        数据实时存在云端（Supabase），换设备/清缓存都不丢。每天首次改动会自动存一份历史备份。
      </p>
      <div class="row2">
        <button class="btn btn-teal" data-act="quick-backup">📸 立即备份</button>
        <button class="btn btn-gold" data-act="open-backup">🗂️ 备份管理</button>
      </div>
    </div>` : ''}

    <div class="readonly-note">
      ${isAdmin ? '🔓 管理员模式 · 数据已同步云端 ✓' : '👀 只读模式 · 点右上角 🔒 输入密码可编辑'}
    </div>`;
}

/* ── 博饼奖表 ─────────────────────────────────────────── */
function viewBobing() {
  const b = S.bobing;
  const total = bobingTotal();
  const parts = (b.participants || []).length || 1;
  const rows = b.prizes.map((p, i) => {
    const medal = RANK_MEDALS[p.rank] || '🎲';
    const bs = (p.buyers || []).filter(Boolean);
    const owner = bs.length ? bs.map(pid => esc(personName(pid))).join('/') : `<span style="color:var(--red)">未定</span>`;
    return `<tr>
      <td class="rank"><span class="medal">${medal}</span>${esc(p.rank)}</td>
      <td>${isAdmin ? `<input class="mini-input" type="number" inputmode="decimal" data-prize="${i}" data-k="unit" value="${p.unit}">` : money(p.unit)}</td>
      <td>${isAdmin ? `<input class="mini-input" type="number" inputmode="numeric" data-prize="${i}" data-k="qty" value="${p.qty}">` : p.qty}</td>
      <td><b>${money(prizeCost(p))}</b></td>
      <td class="owner">${owner}</td>
    </tr>`;
  }).join('');

  const payers = bobingPayers();
  const payerTxt = payers.length
    ? payers.map(p => `${esc(personName(p.person))} ${money(p.paid)}`).join('、')
    : '未设置';
  const unassigned = bobingUnassigned();

  return `
    <div class="section-hd"><h2><span>🎲</span>博饼采购</h2>
      ${isAdmin ? '<button class="btn btn-teal btn-sm" data-act="bobing-setup">⚙️ 参与人</button>' : ''}
    </div>

    <div class="card festive">
      <table class="prize-table">
        <thead><tr><th>奖等</th><th>单价</th><th>数量</th><th>单项总价</th><th>负责人</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td class="rank">合计</td><td></td><td></td><td>${money(total)}</td><td></td></tr></tfoot>
      </table>

      <div class="prize-foot">
        <div class="stat"><div class="val">${money(total)}</div><div class="lab">奖金总额</div></div>
        <div class="stat gold"><div class="val">${money(total / parts)}</div><div class="lab">人均分摊</div></div>
        <div class="stat teal"><div class="val">${parts}</div><div class="lab">参与人数</div></div>
      </div>

      ${unassigned > 0.005 ? `<div class="balance-warn bad" style="margin-top:10px">⚠️ 还有 ${money(unassigned)} 奖金未指定负责人，账会不平 · 去「成员」页设置</div>` : ''}
      <div class="charge-row" style="background:rgba(23,163,152,.10);margin-top:12px">
        <span>💵</span><span class="lab" style="color:var(--teal-deep)">合计垫付：</span><span>${payerTxt}</span>
      </div>
    </div>

    <div class="readonly-note">负责人在「🐚 成员」页设置 · ${isAdmin ? '改单价/数量即时生效' : '仅管理员可编辑'}</div>`;
}

/* ── 账目 ─────────────────────────────────────────────── */
function viewExpenses() {
  const list = S.expenses;
  const body = list.length ? list.map(expCard).join('') : `
    <div class="empty">
      <div class="big">🧾</div>
      <p>还没有其它账目<br>比如「LISHA 订房 60，ABC 请 DE 吃饭」</p>
      ${isAdmin ? '<button class="btn btn-primary" data-act="add-exp">➕ 记第一笔</button>' : '<div class="readonly-note">点右上角 🔒 解锁后可添加</div>'}
    </div>`;
  return `
    <div class="section-hd"><h2><span>🧾</span>其它账目 <span style="font-size:12px;color:var(--ink-soft)">(${list.length})</span></h2></div>
    ${body}
    ${isAdmin && list.length ? '<button class="btn btn-fab" data-act="add-exp" title="记一笔">＋</button>' : ''}`;
}

function expCard(e) {
  const c = catOf(e.category);
  const payers = (e.payers || []).map(p => `<b>${esc(personName(p.person))}</b> ${money(p.paid)}`).join(' + ') || '—';
  const sh = sharesOf(e);
  const users = Object.keys(sh).map(pid => `<span class="use">${esc(personName(pid))}</span>(${money(sh[pid])})`).join('、') || '—';
  const modeTxt = { equal: '平摊', shares: '按份', exact: '指定' }[e.split?.mode] || '平摊';
  return `
    <div class="exp-card">
      <div class="exp-top">
        <div class="exp-cat">${c.emoji}</div>
        <div class="exp-main">
          <div class="exp-title">${esc(e.title)}</div>
          <div class="exp-meta">${esc(e.date || '')} · <span class="chip">${c.name}</span></div>
        </div>
        <div class="exp-amt">${money(e.amount)}</div>
      </div>
      <div class="exp-flow">
        💵 谁付：${payers}<br>
        🍽️ 谁用（${modeTxt}）：${users}
        ${e.note ? `<br>📝 ${esc(e.note)}` : ''}
      </div>
      ${isAdmin ? `<div class="exp-actions">
        <button class="btn btn-ghost btn-sm" data-act="edit-exp" data-id="${e.id}">✏️ 编辑</button>
        <button class="btn btn-danger btn-sm" data-act="del-exp" data-id="${e.id}">🗑️ 删除</button>
      </div>` : ''}
    </div>`;
}

/* ── 成员 ─────────────────────────────────────────────── */
function viewPeople() {
  const rows = S.people.map(p => {
    const ranks = S.bobing.prizes.filter(pr => (pr.buyers || []).includes(p.id)).map(pr => pr.rank);
    return `
    <div class="person-row">
      <span class="avatar" style="background:${avatarColor(p.id)}">${avatarEmoji(p.id)}</span>
      <div class="person-main">
        <span class="nm">${esc(p.name)}</span>
        ${ranks.length ? `<span class="tag-charge">🛒 负责 ${ranks.map(esc).join('/')}</span>` : ''}
      </div>
      <div class="person-btns">
        ${isAdmin ? `<button class="btn btn-teal btn-sm" data-act="person-prizes" data-id="${p.id}">🎲 负责奖项</button>
          <button class="btn btn-ghost btn-sm" data-act="edit-person" data-id="${p.id}">✏️</button>
          <button class="btn btn-danger btn-sm" data-act="del-person" data-id="${p.id}">🗑️</button>` : ''}
      </div>
    </div>`;
  }).join('');
  return `
    <div class="section-hd"><h2><span>🐚</span>成员管理 <span style="font-size:12px;color:var(--ink-soft)">(${S.people.length})</span></h2></div>
    ${rows}
    ${isAdmin ? '<button class="btn btn-gold btn-block" data-act="add-person" style="margin-top:8px">➕ 添加成员</button>'
              : '<div class="readonly-note">点右上角 🔒 解锁后可增删成员</div>'}`;
}

/* ============================================================
   交互绑定
   ============================================================ */
function bindDynamic() {
  // 博饼单价/数量即时编辑
  document.querySelectorAll('[data-prize]').forEach(inp => {
    inp.addEventListener('change', () => {
      const i = +inp.dataset.prize, k = inp.dataset.k;
      S.bobing.prizes[i][k] = k === 'qty' ? Math.max(0, Math.round(+inp.value || 0)) : Math.max(0, +inp.value || 0);
      commit('博饼奖表已更新');
    });
  });
  // data-act 统一委托
  document.getElementById('content').onclick = onActionClick;
}

function onActionClick(ev) {
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act, id = btn.dataset.id;
  if (!isAdmin && act !== '') { /* 只读页里不会渲染写按钮，双保险 */ }
  if (act === 'add-exp') openExpModal(null);
  else if (act === 'edit-exp') openExpModal(S.expenses.find(e => e.id === id));
  else if (act === 'del-exp') { if (confirm('删除这笔账？')) { S.expenses = S.expenses.filter(e => e.id !== id); commit('已删除'); } }
  else if (act === 'add-person') openPersonModal(null);
  else if (act === 'edit-person') openPersonModal(S.people.find(p => p.id === id));
  else if (act === 'del-person') delPerson(id);
  else if (act === 'bobing-setup') openBobingSetup();
  else if (act === 'person-prizes') openPersonPrizesModal(id);
  else if (act === 'quick-backup') quickBackup();
  else if (act === 'open-backup') openBackupModal();
}

/* ── 立即备份：存一份带时间戳的手动备份 ───────────────── */
async function quickBackup() {
  try {
    await window.saveSnapshot('bobing_manual_' + new Date().toISOString(), S);
    toast('已备份到云端 ✓');
  } catch (e) { toast('备份失败：' + e.message, 3000); }
}

/* ── 备份管理弹窗 ─────────────────────────────────────── */
let _snaps = [];
function snapMeta(d) { return `${d?.people?.length || 0}人 · ${(d?.expenses?.length || 0)}笔账`; }
function friendlyName(name) {
  if (name.startsWith('bobing_slot_')) return '存档位 ' + name.slice(-1);
  if (name.startsWith('bobing_auto_')) return '每日自动 ' + name.slice('bobing_auto_'.length);
  if (name.startsWith('bobing_manual_')) return '手动备份';
  if (name.startsWith('bobing_pre_restore_')) return '恢复前存档';
  return name;
}
function fmtTime(iso) {
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function openBackupModal() {
  openModal(`
    <div class="modal-hd"><h3>🗂️ 备份管理</h3><button class="modal-close" data-close>✕</button></div>

    <div class="field">
      <label>本地导出 / 导入 <span class="sub">存成 JSON 文件，离线保存或换设备用</span></label>
      <div class="row2">
        <button class="btn btn-teal" id="export-local-btn">📤 导出到本地</button>
        <button class="btn btn-gold" id="import-local-btn">📥 从本地导入</button>
      </div>
      <input type="file" id="import-local-file" accept="application/json,.json" class="hide">
    </div>

    <div class="field"><label>手动存档位 <span class="sub">覆盖式，共 3 位</span></label><div id="slots" class="slot-list">加载中…</div></div>
    <div class="field"><label>历史备份 <span class="sub">每日自动 / 手动 / 恢复前</span></label><div id="snaps" class="slot-list">加载中…</div></div>`);

  document.getElementById('export-local-btn').onclick = exportLocalBackup;
  document.getElementById('import-local-btn').onclick = () => document.getElementById('import-local-file').click();
  document.getElementById('import-local-file').onchange = ev => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (file) importLocalBackup(file);
  };

  // 弹窗内事件委托
  document.querySelector('.modal').addEventListener('click', async ev => {
    const t = ev.target.closest('[data-save-slot],[data-restore],[data-del-snap]');
    if (!t) return;
    if (t.dataset.saveSlot) {
      try { await window.saveSnapshot('bobing_slot_' + t.dataset.saveSlot, S); toast(`已存入存档位 ${t.dataset.saveSlot} ✓`); await refreshBackupList(); }
      catch (e) { toast('失败：' + e.message, 3000); }
    } else if (t.dataset.restore) {
      if (confirm('用这份备份覆盖当前数据？\n（会先自动存一份「恢复前」备份，可再撤回）')) await doRestore(t.dataset.restore);
    } else if (t.dataset.delSnap) {
      if (confirm('删除这份备份？')) { try { await window.deleteSnapshot(t.dataset.delSnap); await refreshBackupList(); toast('已删除'); } catch (e) { toast('失败：' + e.message, 3000); } }
    }
  });
  await refreshBackupList();
}

/* ── 本地导出 / 导入（纯浏览器文件操作，不经过云端） ─────── */
function exportLocalBackup() {
  const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bobing-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast('已导出到本地 ✓');
}

function importLocalBackup(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    let data;
    try { data = JSON.parse(reader.result); } catch (e) { toast('不是有效的 JSON 文件'); return; }
    if (!data || !Array.isArray(data.people)) { toast('文件内容不像是博饼分账的备份数据'); return; }
    if (!confirm('导入这份本地备份会覆盖当前数据？\n（会先自动存一份「恢复前」云端备份，可再撤回）')) return;
    await applyRestoredData(data);
    toast('本地备份已导入 ✓');
  };
  reader.onerror = () => toast('文件读取失败');
  reader.readAsText(file);
}

async function refreshBackupList() {
  _snaps = await window.loadSnapshots();
  const slots = document.getElementById('slots');
  const snaps = document.getElementById('snaps');
  if (slots) slots.innerHTML = [1, 2, 3].map(i => {
    const s = _snaps.find(x => x.name === 'bobing_slot_' + i);
    return `<div class="slot-row">
      <div class="slot-info"><b>存档位 ${i}</b><span class="sub-amt">${s ? fmtTime(s.created_at) + ' · ' + snapMeta(s.data) : '空'}</span></div>
      <div class="slot-btns">
        <button class="btn btn-teal btn-sm" data-save-slot="${i}">存入</button>
        ${s ? `<button class="btn btn-ghost btn-sm" data-restore="${s.name}">恢复</button>` : ''}
      </div></div>`;
  }).join('');
  if (snaps) {
    const list = _snaps.filter(x => !x.name.startsWith('bobing_slot_'));
    snaps.innerHTML = list.length ? list.map(s => `<div class="slot-row">
      <div class="slot-info"><b>${friendlyName(s.name)}</b><span class="sub-amt">${fmtTime(s.created_at)} · ${snapMeta(s.data)}</span></div>
      <div class="slot-btns">
        <button class="btn btn-ghost btn-sm" data-restore="${s.name}">恢复</button>
        <button class="btn btn-danger btn-sm" data-del-snap="${s.name}">🗑️</button>
      </div></div>`).join('') : '<div class="sub-amt" style="padding:8px 2px">还没有历史备份</div>';
  }
}

async function doRestore(name) {
  const data = await window.getSnapshot(name);
  if (!data || !data.people) { toast('读取失败'); return; }
  await applyRestoredData(data);
  toast('已恢复 ✓');
}

/* 恢复前先存一份安全备份，再用给定数据整体替换当前状态（本地+云端） */
async function applyRestoredData(data) {
  try { await window.saveSnapshot('bobing_pre_restore_' + new Date().toISOString(), S); } catch (e) { console.warn(e); }
  S = migrate(data);
  saveLocal();
  await window.saveToCloud(S);
  closeModal(); render();
}

/* ── 顶栏锁 ───────────────────────────────────────────── */
document.getElementById('lock-btn').addEventListener('click', onLockClick);
async function onLockClick() {
  if (isAdmin) {
    isAdmin = false; sessionStorage.removeItem('bobing_admin');
    render(); toast('已锁定 🔒');
    return;
  }
  if (!S.admin_hash) {
    const pw = prompt('首次设置管理员密码（记牢，用于以后写入）：');
    if (!pw) return;
    const pw2 = prompt('再输一次确认：');
    if (pw !== pw2) { toast('两次不一致'); return; }
    S.admin_hash = await sha256(pw);
    isAdmin = true; sessionStorage.setItem('bobing_admin', '1');
    await commit('管理员密码已设置 🔓');
    return;
  }
  const pw = prompt('输入管理员密码：');
  if (!pw) return;
  if (await sha256(pw) === S.admin_hash) {
    isAdmin = true; sessionStorage.setItem('bobing_admin', '1');
    render(); toast('已解锁 🔓 可以编辑啦');
  } else { toast('密码错误 ❌'); }
}

/* ── 底部导航 ─────────────────────────────────────────── */
document.querySelectorAll('.nav-btn').forEach(b => {
  b.addEventListener('click', () => {
    currentTab = b.dataset.tab;
    document.querySelectorAll('.nav-btn').forEach(x => x.classList.toggle('active', x === b));
    render();
    document.getElementById('content').scrollIntoView({ block: 'start' });
  });
});

/* ============================================================
   模态：记一笔 / 编辑账
   ============================================================ */
function openExpModal(exp) {
  const editing = !!exp;
  const e = exp ? JSON.parse(JSON.stringify(exp)) : {
    id: uid('e'), date: new Date().toISOString().slice(0, 10),
    title: '', category: 'food', amount: 0,
    payers: [], split: { mode: 'equal', among: S.people.map(p => p.id), shares: {}, exact: {} },
  };
  // 草稿态
  const draft = {
    ...e,
    split: { mode: e.split?.mode || 'equal', among: e.split?.among || [], shares: e.split?.shares || {}, exact: e.split?.exact || {} },
    multiPay: (e.payers || []).length > 1,
    payMap: Object.fromEntries((e.payers || []).map(p => [p.person, p.paid])),
    singlePayer: (e.payers || [])[0]?.person || S.people[0]?.id || '',
  };

  const html = `
    <div class="modal-hd">
      <h3>${editing ? '✏️ 编辑账目' : '🧾 记一笔'}</h3>
      <button class="modal-close" data-close>✕</button>
    </div>

    <div class="field">
      <label>账目名称</label>
      <input class="input" id="f-title" placeholder="如：订房 / 烧烤食材 / 打车" value="${esc(draft.title)}">
    </div>

    <div class="field">
      <label>分类</label>
      <div class="cat-grid" id="f-cat">
        ${CATEGORIES.filter(c => c.id !== 'bobing').map(c =>
          `<div class="cat-opt ${draft.category === c.id ? 'sel' : ''}" data-cat="${c.id}"><span class="ce">${c.emoji}</span>${c.name}</div>`).join('')}
      </div>
    </div>

    <div class="row2">
      <div class="field"><label>金额 <span class="sub">${S.currency}</span></label>
        <input class="input" id="f-amt" type="number" inputmode="decimal" placeholder="0" value="${draft.amount || ''}"></div>
      <div class="field"><label>日期</label>
        <input class="input" id="f-date" type="date" value="${esc(draft.date)}"></div>
    </div>

    <div class="field">
      <label>💵 谁付的钱</label>
      <div id="pay-single" class="${draft.multiPay ? 'hide' : ''}">
        <select class="select" id="f-payer">
          ${S.people.map(p => `<option value="${p.id}" ${draft.singlePayer === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
        <div class="pick-tools"><span class="mini-link" id="to-multi">👥 多人一起付</span></div>
      </div>
      <div id="pay-multi" class="${draft.multiPay ? '' : 'hide'}">
        <div class="pick-list" id="pay-list">
          ${S.people.map(p => payerRow(p, draft.payMap[p.id])).join('')}
        </div>
        <div class="pick-tools">
          <span class="mini-link" id="pay-even">平均垫付</span>
          <span class="mini-link" id="to-single">↩︎ 单人付</span>
        </div>
        <div class="balance-warn" id="pay-warn"></div>
      </div>
    </div>

    <div class="field">
      <label>🍽️ 这钱为谁花 · 怎么分</label>
      <div class="seg" id="f-mode">
        <button data-mode="equal" class="${draft.split.mode === 'equal' ? 'on' : ''}">平摊</button>
        <button data-mode="shares" class="${draft.split.mode === 'shares' ? 'on' : ''}">按份数</button>
        <button data-mode="exact" class="${draft.split.mode === 'exact' ? 'on' : ''}">指定金额</button>
      </div>
      <div class="pick-tools"><span class="mini-link" id="ben-all">全选</span><span class="mini-link" id="ben-none">清空</span></div>
      <div class="pick-list" id="ben-list"></div>
      <div class="balance-warn" id="ben-warn"></div>
    </div>

    <button class="btn btn-primary btn-block" id="f-save" style="margin-top:8px">${editing ? '保存修改' : '💾 记下这一笔'}</button>
  `;
  openModal(html);

  /* —— 模态内事件 —— */
  const $ = s => document.querySelector(s);

  // 分类
  $('#f-cat').onclick = ev => {
    const o = ev.target.closest('[data-cat]'); if (!o) return;
    draft.category = o.dataset.cat;
    document.querySelectorAll('#f-cat .cat-opt').forEach(x => x.classList.toggle('sel', x === o));
  };
  // 付款：单/多切换
  $('#to-multi').onclick = () => { draft.multiPay = true; $('#pay-single').classList.add('hide'); $('#pay-multi').classList.remove('hide'); syncPayWarn(); };
  $('#to-single').onclick = () => { draft.multiPay = false; $('#pay-multi').classList.add('hide'); $('#pay-single').classList.remove('hide'); };
  $('#pay-even').onclick = () => {
    const amt = +$('#f-amt').value || 0;
    const checked = [...document.querySelectorAll('#pay-list .pick.on')].map(x => x.dataset.pid);
    const use = checked.length ? checked : S.people.map(p => p.id);
    const each = Math.round((amt / use.length) * 100) / 100;
    document.querySelectorAll('#pay-list .pick').forEach(row => {
      const on = use.includes(row.dataset.pid);
      row.classList.toggle('on', on);
      row.querySelector('.box').textContent = on ? '✓' : '';
      row.querySelector('.amt-in').value = on ? each : '';
    });
    syncPayWarn();
  };
  $('#pay-list').onclick = ev => {
    const row = ev.target.closest('.pick'); if (!row || ev.target.classList.contains('amt-in')) return;
    const on = !row.classList.contains('on');
    row.classList.toggle('on', on);
    row.querySelector('.box').textContent = on ? '✓' : '';
    if (!on) row.querySelector('.amt-in').value = '';
    syncPayWarn();
  };
  $('#pay-list').addEventListener('input', ev => { if (ev.target.classList.contains('amt-in')) syncPayWarn(); });
  $('#f-amt').addEventListener('input', () => { syncPayWarn(); renderBen(); });

  function syncPayWarn() {
    const amt = +$('#f-amt').value || 0;
    let sum = 0;
    document.querySelectorAll('#pay-list .pick.on .amt-in').forEach(i => sum += +i.value || 0);
    const w = $('#pay-warn'); const diff = Math.round((amt - sum) * 100) / 100;
    if (Math.abs(diff) < 0.01) { w.className = 'balance-warn ok'; w.textContent = `✓ 垫付合计 ${money(sum)} = 金额`; }
    else { w.className = 'balance-warn bad'; w.textContent = `垫付合计 ${money(sum)}，与金额差 ${money(Math.abs(diff))}`; }
  }

  // 分摊模式
  $('#f-mode').onclick = ev => {
    const b = ev.target.closest('[data-mode]'); if (!b) return;
    draft.split.mode = b.dataset.mode;
    document.querySelectorAll('#f-mode button').forEach(x => x.classList.toggle('on', x === b));
    renderBen();
  };
  $('#ben-all').onclick = () => { S.people.forEach(p => setBen(p.id, true)); renderBen(); };
  $('#ben-none').onclick = () => { draft.split.among = []; draft.split.shares = {}; draft.split.exact = {}; renderBen(); };

  function isBenOn(pid) {
    if (draft.split.mode === 'equal') return draft.split.among.includes(pid);
    if (draft.split.mode === 'shares') return (+draft.split.shares[pid] || 0) > 0;
    return draft.split.exact[pid] != null;
  }
  function setBen(pid, on) {
    if (draft.split.mode === 'equal') {
      draft.split.among = on ? [...new Set([...draft.split.among, pid])] : draft.split.among.filter(x => x !== pid);
    } else if (draft.split.mode === 'shares') {
      if (on) draft.split.shares[pid] = draft.split.shares[pid] || 1; else delete draft.split.shares[pid];
    } else {
      if (on) draft.split.exact[pid] = draft.split.exact[pid] || 0; else delete draft.split.exact[pid];
    }
  }
  function renderBen() {
    const mode = draft.split.mode;
    const amt = +$('#f-amt').value || 0;
    const list = $('#ben-list');
    list.innerHTML = S.people.map(p => {
      const on = isBenOn(p.id);
      let right = '';
      if (on && mode === 'shares') right = `<input class="amt-in" data-ben="${p.id}" type="number" inputmode="numeric" value="${draft.split.shares[p.id] || 1}" placeholder="份">`;
      else if (on && mode === 'exact') right = `<input class="amt-in" data-ben="${p.id}" type="number" inputmode="decimal" value="${draft.split.exact[p.id] || ''}" placeholder="金额">`;
      else if (on && mode === 'equal') {
        const among = draft.split.among.length || 1;
        right = `<span style="font-size:12px;color:var(--ink-soft)">${money(amt / among)}</span>`;
      }
      return `<div class="pick ${on ? 'on' : ''}" data-pid="${p.id}">
        <span class="box">${on ? '✓' : ''}</span><span class="nm">${esc(p.name)}</span>${right}</div>`;
    }).join('');
    // 事件
    list.onclick = ev => {
      const row = ev.target.closest('.pick'); if (!row || ev.target.classList.contains('amt-in')) return;
      setBen(row.dataset.pid, !isBenOn(row.dataset.pid)); renderBen();
    };
    list.addEventListener('input', ev => {
      const i = ev.target; if (!i.classList.contains('amt-in')) return;
      const pid = i.dataset.ben;
      if (mode === 'shares') draft.split.shares[pid] = +i.value || 0;
      else if (mode === 'exact') draft.split.exact[pid] = +i.value || 0;
      syncBenWarn();
    });
    syncBenWarn();
  }
  function syncBenWarn() {
    const w = $('#ben-warn'); const amt = +$('#f-amt').value || 0; const mode = draft.split.mode;
    if (mode === 'exact') {
      const sum = Object.values(draft.split.exact).reduce((a, b) => a + (+b || 0), 0);
      const diff = Math.round((amt - sum) * 100) / 100;
      if (Math.abs(diff) < 0.01) { w.className = 'balance-warn ok'; w.textContent = `✓ 指定合计 = 金额`; }
      else { w.className = 'balance-warn bad'; w.textContent = `指定合计 ${money(sum)}，与金额差 ${money(Math.abs(diff))}`; }
    } else if (mode === 'shares') {
      const cnt = Object.keys(draft.split.shares).length;
      w.className = 'balance-warn ok'; w.textContent = cnt ? `按 ${Object.values(draft.split.shares).reduce((a,b)=>a+(+b||0),0)} 份分摊` : '';
    } else {
      w.className = 'balance-warn ok'; w.textContent = draft.split.among.length ? `${draft.split.among.length} 人平摊，每人 ${money(amt / draft.split.among.length)}` : '请勾选参与的人';
    }
  }
  renderBen();
  if (draft.multiPay) syncPayWarn();

  // 保存
  $('#f-save').onclick = () => {
    const title = $('#f-title').value.trim();
    const amount = Math.round((+$('#f-amt').value || 0) * 100) / 100;
    if (!title) { toast('给这笔账起个名'); return; }
    if (amount <= 0) { toast('金额要大于 0'); return; }

    // 付款方
    let payers;
    if (draft.multiPay) {
      payers = [...document.querySelectorAll('#pay-list .pick.on')].map(row => ({
        person: row.dataset.pid, paid: Math.round((+row.querySelector('.amt-in').value || 0) * 100) / 100,
      })).filter(p => p.paid > 0);
      const sum = payers.reduce((a, b) => a + b.paid, 0);
      if (Math.abs(sum - amount) > 0.01) { toast('垫付合计要等于金额'); return; }
    } else {
      payers = [{ person: $('#f-payer').value, paid: amount }];
    }

    // 分摊
    const split = { mode: draft.split.mode };
    if (draft.split.mode === 'equal') {
      if (!draft.split.among.length) { toast('请勾选谁用了这笔钱'); return; }
      split.among = draft.split.among;
    } else if (draft.split.mode === 'shares') {
      const sh = {}; Object.entries(draft.split.shares).forEach(([k, v]) => { if (+v > 0) sh[k] = +v; });
      if (!Object.keys(sh).length) { toast('请设置份数'); return; }
      split.shares = sh;
    } else {
      const ex = {}; Object.entries(draft.split.exact).forEach(([k, v]) => { if (+v > 0) ex[k] = +v; });
      const sum = Object.values(ex).reduce((a, b) => a + b, 0);
      if (Math.abs(sum - amount) > 0.01) { toast('指定金额合计要等于金额'); return; }
      split.exact = ex;
    }

    const rec = { id: draft.id, date: $('#f-date').value, title, category: draft.category, amount, payers, split, note: draft.note || '' };
    const idx = S.expenses.findIndex(x => x.id === rec.id);
    if (idx >= 0) S.expenses[idx] = rec; else S.expenses.push(rec);
    S.expenses.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    closeModal(); commit(exp ? '已保存修改 ✓' : '记好啦 ✓');
  };
}

function payerRow(p, amt) {
  const on = amt != null;
  return `<div class="pick ${on ? 'on' : ''}" data-pid="${p.id}">
    <span class="box">${on ? '✓' : ''}</span><span class="nm">${esc(p.name)}</span>
    <input class="amt-in" type="number" inputmode="decimal" placeholder="垫付" value="${on ? amt : ''}"></div>`;
}

/* ── 博饼参与人设置（谁平摊奖金池；各奖购买负责人在「成员」页设置）── */
function openBobingSetup() {
  const b = S.bobing;
  const parts = new Set(b.participants || []);
  const total = bobingTotal();

  const html = `
    <div class="modal-hd"><h3>⚙️ 参与人设置</h3><button class="modal-close" data-close>✕</button></div>
    <div class="field">
      <label>参与平摊的人 <span class="sub">奖金池 ${money(total)} 按这些人均分</span></label>
      <div class="pick-list" id="b-parts">
        ${S.people.map(p => `<div class="pick ${parts.has(p.id) ? 'on' : ''}" data-pid="${p.id}">
          <span class="box">${parts.has(p.id) ? '✓' : ''}</span><span class="nm">${esc(p.name)}</span></div>`).join('')}
      </div>
    </div>
    <button class="btn btn-primary btn-block" id="b-save">保存</button>`;
  openModal(html);
  const $ = s => document.querySelector(s);

  $('#b-parts').onclick = ev => { const r = ev.target.closest('.pick'); if (!r) return;
    const on = !r.classList.contains('on'); r.classList.toggle('on', on); r.querySelector('.box').textContent = on ? '✓' : ''; };

  $('#b-save').onclick = () => {
    const parts2 = [...document.querySelectorAll('#b-parts .pick.on')].map(r => r.dataset.pid);
    if (!parts2.length) { toast('至少选一个参与人'); return; }
    S.bobing.participants = parts2;
    closeModal(); commit('参与人已保存 ✓');
  };
}

/* ── 各奖购买负责人设置（从「成员」页某人点进来，勾选 TA 负责哪些奖）── */
function openPersonPrizesModal(personId) {
  const rows = S.bobing.prizes.map((p, i) => {
    const on = (p.buyers || []).includes(personId);
    const medal = RANK_MEDALS[p.rank] || '🎲';
    const bs = (p.buyers || []).filter(Boolean);
    const shareTxt = on && bs.length > 1 ? `<span class="sub-amt">与 ${bs.filter(x => x !== personId).map(personName).join('/')} 平分</span>` : '';
    return `<div class="pick ${on ? 'on' : ''}" data-i="${i}">
      <span class="box">${on ? '✓' : ''}</span>
      <span class="nm">${medal} ${esc(p.rank)} <span class="sub-amt">${money(prizeCost(p))}</span>${shareTxt}</span>
    </div>`;
  });
  openModal(`
    <div class="modal-hd"><h3>🎲 ${esc(personName(personId))} 负责购买</h3><button class="modal-close" data-close>✕</button></div>
    <p style="font-size:13px;color:var(--ink-soft);margin:0 0 12px">勾选 TA 负责购买的奖等；一个奖多人勾选则平分那笔钱。</p>
    <div class="pick-list" id="pp-list">${rows.join('')}</div>
    <button class="btn btn-primary btn-block" id="pp-save" style="margin-top:14px">保存</button>`);

  document.getElementById('pp-list').onclick = ev => {
    const r = ev.target.closest('.pick'); if (!r) return;
    r.classList.toggle('on');
    r.querySelector('.box').textContent = r.classList.contains('on') ? '✓' : '';
  };
  document.getElementById('pp-save').onclick = () => {
    document.querySelectorAll('#pp-list .pick').forEach(r => {
      const p = S.bobing.prizes[+r.dataset.i];
      const on = r.classList.contains('on');
      const bs = new Set((p.buyers || []).filter(Boolean));
      if (on) bs.add(personId); else bs.delete(personId);
      p.buyers = [...bs];
    });
    closeModal(); commit('负责奖项已保存 ✓');
  };
}

/* ── 成员增改删 ───────────────────────────────────────── */
function openPersonModal(person) {
  const editing = !!person;
  const html = `
    <div class="modal-hd"><h3>${editing ? '✏️ 改名' : '➕ 添加成员'}</h3><button class="modal-close" data-close>✕</button></div>
    <div class="field"><label>名字</label><input class="input" id="p-name" placeholder="输入成员名字" value="${editing ? esc(person.name) : ''}"></div>
    <button class="btn btn-primary btn-block" id="p-save">保存</button>`;
  openModal(html);
  const inp = document.getElementById('p-name'); inp.focus();
  document.getElementById('p-save').onclick = () => {
    const name = inp.value.trim(); if (!name) { toast('名字不能为空'); return; }
    if (editing) person.name = name;
    else {
      const np = mkPerson(name); S.people.push(np);
      S.bobing.participants = [...(S.bobing.participants || []), np.id]; // 新成员默认参与博饼平摊
    }
    closeModal(); commit(editing ? '已改名 ✓' : `${name} 已加入 ✓`);
  };
}
function delPerson(id) {
  if (S.people.length <= 1) { toast('至少保留一名成员'); return; }
  const used = S.expenses.some(e => (e.payers || []).some(p => p.person === id) ||
    Object.keys(sharesOf(e)).includes(id)) || S.bobing.prizes.some(p => (p.buyers || []).includes(id));
  const name = personName(id);
  if (!confirm(`删除「${name}」？${used ? '\n⚠️ TA 出现在某些账目/购奖里，删除后那些账的分摊会变。' : ''}`)) return;
  S.people = S.people.filter(p => p.id !== id);
  S.bobing.participants = (S.bobing.participants || []).filter(x => x !== id);
  S.bobing.prizes.forEach(p => { p.buyers = (p.buyers || []).filter(x => x !== id); }); // 清理购奖负责人
  // 清理账目引用
  S.expenses.forEach(e => {
    e.payers = (e.payers || []).filter(p => p.person !== id);
    if (e.split?.among) e.split.among = e.split.among.filter(x => x !== id);
    if (e.split?.shares) delete e.split.shares[id];
    if (e.split?.exact) delete e.split.exact[id];
  });
  commit(`${name} 已移除`);
}

/* ============================================================
   模态 / toast 基础设施
   ============================================================ */
function openModal(inner) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-mask"><div class="modal">${inner}</div></div>`;
  root.querySelector('.modal-mask').addEventListener('click', ev => { if (ev.target.classList.contains('modal-mask')) closeModal(); });
  const c = root.querySelector('[data-close]'); if (c) c.onclick = closeModal;
  document.body.style.overflow = 'hidden';
}
function closeModal() { document.getElementById('modal-root').innerHTML = ''; document.body.style.overflow = ''; }

let toastTimer;
function toast(msg, ms = 1800) {
  const root = document.getElementById('toast-root');
  root.innerHTML = `<div class="toast">${esc(msg)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => root.innerHTML = '', ms);
}

/* 迁移旧数据结构：老版本用 bobing.person_in_charge + bobing.payers，
   新版本改为每个奖 prize.buyers[]。缺 buyers 时用旧负责人补齐。 */
function migrate(data) {
  if (!data?.bobing?.prizes) return data;
  const b = data.bobing;
  const fallback = b.person_in_charge || (b.payers || [])[0]?.person || '';
  b.prizes.forEach(p => {
    if (!Array.isArray(p.buyers)) p.buyers = fallback ? [fallback] : [];
  });
  delete b.person_in_charge; delete b.payers;
  // 旧标题/副标题一次性纠正为精简版
  if (data.title === '2026 博饼分账') data.title = '2026 博饼';
  if (data.subtitle === '南洋博饼 · 中秋分账') data.subtitle = '';
  return data;
}

/* ============================================================
   启动：本地优先渲染 → 云端拉取覆盖
   ============================================================ */
async function boot() {
  const local = localStorage.getItem(LS_KEY);
  S = migrate(local ? JSON.parse(local) : seed());
  render();

  const cloud = await window.loadFromCloud();
  if (cloud && cloud.people) {
    // 云端为准（单写者）；若本地更新更晚则保留本地
    const cloudTime = cloud.updated_at || '';
    const localTime = S.updated_at || '';
    if (!local || cloudTime >= localTime) { S = migrate(cloud); saveLocal(); render(); }
  } else if (!local) {
    // 云端空且本地空 → 首次，把种子写上去
    saveLocal();
    if (isAdmin) window.saveToCloud(S);
  }
}

// 回到前台时刷新（访客能看到最新）
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && !document.querySelector('.modal-mask')) {
    const cloud = await window.loadFromCloud();
    if (cloud && cloud.people && (cloud.updated_at || '') > (S.updated_at || '')) { S = migrate(cloud); saveLocal(); render(); }
  }
});

boot();
