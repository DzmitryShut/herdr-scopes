// Modified from the `spaces` mod shipped with Herdr (Apache-2.0, https://github.com/herdrdev/herdr-app).
// Scopes: one list instead of Spaces + Agents. A scope is a space with an agent or a
// linked worktree. Worktrees sit under their checkout, grouped by machine when more
// than one is known. After a name: unpushed commits and the scope's state, nothing else.
// Settled spaces and bare checkouts fold into shelves at the bottom. Click to switch,
// right-click for the menu, drag to reorder, hover to settle.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, agents, terminals, run, openOverlay, exec, hc, theme, shared, setShared, setAgentOrder, watchFolder, window, layout } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

// A tab someone named, else the title the agent set, else the program. Same rule as
// liveTitle in scopes-tabs: keep the two in step.
function agentName(a, tab) {
  const prog = a.program?.name;
  if (tab?.named && tab.name !== prog) return tab.name;
  const live = clean(a.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== a.program?.key;
  return telling ? live : prog || a.address;
}

// Most urgent first. "finished": the agent still says done, the app already shows idle.
const ORDER = ["blocked", "done", "working", "finished", "idle"];

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.shelves = JSON.parse(localStorage.getItem("shelves") ?? "{}");
    this.hovered = null;
    this.armed = null;
    cx.timer.every(30000, (cx) => cx.notify()); // durations
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null })).filter((r) => this.shown.has(r.w.id));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    return out;
  }

  // The tree, and what folds away under it.
  parts(rows) {
    const put = (r) => r.w.tabs.length > 0 && r.w.tabs.every((x) => x.settled);
    const rest = rows.filter((r) => !put(r));
    const kids = (r) => rest.some((k) => k.tree && r.g && k.g.repo === r.g.repo);
    const bare = (r) => !r.tree && r.w.status == null && !r.g?.linked && !kids(r);
    return { tree: rest.filter((r) => !bare(r)), settled: rows.filter(put), repos: rest.filter(bare) };
  }

  // A space's agents and their states, most urgent first.
  info(w) {
    const mine = this.agents.filter((a) => a.space === w.id);
    const word = (a) => (a.status === "idle" && this.raw.get(a.address) === "done" ? "finished" : a.status);
    const since = (tabs) => Math.min(Infinity, ...tabs.map((x) => x.working_since).filter(Boolean));
    const states = mine.map((a) => ({ a, st: word(a), since: since(w.tabs.filter((x) => x.id === a.tab)) }));
    states.sort((x, y) => ORDER.indexOf(x.st) - ORDER.indexOf(y.st));
    return { states, top: states[0]?.st ?? null, since: since(w.tabs) };
  }

  // A state in a word.
  state(t, st, since) {
    const chip = (color, text) => div().flex_none().px(6).h(18).rounded(5).bg(color + "26").text_size(10.5).font_semibold().text_color(color).flex().items_center().child(text);
    const word = (color, text) => div().flex_none().text_size(11.5).text_color(color).child(text);
    if (st === "working") return h_flex().flex_none().gap(4).items_center().text_size(11.5).text_color(t.dim)
      .child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900))
      .when(Number.isFinite(since), (el) => el.child(duration(this.now - since)));
    if (st === "blocked") return chip(t.blocked, "Needs you");
    if (st === "done") return chip(t.done, "Done");
    if (st === "finished") return word(t.done, "done");
    return word(t.dim, st === "idle" ? "idle" : "no agent");
  }

  // Several agents: how many in each state, most urgent first.
  breakdown(t, states) {
    const count = (st) => states.filter((s) => s.st === st).length;
    const text = { blocked: "needs", done: "Done", finished: "done", idle: "idle" };
    const color = { blocked: t.blocked, done: t.done, finished: t.done, idle: t.dim };
    return h_flex().flex_none().gap(6).items_center().text_size(11.5)
      .children(ORDER.filter(count).map((st) => st === "working"
        ? h_flex().flex_none().gap(3).items_center().text_color(t.dim)
          .child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900))
          .child(String(count(st)))
        : div().flex_none().text_color(color[st]).child(`${text[st]} ${count(st)}`)));
  }

  // The row selects on mouse up, and showing a scope can undo a settle, so these
  // take both the press and the release, and act on the release.
  action(t, id, content, act) {
    return div().id(id).flex_none().px(4).h(18).rounded(4).flex().items_center().text_size(11).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.armed = id; })
      .on_mouse_up("left", (_e, cx) => {
        cx.stop_propagation();
        const armed = this.armed === id;
        this.armed = null;
        this.pressed = null;
        this.over = null;
        if (armed) { act(); this.hovered = null; }
        cx.notify();
      })
      .child(content);
  }

  // One row per agent under a scope with several.
  agentRow(t, w, s, tree) {
    const { a, st, since } = s;
    const pic = !a.program?.icon ? null : a.program.tint ? svg(a.program.icon).size(14).flex_none().text_color(t.muted) : image(a.program.icon).w(14).h(14).flex_none();
    return h_flex().id(`agent-${a.address}`).h(26).flex_none().pl(tree ? 44 : 35).pr(8).gap(7).items_center().rounded(7).text_size(12.5)
      .when(a.focused, (el) => el.bg(t.raised))
      .hover((el) => el.bg(t.hover))
      .on_click(() => run("agent.focus", { terminal: a.address }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_1().min_w(0).truncate().text_color(st === "idle" ? t.muted : t.foreground).child(agentName(a, w.tabs.find((x) => x.id === a.tab))))
      .child(this.state(t, st, since));
  }

  // A row and, when it has several agents, theirs.
  draw(r, t, shelf) {
    const info = this.info(r.w);
    return [this.row(r, t, info, shelf), ...(info.states.length > 1 ? info.states.map((s) => this.agentRow(t, r.w, s, r.tree)) : [])];
  }

  // A shelf at the bottom: folded until opened, and remembered.
  shelf(t, id, label, rows) {
    if (!rows.length) return [];
    const open = Boolean(this.shelves[id]);
    const head = h_flex().id(`shelf-${id}`).h(26).flex_none().px(8).gap(7).items_center().text_size(11).text_color(t.dim)
      .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        this.shelves[id] = !open;
        localStorage.setItem("shelves", JSON.stringify(this.shelves));
        cx.notify();
      })
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
      .child(div().flex_1().child(label))
      .child(String(rows.length));
    return [head, ...(open ? rows.flatMap((r) => this.draw(r, t, id)) : [])];
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed, everyRow, tree) {
    const rows = collapsed ? everyRow : tree;
    const draw = (r) => (collapsed ? [this.compact(r, t)] : this.draw(r, t, null));
    const remote = [...new Set([...everyRow.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !everyRow.length ? [loadingRow(null)] : rows.flatMap(draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const machine = this.machines.find(k => k.name === m);
      const connected = !m || machine?.state === "connected";
      const folded = this.folded.has(m);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 2 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none())
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", m ? { machine: m } : {}); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", m ? { machine: m } : {}))
        .child(svg("mods/workspace-chrome/plus.svg").size(12)).when(!collapsed, el => el.child("New space there"));
      const shelved = everyRow.some((r) => (r.w.machine ?? null) === m);
      return [head, ...(folded ? [] : mine.length ? mine.flatMap(draw) : shelved ? [] : [loading(m) ? loadingRow(m) : empty])];
    });
  }

  row({ w, i, g, tree }, t, info, shelf) {
    const on = w.active;
    const scope = w.status != null || Boolean(g?.linked);
    const quiet = !info.top || info.top === "idle";
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_hover((over, cx) => {
        if (over) this.hovered = w.id;
        else if (this.hovered === w.id) this.hovered = null;
        cx.notify();
      })
      .when(this.pressed === i && this.over !== i, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === i && this.pressed !== i, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(this.pressed < i, line => line.bottom(0))
          .when(this.pressed > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = i;
        this.over = i;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces()[this.pressed];
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? i : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === i && from !== i) run("space.move", { id: spaces()[from].id, index: i + 1 });
        else if (from === i) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.pl(22).child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.dim)))
          .when(!tree, el => el.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
          .child(div().flex_1().min_w(0).truncate().text_color(quiet ? t.muted : t.foreground).child(w.name))
          .when(g?.ahead > 0, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.ansi2).child(`↑${g.ahead}`)))
          .when(scope && info.states.length > 1, (el) => el.child(this.breakdown(t, info.states)))
          .when(scope && info.states.length < 2, (el) => el.child(this.state(t, info.top, info.since)))
          .when(this.hovered === w.id && shelf === "settled", (el) => el.child(this.action(t, `unsettle-${w.id}`, "Unsettle", () => w.tabs.forEach((x) => run("tab.unsettle", { id: x.id })))))
          .when(this.hovered === w.id && scope && shelf !== "settled", (el) => el.child(this.action(t, `settle-${w.id}`, svg("mods/workspace-chrome/check.svg").size(13), () => w.tabs.forEach((x) => run("tab.settle", { id: x.id }))))),
      );
  }

  compact({ w, i }, t) {
    return h_flex()
      .id(`space-${w.id}`)
      .h(26)
      .flex_none()
      .justify_center()
      .gap(4)
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().text_color(tone(t, w.status)).child(glyph(w.status)));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    this.now = Date.now();
    this.agents = agents();
    this.raw = new Map(terminals().map((k) => [k.address, k.status]));
    const everyRow = this.ordered();
    const { tree, settled, repos } = this.parts(everyRow);
    setAgentOrder([...tree, ...settled, ...repos].flatMap((r) => this.info(r.w).states.map((s) => s.a.address)));
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(!collapsed, el => el.child("Scopes"))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        .children(this.grouped(t, collapsed, everyRow, tree))
        .when(!collapsed, (el) => el.child(div().flex_1().min_h(10)))
        .when(!collapsed, (el) => el.children([...this.shelf(t, "settled", "Settled", settled), ...this.shelf(t, "repos", "Repos", repos)])))
      // workspace-chrome hides its toggle next to the traffic lights.
      .when(collapsed && window()?.platform === "macos", (el) => el.child(h_flex().h(28).flex_none().items_center().justify_center()
        .child(div().id("expand").text_size(13).text_color(t.dim).hover((s) => s.text_color(t.foreground)).on_click(toggleSidebar).child("»"))));
  }
}
