# 🎲 博饼分账

每年博饼聚会的记账互动小工具：博饼奖金池记录、多人代付分账、云端同步与备份，一键算清谁该转给谁。

🌐 **在线访问：[bobing-app.pages.dev](https://bobing-app.pages.dev)**

---

## 简介

朋友聚会博饼，痛点是花销分散（食材、奖品、场地……）又常常多人代付。博饼分账把「博饼奖金池」当成一笔虚拟支出统一记账，加上其它日常开销，用最少转账数算清每个人该收/该付多少。

## 功能

- **账目总览** — 每人净额一览，最少转账方案（谁转给谁多少）
- **博饼采购** — 博饼奖品/奖金池作为虚拟支出统一进结算
- **其它账目** — 记录聚会其它花销，支持多人代付（payers）
- **分摊方式** — 均分 / 按份数 / 按精确金额（equal / shares / exact）三种模式
- **成员管理** — 增删参与人员
- **云端同步** — 基于 Supabase，多人协作看同一份账
- **软密码门禁** — 访客只读，管理员输密码后可编辑

## 技术栈

- 纯原生 HTML / CSS / JavaScript，无框架、无构建
- [Supabase](https://supabase.com/) — 云端数据存储与同步
- Cloudflare Pages — 静态部署

## 本地运行

```bash
git clone https://github.com/syanaooooooo/bobing.git
cd bobing
python3 -m http.server 8891
# 打开 http://localhost:8891
```

## 数据模型

每笔账 = 谁垫钱（可多人）+ 为谁花 + 怎么分：

```js
expense = {
  id, date, title, category, amount,
  payers: [{ person, paid }],   // 可多人，∑paid = amount
  split: {
    mode: 'equal' | 'shares' | 'exact',
    among: [pid],
    shares: { pid: n },
    exact: { pid: amt }
  }
}
```

博饼奖金池作为一笔虚拟支出统一进结算 → `computeBalances()` 汇总每人净额 → `settle()` 用最少转账算法输出「谁转给谁」。

单一货币 SGD，手动统一录入，不做汇率折算。

## 文件结构

```
bobing/
├── index.html          # 页面结构（总览/博饼/账目/成员 四个 tab）
├── style.css           # 样式
├── app.js              # 主逻辑（记账、分摊、结算、管理员门禁）
├── sync.js             # Supabase 云端读写
└── supabase-config.js
```

## 部署 / 缓存约定

- 部署到 Cloudflare Pages：`npx wrangler pages deploy . --project-name=bobing-app --branch=main`
- 改 `style.css` / `app.js` / `sync.js` 时，`index.html` 里对应的 `?v=N` 要 +1
