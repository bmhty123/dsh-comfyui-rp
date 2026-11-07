/**
 * dsh-comfyui-rp —— 浏览器半区（右侧栏 ComfyRP 标签页 + 悬浮球）。
 *
 * 形态：window.__ModuleLoader__.load({ id, factory })，factory 里 require("react")。
 * 不依赖构建：JSX 一律换成 React.createElement，样式用注入的 <style>。
 *
 * 注册的席位：
 *   sidebar.right.pane.tab       右侧栏正文（每个会话一个 ComfyRP 标签）
 *   sidebar.right.pane.tab.title 标签上的 ComfyRP + 状态点
 *   sidebarRightTabs.register    右侧栏「开始菜单」里的 ComfyRP 卡片
 *   shell.overlay                悬浮球 + 图片框（窗口内拖动 / 缩放 / 控件淡入淡出）
 *   conversation.input.dock      隐形组件：把当前会话 id / 标题报给宿主
 */
window.__ModuleLoader__.load({
  id: "dsh-comfyui-rp",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    try {
      var React = require("react");
      if (!React || !React.createElement) throw new Error("react 不可用");
      var h = React.createElement;
      var useState = React.useState;
      var useEffect = React.useEffect;
      var useRef = React.useRef;
      var useMemo = React.useMemo;
      var useCallback = React.useCallback;
      var ReactDOM = null;
      try { ReactDOM = require("react-dom"); } catch (e) { ReactDOM = null; }
      // 大图查看器用 portal 挂到 body：右侧栏有 overflow:clip / 动画，fixed 可能被裁。
      function withPortal(node) {
        try {
          if (ReactDOM && typeof ReactDOM.createPortal === "function" && typeof document !== "undefined" && document.body) {
            return ReactDOM.createPortal(node, document.body);
          }
        } catch (e) { /* 退回原地渲染 */ }
        return node;
      }

      /* ===================================================================
       * 常量与工具
       * =================================================================== */
      var ROUTE = "/__airp_comfy";
      var API = ROUTE + "/api";
      var TAB_ID = "dsh-comfyui-rp";
      var TAB_KIND = "airp";
      var TAB_LABEL = "ComfyRP";
      var BRAND_NAME = "ComfyRP Bridge";
      var BRAND_SUB = "投递正文·接收提示词·返回图片";
      var PANEL_TITLE = "ComfyRP Bridge × ComfyUI 生图桥";
      var LS_KEY = "airp-comfy:float:v3";
      var LS_PAGE = "airp-comfy:page:v2";
      var LS_THEME = "airp-comfy:theme:v1";
      var LS_WORKBENCH = "airp-comfy:workbench:v1";
      var LS_FLOAT_HIDDEN = "airp-comfy:float-hidden:v1";
      var LS_SQUARE = "airp-comfy:frame-square:v1";
      var LS_FOLLOW_OFFSET = "airp-comfy:follow-offset:v1";
      var FLOAT_VIS_EVENT = "airp-comfy:float-visibility";
      var COLLAPSE_EVENT = "airp-comfy:collapse-ball";
      var DOCK_LEFT_EVENT = "airp-comfy:dock-left";
      var RESERVE_LEFT_EVENT = "airp-comfy:reserve-left";
      var SQUARE_EVENT = "airp-comfy:frame-square-change";
      var PREFS_EVENT = "airp-comfy:float-prefs-change";
      var UI_CONFIG_EVENT = "airp-comfy:ui-config-change";
      var SESSION_EVENT = "airp-comfy:active-session";
      var IMAGE_EVENT = "airp-comfy:image-changed";
      // 图片框右上角「侧栏全屏」：同一页面的 BridgePanel 监听这个事件进入全屏看图。
      var FULL_OPEN_EVENT = "airp-comfy:open-full";
      // 右侧栏全屏与悬浮框 / 跟图逻辑双向同步。
      var FULL_NAV_EVENT = "airp-comfy:full-nav";
      var FULL_FOLLOW_EVENT = "airp-comfy:full-follow";
      var FULL_STATE_EVENT = "airp-comfy:full-state";
      var pendingFullOpen = null;
      var RIGHT_VIEW_KEY = "airp-comfy:right-view:v1";
      function readRightViewMemory() {
        try {
          if (typeof sessionStorage === "undefined") return null;
          var raw = sessionStorage.getItem(RIGHT_VIEW_KEY);
          if (!raw) return null;
          var d = JSON.parse(raw);
          if (!d || !d.open) return null;
          return {
            open: true,
            sessionId: d.sessionId ? String(d.sessionId) : "",
            imageId: d.imageId ? String(d.imageId) : "",
            idx: Math.max(0, Number(d.idx) || 0),
            list: Array.isArray(d.list) ? d.list.slice(0, 200) : [],
            listReady: !!d.listReady,
            hiddenBefore: !!d.hiddenBefore,
          };
        } catch (e) { return null; }
      }
      function saveRightViewMemory() {
        try {
          if (typeof sessionStorage === "undefined") return;
          if (!rightViewMemory.open) {
            sessionStorage.removeItem(RIGHT_VIEW_KEY);
            return;
          }
          sessionStorage.setItem(RIGHT_VIEW_KEY, JSON.stringify({
            open: true,
            sessionId: rightViewMemory.sessionId || "",
            imageId: rightViewMemory.imageId || "",
            idx: rightViewMemory.idx || 0,
            list: Array.isArray(rightViewMemory.list) ? rightViewMemory.list.slice(0, 200) : [],
            listReady: !!rightViewMemory.listReady,
            hiddenBefore: !!rightViewMemory.hiddenBefore,
          }));
        } catch (e) { /* quota / privacy mode：只丢持久化，不影响当前页 */ }
      }
      // 右侧栏全屏看图的临时记忆：切到右侧栏其它标签时 BridgePanel 会卸载，
      // 回来时要还在同一张图，而不是重新变成最新一张。只用 sessionStorage，刷新也不丢。
      var rightViewMemory = readRightViewMemory() || { open: false, sessionId: "", imageId: "", idx: 0, list: [], listReady: false, hiddenBefore: false };
      // 悬浮框最近一次真正显示的图。右侧栏顶部「全屏看图」按钮没有参数，
      // 用它作为起点，避免每次都从最新一张开始。
      var lastFrameView = null;
      var FLOAT_DEFAULT_W = 637;
      var FLOAT_DEFAULT_H = 931;
      var clientCtx = null;

      /**
       * 图片框 / 全屏翻页用的本地图片缓存。
       *
       * 浏览器虽然带了 immutable 头，但每次 new Image() 仍可能重新走一遍
       * 网络 / 解码；旧图翻回去就再转一次「加载中」。这里把每张图 fetch 成
       * Blob，后续统一用 blob: URL，切回同一张时不再请求、也不再等磁盘。
       * 只缓存最近 18 张，避免多会话图片把内存撑爆。
       */
      var IMG_SRC_CACHE = typeof Map === "function" ? new Map() : null;
      var IMG_SRC_READY = typeof Map === "function" ? new Map() : null;
      var IMG_SRC_ORDER = [];
      var IMG_SRC_LIMIT = 18;
      function cachedImageSrcNow(url) {
        var key = String(url || "");
        if (!key || !IMG_SRC_READY) return "";
        return IMG_SRC_READY.get(key) || "";
      }
      function cachedImageSrc(url) {
        var key = String(url || "");
        if (!key) return Promise.resolve("");
        if (IMG_SRC_READY && IMG_SRC_READY.has(key)) return Promise.resolve(IMG_SRC_READY.get(key));
        if (!IMG_SRC_CACHE) return Promise.resolve(key);
        var hit = IMG_SRC_CACHE.get(key);
        if (hit) return hit;
        if (typeof fetch !== "function" || typeof Blob !== "function"
          || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
          return Promise.resolve(key);
        }
        var task = fetch(key, { credentials: "same-origin", cache: "force-cache" })
          .then(function (res) {
            if (!res || !res.ok) throw new Error("HTTP " + (res ? res.status : "?"));
            return res.blob();
          })
          .then(function (blob) {
            var src = URL.createObjectURL(blob);
            if (IMG_SRC_READY) IMG_SRC_READY.set(key, src);
            IMG_SRC_ORDER.push(key);
            while (IMG_SRC_ORDER.length > IMG_SRC_LIMIT) {
              var old = IMG_SRC_ORDER.shift();
              if (old && old !== key) {
                var oldSrc = IMG_SRC_READY ? IMG_SRC_READY.get(old) : "";
                IMG_SRC_CACHE.delete(old);
                if (IMG_SRC_READY) IMG_SRC_READY.delete(old);
                if (oldSrc && oldSrc.indexOf("blob:") === 0) {
                  try { URL.revokeObjectURL(oldSrc); } catch (e2) { /* ignore */ }
                }
              }
            }
            return src;
          })
          .catch(function () {
            // 取不到 Blob（旧宿主 / 权限）就退回原始 URL，行为跟以前一致。
            IMG_SRC_CACHE.delete(key);
            if (IMG_SRC_READY) IMG_SRC_READY.delete(key);
            return key;
          });
        IMG_SRC_CACHE.set(key, task);
        return task;
      }

      function cls() {
        var out = [];
        for (var i = 0; i < arguments.length; i += 1) {
          var a = arguments[i];
          if (!a) continue;
          if (typeof a === "string") out.push(a);
          else if (typeof a === "object") {
            for (var k in a) if (a[k]) out.push(k);
          }
        }
        return out.join(" ");
      }

      function fmtTime(iso) {
        if (!iso) return "";
        var d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso);
        var p = function (n) { return String(n).padStart(2, "0"); };
        return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
      }

      function withDownload(url) {
        var s = String(url || "");
        if (!s) return s;
        return s + (s.indexOf("?") >= 0 ? "&" : "?") + "download=1";
      }

      function fmtBytes(n) {
        var v = Number(n) || 0;
        if (v < 1024) return v + " B";
        if (v < 1048576) return (v / 1024).toFixed(1) + " KB";
        return (v / 1048576).toFixed(2) + " MB";
      }

      function shortId(id) {
        var s = String(id || "");
        return s.length > 14 ? s.slice(0, 8) + "…" + s.slice(-4) : s;
      }

      function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, Number(v) || 0)); }

      /**
       * 双指捏合用的框尺寸算法（纯函数，便于离线测试）。
       * p: { x, y, w, h, anchorX, anchorY } —— 捏合开始时框的视口坐标 + 要钉住的点；
       * factor: 两指当前距离 / 起始距离；midX/midY: 两指当前中点。
       * 返回新的 { x, y, w, h, factor }：尺寸按比例缩放后被夹在「不小于 280×360（或视口更小）
       * 不大于视口」之间，并保证 anchor 在框内的相对位置始终落在 mid 上。
       */
      function scaleFrameAround(p, factor, midX, midY, vw, vh) {
        var baseW = Math.max(1, Number(p && p.w) || 1);
        var baseH = Math.max(1, Number(p && p.h) || 1);
        var maxW = Math.max(1, Number(vw) || 1);
        var maxH = Math.max(1, Number(vh) || 1);
        var minW = Math.min(280, maxW);
        var minH = Math.min(360, maxH);
        var maxF = Math.min(maxW / baseW, maxH / baseH);
        var minF = Math.min(maxF, Math.max(minW / baseW, minH / baseH));
        var lo = Math.min(minF, maxF);
        var hi = Math.max(minF, maxF);
        var f = Number(factor) || 1;
        if (f < lo) f = lo;
        if (f > hi) f = hi;
        var nw = Math.max(1, baseW * f);
        var nh = Math.max(1, baseH * f);
        var rx = Math.max(0, Math.min(1, ((Number(p && p.anchorX) || 0) - (Number(p && p.x) || 0)) / baseW));
        var ry = Math.max(0, Math.min(1, ((Number(p && p.anchorY) || 0) - (Number(p && p.y) || 0)) / baseH));
        var nx = (Number(midX) || 0) - rx * nw;
        var ny = (Number(midY) || 0) - ry * nh;
        return {
          factor: f,
          w: nw,
          h: nh,
          x: Math.max(0, Math.min(Math.max(0, maxW - nw), nx)),
          y: Math.max(0, Math.min(Math.max(0, maxH - nh), ny)),
        };
      }

      /**
       * 会话下拉的显示名。
       * Tavern 把人物卡名当目录：同一个角色的会话标题完全一样，光看标题分不出哪个是正在写的。
       * 只有标题重复（counts[标题] > 1）时才补「首条用户消息 + 条数」，普通会话保持原样。
       */
      function sessionOptionLabel(session, counts) {
        var s = session || {};
        var key = s.displayTitle || s.title || '';
        var base = key || String(s.sessionId || '').slice(0, 12);
        var bits = [base];
        if (counts && (counts[key] || 0) > 1) {
          var first = String(s.firstText || '').replace(/\s+/g, ' ').trim();
          if (first) bits.push('“' + (first.length > 22 ? first.slice(0, 22) + '…' : first) + '”');
          var n = Number(s.userCount) || 0;
          if (n > 0) bits.push(n + '条');
        }
        return bits.join(' · ');
      }

      /**
       * 双指捏合的一步（纯函数，便于离线测试）。
       * p 是捏合起点快照：{ dist, midX, midY, w, h, x, y, docked, dockW, dockMax }
       * a / b 是当前两指的 { clientX, clientY }；dockMin 是停靠最小宽度。
       * 返回 null（这一步不用动）、{ docked: true, dockW } 或 { docked: false, x, y, w, h, factor }。
       */
      function pinchFrameStep(p, a, b, vw, vh, dockMin) {
        if (!p || !p.active || !a || !b) return null;
        var dx = a.clientX - b.clientX;
        var dy = a.clientY - b.clientY;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (!(d > 1)) return null;
        var factor = d / Math.max(1, Number(p.dist) || 1);
        if (!isFinite(factor) || factor <= 0) return null;
        if (p.docked) {
          // 停靠时宽度就是框宽，捏合和滚轮一样调停靠宽度。
          var lo = Math.max(1, Number(dockMin) || 1);
          var hi = Math.max(lo, Number(p.dockMax) || 0);
          return {
            docked: true,
            dockW: Math.max(lo, Math.min(hi, Math.round((Number(p.dockW) || 0) * factor))),
          };
        }
        var sc = scaleFrameAround({
          x: p.x, y: p.y, w: p.w, h: p.h, anchorX: p.midX, anchorY: p.midY,
        }, factor, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2, vw, vh);
        return { docked: false, x: sc.x, y: sc.y, w: sc.w, h: sc.h, factor: sc.factor };
      }

      /**
       * 自动补图的全局状态：逻辑在 FloatBall 里跑（它一直在，负责检测纯黑图），
       * 但「停止」按钮要能出现在右侧栏面板里，所以两边共享这一份。
       * pending = 队列里的 + 正在跑的；stop = FloatBall 注册过来的停止函数。
       */
      var BLACK_UI = { pending: 0, stop: null, subs: new Set() };
      function setBlackPendingGlobal(n) {
        var value = Math.max(0, Number(n) || 0);
        if (BLACK_UI.pending === value) return;
        BLACK_UI.pending = value;
        BLACK_UI.subs.forEach(function (fn) { try { fn(value); } catch (e) { /* ignore */ } });
      }
      function useBlackPending() {
        var [pending, setPending] = useState(BLACK_UI.pending);
        useEffect(function () {
          var fn = function (n) { setPending(n); };
          BLACK_UI.subs.add(fn);
          setPending(BLACK_UI.pending);
          return function () { BLACK_UI.subs.delete(fn); };
        }, []);
        return pending;
      }


      function loadTheme() {
        try { return localStorage.getItem(LS_THEME) === "light" ? "light" : "dark"; } catch (e) { return "dark"; }
      }
      function saveTheme(theme) {
        try { localStorage.setItem(LS_THEME, theme === "light" ? "light" : "dark"); } catch (e) { /* ignore */ }
      }

      function readFloatHidden() {
        try { return localStorage.getItem(LS_FLOAT_HIDDEN) === "1"; } catch (e) { return false; }
      }
      function writeFloatHidden(hidden) {
        var value = !!hidden;
        try { localStorage.setItem(LS_FLOAT_HIDDEN, value ? "1" : "0"); } catch (e) { /* ignore */ }
        try {
          if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
            var ev = null;
            if (typeof CustomEvent === "function") ev = new CustomEvent(FLOAT_VIS_EVENT, { detail: { hidden: value } });
            else if (typeof document !== "undefined" && document.createEvent) {
              ev = document.createEvent("CustomEvent");
              ev.initCustomEvent(FLOAT_VIS_EVENT, false, false, { hidden: value });
            }
            if (ev) window.dispatchEvent(ev);
          }
        } catch (e) { /* ignore */ }
      }
      function readSquare() {
        try { return localStorage.getItem(LS_SQUARE) === "1"; } catch (e) { return false; }
      }
      function readFollowOffset() {
        try {
          var n = Number(localStorage.getItem(LS_FOLLOW_OFFSET));
          return isFinite(n) ? clamp(n, -200, 200) : 0;
        } catch (e) { return 0; }
      }
      function writeFollowOffset(value) {
        try { localStorage.setItem(LS_FOLLOW_OFFSET, String(clamp(value, -200, 200))); } catch (e) { /* ignore */ }
      }
      function writeSquare(value) {
        var on = !!value;
        try { localStorage.setItem(LS_SQUARE, on ? "1" : "0"); } catch (e) { /* ignore */ }
        try {
          if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
            var ev = null;
            if (typeof CustomEvent === "function") ev = new CustomEvent(SQUARE_EVENT, { detail: { square: on } });
            else if (typeof document !== "undefined" && document.createEvent) {
              ev = document.createEvent("CustomEvent");
              ev.initCustomEvent(SQUARE_EVENT, false, false, { square: on });
            }
            if (ev) window.dispatchEvent(ev);
          }
        } catch (e) { /* ignore */ }
      }

      function announceFloatPrefs(prefs) {
        try {
          if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
            var ev = null;
            if (typeof CustomEvent === "function") ev = new CustomEvent(PREFS_EVENT, { detail: { prefs: prefs } });
            else if (typeof document !== "undefined" && document.createEvent) {
              ev = document.createEvent("CustomEvent");
              ev.initCustomEvent(PREFS_EVENT, false, false, { prefs: prefs });
            }
            if (ev) window.dispatchEvent(ev);
          }
        } catch (e) { /* ignore */ }
      }
      function announceUiConfig(patch) {
        try {
          if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
            var detail = patch && typeof patch === "object" ? patch : {};
            var ev = null;
            if (typeof CustomEvent === "function") ev = new CustomEvent(UI_CONFIG_EVENT, { detail: detail });
            else if (typeof document !== "undefined" && document.createEvent) {
              ev = document.createEvent("CustomEvent");
              ev.initCustomEvent(UI_CONFIG_EVENT, false, false, detail);
            }
            if (ev) window.dispatchEvent(ev);
          }
        } catch (e) { /* ignore */ }
      }

      function blankPromptSet() {
        return { title: "", anchor: "", size: null, positive: "", negative: "" };
      }

      /** 工作台草稿：整页级永久保存。坏数据直接丢掉，不让它把页面炸掉。 */
      function readWorkbenchDraft() {
        try {
          var raw = localStorage.getItem(LS_WORKBENCH);
          if (!raw) return null;
          var d = JSON.parse(raw);
          if (!d || !Array.isArray(d.sets) || !d.sets.length) return null;
          var sets = d.sets.slice(0, 3).map(function (s) {
            return {
              title: String((s && s.title) || ""),
              // 草稿也必须存原文锚点；之前这里漏了 anchor，重开页面就被清空。
              anchor: String((s && s.anchor) || ""),
              size: s && s.size && Number(s.size.w) > 0 && Number(s.size.h) > 0
                ? { w: Number(s.size.w), h: Number(s.size.h) } : null,
              positive: String((s && s.positive) || ""),
              negative: String((s && s.negative) || ""),
            };
          });
          var sizeDraft = d.sizeDraft && Number(d.sizeDraft.w) > 0 && Number(d.sizeDraft.h) > 0
            ? { w: Number(d.sizeDraft.w), h: Number(d.sizeDraft.h) } : null;
          return {
            sets: sets,
            sizeMode: d.sizeMode === "dsh" ? "dsh" : "manual",
            sizeDraft: sizeDraft,
            // 提示词来源 / turn 也要跟着草稿走，否则重开工作台再出图时
            // 图片没有 turn，缩小到“百分比回退”也用不了。
            sourceSessionId: String(d.sourceSessionId || ""),
            sourceSessionTitle: String(d.sourceSessionTitle || ""),
            sourceTurn: d.sourceTurn === null || d.sourceTurn === undefined || d.sourceTurn === ""
              ? null : (Number.isFinite(Number(d.sourceTurn)) ? Number(d.sourceTurn) : null),
            savedAt: Number(d.savedAt) || 0,
          };
        } catch (e) {
          return null;
        }
      }

      function writeWorkbenchDraft(data) {
        try {
          // 自动保存不能把 savedAt 顶成“现在”，否则下次打开时草稿永远比
          // 刚生成的自动任务新，任务里的标题 / 原文锚点就再也进不了工作台。
          var payload = Object.assign({}, data || {});
          payload.savedAt = Number(payload.savedAt) || Date.now();
          localStorage.setItem(LS_WORKBENCH, JSON.stringify(payload));
          return true;
        } catch (e) {
          return false;
        }
      }

      function copyText(text) {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(String(text));
        } catch (e) { /* ignore */ }
        try {
          var ta = document.createElement("textarea");
          ta.value = String(text);
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          return Promise.resolve();
        } catch (e2) {
          return Promise.reject(e2);
        }
      }

      async function req(method, action, body) {
        var opt = { method: method, headers: { Accept: "application/json" } };
        if (body !== undefined) {
          opt.headers["Content-Type"] = "application/json";
          opt.body = JSON.stringify(body);
        }
        var timer = null;
        if (typeof AbortController === "function") {
          var ctrl = new AbortController();
          opt.signal = ctrl.signal;
          timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { /* ignore */ } }, 20000);
        }
        try {
          var res = await fetch(API + "/" + action, opt);
          var text = await res.text();
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) { data = { ok: false, error: text.slice(0, 300) }; }
          if (!res.ok || (data && data.ok === false)) {
            var msg = (data && (data.error || data.message)) || ("HTTP " + res.status);
            var err = new Error(msg);
            err.status = res.status;
            err.code = data && data.code;
            throw err;
          }
          return data || {};
        } finally {
          if (timer) clearTimeout(timer);
        }
      }

      var api = {
        state: function (q) { return req("GET", "state" + (q || "")); },
        stateC: function () { return req("GET", "state?compact=1"); },
        config: function () { return req("GET", "config"); },
        saveConfig: function (patch) { return req("PUT", "config", patch); },
        sessions: function (q) { return req("GET", "sessions" + (q ? "?" + q : "")); },
        setActive: function (sessionId, title) { return req("POST", "active-session", { sessionId: sessionId, title: title || "" }); },
        refreshSessions: function (body) { return req("POST", "sessions/refresh", body || {}); },
        capture: function (body) { return req("POST", "capture", body || {}); },
        forwardSource: function (body) { return req("POST", "forward-source", body || {}); },
        bodyPreview: function (body) { return req("POST", "body-source/preview", body || {}); },
        promptSourceText: function () { return req("POST", "prompt-source/text", {}); },
        forward: function (body) { return req("POST", "forward", body || {}); },
        generate: function (body) { return req("POST", "generate", body || {}); },
        regenerate: function (body) { return req("POST", "regenerate", body || {}); },
        jobs: function (limit) { return req("GET", "jobs?limit=" + (limit || 30)); },
        job: function (id) { return req("GET", "jobs/" + encodeURIComponent(id)); },
        abort: function (id) { return req("POST", "jobs/" + encodeURIComponent(id) + "/abort", {}); },
        blackCheck: function (body) { return req("POST", "black-check", body || {}); },
        delJob: function (id) { return req("DELETE", "jobs/" + encodeURIComponent(id)); },
        clearJobs: function (keepActive) { return req("POST", "jobs/clear", { keepActive: keepActive !== false }); },
        images: function (q) { return req("GET", "images" + (q ? "?" + q : "")); },
        favorites: function (q) { return req("GET", "favorites" + (q ? "?" + q : "")); },
        image: function (id) { return req("GET", "images/" + encodeURIComponent(id)); },
        favorite: function (id) { return req("POST", "images/" + encodeURIComponent(id) + "/favorite", {}); },
        unfavorite: function (id) { return req("POST", "images/" + encodeURIComponent(id) + "/unfavorite", {}); },
        recycle: function (id) { return req("POST", "images/" + encodeURIComponent(id) + "/recycle", {}); },
        restore: function (id) { return req("POST", "images/" + encodeURIComponent(id) + "/restore", {}); },
        recycleList: function () { return req("GET", "recycle"); },
        purgeRecycle: function () { return req("POST", "recycle/purge", {}); },
        syncImages: function (apply) { return req("POST", "images/sync", { apply: !!apply }); },
        syncFavorites: function (apply) { return req("POST", "images/sync", { apply: !!apply, favorites: true }); },
        openFolder: function (body) { return req("POST", "open-folder", body || {}); },
        workflows: function () { return req("GET", "workflows"); },
        workflow: function (id) { return req("GET", "workflows/" + encodeURIComponent(id)); },
        saveWorkflow: function (body) { return req("POST", "workflows", body); },
        updateWorkflow: function (id, patch) { return req("PUT", "workflows/" + encodeURIComponent(id), patch); },
        delWorkflow: function (id) { return req("DELETE", "workflows/" + encodeURIComponent(id)); },
        activateWorkflow: function (id) { return req("POST", "workflows/" + encodeURIComponent(id) + "/activate", {}); },
        scan: function (body) { return req("POST", "workflows/scan", body); },
        dryRun: function (body) { return req("POST", "workflows/dry-run", body); },
        loras: function (body) { return req("POST", "loras", body || {}); },
        lorasApply: function (body) { return req("POST", "loras/apply", body || {}); },
        lorasReset: function (body) { return req("POST", "loras/reset", body || {}); },
        comfyStatus: function () { return req("GET", "comfy/status"); },
        interrupt: function () { return req("POST", "comfy/interrupt", {}); },
        rules: function () { return req("GET", "rules"); },
        rulePreview: function (body) { return req("POST", "rule/preview", body || {}); },
        formatReference: function () { return req("POST", "format/reference-reveal", {}); },
        clearAnchors: function (body) { return req("POST", "follow/clear-anchors", body || {}); },
        logs: function () { return req("GET", "logs"); },
        remoteProbe: function (body) { return req("POST", "remote/probe", body || {}); },
      };

      // 所有图片删除都走同一个去重入口：同一 id 的并发点击只发一个请求。
      // 后端本身也会对「已在回收站」返回 already；这里再把连点挡在浏览器侧。
      var recycleInflight = Object.create(null);
      function recycleImage(id) {
        var key = String(id || "");
        if (!key) return Promise.reject(new Error("图片 id 是空的"));
        if (recycleInflight[key]) {
          return recycleInflight[key].then(function (r) {
            return Object.assign({}, r || {}, { duplicate: true });
          });
        }
        var p = api.recycle(key);
        recycleInflight[key] = p;
        var clear = function () { delete recycleInflight[key]; };
        p.then(function (r) {
          clear();
          fireImageChanged(key);
          return r;
        }, clear);
        return p;
      }
      function fireImageChanged(id) {
        try {
          if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
          var ev;
          var detail = { imageId: String(id || "") };
          if (typeof CustomEvent === "function") ev = new CustomEvent(IMAGE_EVENT, { detail: detail });
          else if (typeof document !== "undefined" && document.createEvent) {
            ev = document.createEvent("CustomEvent");
            ev.initCustomEvent(IMAGE_EVENT, false, false, detail);
          } else return;
          window.dispatchEvent(ev);
        } catch (e) { /* ignore */ }
      }
      function recycleNotice(r) {
        if (r && (r.already || r.duplicate)) return "图片已在回收站，重复操作已忽略";
        return "已放进回收站";
      }

      /* ===================================================================
       * 样式（夜间灰调 / 日间浅色；所有类名 ac- 前缀）
       * =================================================================== */
      var CSS = `
:root{--ac-bg:#151517;--ac-bg2:#1b1b1d;--ac-card:#1b1b1d;--ac-raised:#2a2a2c;--ac-line:#303033;--ac-line2:#3a3a3d;--ac-text:#ececee;--ac-text2:#c6c6ca;--ac-muted:#a8a8ad;--ac-dim:#8a8a90;--ac-accent:#b3bfd0;--ac-accent2:#dbe1ea;--ac-ok:#6fbf8f;--ac-warn:#d1ac72;--ac-err:#d18a8a;--ac-fs:12.5px;--ac-fs-s:11.5px;--ac-fs-l:11px;}
.ac-root{--ac-bg:#151517;--ac-bg2:#1b1b1d;--ac-card:#1b1b1d;--ac-raised:#2a2a2c;--ac-line:#303033;--ac-line2:#3a3a3d;--ac-text:#ececee;--ac-text2:#c6c6ca;--ac-muted:#a8a8ad;--ac-dim:#8a8a90;--ac-accent:#b3bfd0;--ac-accent2:#dbe1ea;--ac-ok:#6fbf8f;--ac-warn:#d1ac72;--ac-err:#d18a8a;--ac-fs:12.5px;--ac-fs-s:11.5px;--ac-fs-l:11px;box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;background:var(--ac-bg);color:var(--ac-text);font-size:var(--ac-fs);line-height:1.5;font-family:var(--ac-font,inherit);color-scheme:dark;}
.ac-root *{box-sizing:border-box;}
.ac-blackbar{display:flex;align-items:center;gap:8px;padding:7px 10px;background:rgba(96,72,30,.5);border-bottom:1px solid var(--ac-line);color:var(--ac-text);font-size:var(--ac-fs-s);flex:0 0 auto;}
.ac-blackbar .ac-blackbar-txt{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ac-ballroot,.ac-ballroot *,.ac-overlay,.ac-overlay *{box-sizing:border-box;}
.ac-root ::selection{background:rgba(130,150,180,.35);}
.ac-root ::-webkit-scrollbar{width:8px;height:8px;}
.ac-root ::-webkit-scrollbar-thumb{background:#3a3d45;border-radius:4px;border:2px solid transparent;background-clip:padding-box;}
.ac-root ::-webkit-scrollbar-track{background:transparent;}
.ac-top{flex:none;padding:0 12px;border-bottom:1px solid var(--ac-line);display:flex;flex-direction:column;gap:0;}
.ac-toprow{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;min-width:0;}
.ac-brandline{display:flex;align-items:center;gap:9px;min-width:0;flex:1 1 auto;}
.ac-navrow{display:flex;align-items:center;gap:7px;min-width:0;height:40px;}
.ac-top .ac-seg{flex:1 1 auto;border:0;padding:0;justify-content:flex-start;min-width:0;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;}
.ac-top .ac-seg::-webkit-scrollbar{display:none;height:0;}
.ac-top .ac-segbtn{height:24px;padding:0 9px;font-size:11.5px;}
.ac-top .ac-segbtn + .ac-segbtn{position:relative;margin-left:13px;}
.ac-top .ac-segbtn + .ac-segbtn::before{content:"";position:absolute;left:-7px;top:50%;height:11px;border-left:1px solid var(--ac-line2);transform:translateY(-50%);}
.ac-navrow .ac-topacts{padding-left:2px;}
.ac-logo{width:31px;height:31px;border-radius:9px;background:#1b1b1d;border:1px solid #343437;display:flex;align-items:center;justify-content:center;flex:none;color:#e9edf3;}
.ac-brandtext{min-width:0;flex:1;}
.ac-title{font-size:15px;font-weight:650;line-height:1.2;letter-spacing:.015em;color:var(--ac-text);}
.ac-sub{font-size:11.5px;color:var(--ac-text2);line-height:1.4;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ac-overviewhead{display:flex;align-items:center;gap:10px;min-width:0;padding:4px 0 12px;}
.ac-overviewhead .ac-logo{width:35px;height:35px;border-radius:10px;}
.ac-overviewhead .ac-title{font-size:18px;font-weight:680;letter-spacing:.02em;}
.ac-overviewhead .ac-sub{font-size:11.5px;color:var(--ac-muted);margin-top:3px;overflow:visible;white-space:normal;}
.ac-basiclist{display:flex;flex-direction:column;gap:1px;min-width:0;}
.ac-basicrow{display:grid;grid-template-columns:86px minmax(0,1fr) auto 12px;gap:8px;align-items:center;width:100%;padding:6px 4px;border:0;border-radius:6px;background:transparent;color:var(--ac-text2);text-align:left;font:inherit;font-size:11.5px;line-height:1.45;cursor:pointer;}
.ac-basicrow:hover{background:rgba(255,255,255,.04);color:var(--ac-text);}
.ac-basick{color:var(--ac-dim);white-space:nowrap;}
.ac-basick::after{content:"：";}
.ac-basicv{min-width:0;color:var(--ac-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ac-basicgo{justify-self:end;color:var(--ac-dim);font-size:10.5px;line-height:1.3;white-space:nowrap;}
.ac-basicarrow{color:var(--ac-dim);font-size:14px;line-height:1.2;text-align:right;}
.ac-basicrow:hover .ac-basicarrow{color:var(--ac-text2);}
.ac-pathlink{display:inline;max-width:100%;padding:0;border:0;border-bottom:1px dashed #5b5f68;background:transparent;color:var(--ac-text2);font:inherit;font-size:11.5px;line-height:1.5;text-align:left;overflow-wrap:anywhere;cursor:pointer;}
.ac-pathlink:hover{color:var(--ac-text);border-bottom-color:var(--ac-text2);}
.ac-savepaths{display:flex;flex-direction:column;gap:6px;min-width:0;margin-top:7px;}
.ac-savepath{display:grid;grid-template-columns:62px minmax(0,1fr);gap:8px;align-items:start;min-width:0;font-size:11.5px;line-height:1.5;}
.ac-savepath > b{font-weight:400;color:var(--ac-dim);}
.ac-topacts{margin-left:auto;display:flex;gap:4px;flex:none;align-items:center;}
.ac-seg{flex:none;display:flex;flex-wrap:wrap;gap:2px;padding:6px 8px;border-bottom:1px solid var(--ac-line);min-width:0;}
.ac-segbtn{flex:0 0 auto;height:26px;padding:0 9px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--ac-text2);font-size:12px;cursor:pointer;white-space:nowrap;font-family:inherit;}
.ac-segbtn:hover{background:var(--ac-raised);color:var(--ac-text);}
.ac-segbtn.on{background:#2a2a2c;border-color:#3a3a3d;color:var(--ac-text);}
.ac-body{flex:1;min-height:0;overflow:auto;padding:10px 12px 28px;overscroll-behavior:contain;}
.ac-root.fullimg{background:transparent!important;height:100%;}
.ac-fullview{position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;background:transparent;overflow:hidden;}
.ac-fullview img{width:100%;height:100%;max-width:100%;max-height:100%;object-fit:contain;display:block;user-select:none;-webkit-user-drag:none;}
.ac-fullhint{color:var(--ac-text2);font-size:12px;text-align:center;line-height:1.7;text-shadow:0 1px 2px rgba(0,0,0,.22);}
.ac-full-loading{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2;padding:6px 12px;border-radius:999px;background:rgba(18,20,24,.62);border:1px solid rgba(255,255,255,.16);color:#e8ebf0;font-size:11.5px;pointer-events:none;backdrop-filter:blur(8px);}
.ac-fullbroken{color:#e8ebf0;font-size:12px;line-height:2;text-align:center;text-shadow:0 1px 3px rgba(0,0,0,.55);background:rgba(18,20,24,.35);padding:14px 18px;border-radius:9px;}
.ac-root.light .ac-fullbroken{color:#20242b;background:rgba(255,255,255,.42);text-shadow:0 1px 2px rgba(255,255,255,.5);}
.ac-fullclose{position:absolute;right:10px;top:10px;z-index:3;width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,255,255,.24);background:rgba(20,21,24,.55);color:#f4f6f9;display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer;backdrop-filter:blur(10px);box-shadow:0 4px 16px rgba(0,0,0,.22);opacity:0;pointer-events:none;transition:opacity .15s,background .12s,border-color .12s;}
.ac-fullclose.show{opacity:1;pointer-events:auto;}
.ac-fullclose:hover{background:rgba(34,36,41,.78);border-color:rgba(255,255,255,.36);}
@media (hover:none){.ac-fullclose{opacity:1;pointer-events:auto;}}
.ac-stack{display:flex;flex-direction:column;gap:0;}
.ac-card{background:transparent;border:0;border-bottom:1px solid rgba(255,255,255,.08);border-radius:0;padding:12px 0;margin:0;}
.ac-card:last-child{border-bottom:0;}
.ac-stack .ac-card{margin:0;}
.ac-grid2 .ac-card:last-child,.ac-grid2 .ac-stack:last-child .ac-card:last-child{border-bottom:0;}
.ac-card h2{font-size:12.5px;margin:0 0 8px;color:var(--ac-text);font-weight:600;letter-spacing:.01em;display:flex;align-items:center;gap:7px;line-height:1.35;flex-wrap:wrap;}
.ac-card h2 .ac-h2act{margin-left:auto;display:flex;gap:5px;font-weight:400;align-items:center;flex-wrap:wrap;justify-content:flex-end;}
.ac-card h2 .ac-h2sub{flex:0 0 100%;display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-weight:400;margin-top:5px;}
.ac-row{display:flex;gap:7px;flex-wrap:wrap;align-items:center;min-width:0;}
.ac-col{display:flex;flex-direction:column;gap:8px;min-width:0;}
.ac-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center;min-width:0;}
.ac-grid2,.ac-grid3{display:flex;flex-direction:column;gap:10px;min-width:0;}
.ac-mut{color:var(--ac-muted);}.ac-dim{color:var(--ac-dim);}.ac-small{font-size:var(--ac-fs-s);line-height:1.45;}.ac-mono{font-family:ui-monospace,Consolas,monospace;}
.ac-ell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ac-sep{height:1px;background:var(--ac-line);margin:9px 0;}
.ac-prompts{display:grid;grid-template-columns:1fr 1fr;gap:8px;min-width:0;}
.ac-promptcol{min-width:0;display:flex;flex-direction:column;}
.ac-prompthead{font-size:11.5px;color:var(--ac-text2);margin-bottom:4px;}
.ac-prompts .ac-ta{height:116px;min-height:116px;}
.ac-promptset + .ac-promptset{margin-top:10px;padding-top:10px;border-top:1px solid var(--ac-line);}
.ac-h2row{display:inline-flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap;}
.ac-linkbtn{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 2px;border:0;background:transparent;color:var(--ac-accent2);font:inherit;font-size:11.5px;line-height:1;cursor:pointer;white-space:nowrap;border-bottom:1px dotted currentColor;}
.ac-linkbtn:hover{color:var(--ac-accent);background:transparent;}
.ac-linkbtn:disabled{opacity:.45;cursor:not-allowed;}
.ac-promptsethead{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:6px;min-width:0;}
.ac-promptsetname{font-size:12px;color:var(--ac-text);font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ac-anchorbox{display:flex;align-items:center;gap:7px;margin:0 0 7px;min-width:0;}
.ac-anchorlabel{flex:none;font-size:11.5px;color:var(--ac-text2);white-space:nowrap;}
.ac-anchorbox .ac-in{flex:1 1 auto;min-width:0;}
.ac-anchorstate{margin:-2px 0 7px;font-size:11px;line-height:1.45;color:var(--ac-ok);overflow-wrap:anywhere;}
.ac-strengthrow{display:flex;gap:6px;align-items:flex-end;flex-wrap:wrap;}
.ac-strengthrow .ac-field{flex:1 1 72px;}
@media (max-width:560px){.ac-prompts{grid-template-columns:1fr;}}
.ac-hint{font-size:var(--ac-fs-s);color:var(--ac-dim);line-height:1.45;}
.ac-loading{font-size:var(--ac-fs-s);color:var(--ac-dim);padding:10px 0;}
.ac-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 9px;border-radius:6px;border:1px solid var(--ac-line2);background:var(--ac-raised);color:var(--ac-text);font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;font-family:inherit;transition:background .12s,border-color .12s,opacity .12s;}
.ac-btn:hover{border-color:#4c505c;background:#2d2f36;}
.ac-btn:disabled{opacity:.42;cursor:not-allowed;}
.ac-btn.primary{background:#39414e;border-color:#4c5767;color:#f3f6fa;}
.ac-btn.primary:hover{background:#424b5a;border-color:#5a667a;}
.ac-btn.ghost{background:transparent;border-color:transparent;color:var(--ac-text2);}
.ac-btn.ghost:hover{background:var(--ac-raised);color:var(--ac-text);}
.ac-btn.danger{color:#e0b4b4;border-color:#5a3d3d;background:#2e2325;}
.ac-btn.danger:hover{background:#3a2a2c;}
.ac-btn.sm{height:24px;padding:0 7px;font-size:11.5px;border-radius:5px;}
.ac-btn.icon{width:26px;padding:0;}
.ac-btn.block{width:100%;}
.ac-in,.ac-ta,.ac-sel{width:100%;max-width:100%;background:#2C2C2E;border:1px solid #3d3d40;color:var(--ac-text);border-radius:6px;padding:0 8px;font-size:12.5px;line-height:1.45;outline:none;min-width:0;font-family:inherit;transition:border-color .12s,box-shadow .12s;}
.ac-in,.ac-sel{height:30px;}
.ac-ta{padding:7px 8px;min-height:58px;resize:vertical;}
.ac-in:focus,.ac-ta:focus,.ac-sel:focus{border-color:#5b6474;box-shadow:0 0 0 2px rgba(120,145,180,.12);}
.ac-in:disabled,.ac-ta:disabled,.ac-sel:disabled{opacity:.58;background:#242426;border-color:#343437;color:var(--ac-dim);cursor:not-allowed;}
.ac-in::placeholder,.ac-ta::placeholder{color:#6f737d;}
.ac-sel{color:var(--ac-text);}
.ac-field{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 100%;}
.ac-field > label{font-size:var(--ac-fs-l);color:var(--ac-text2);letter-spacing:.015em;line-height:1.35;}
.ac-form{display:flex;flex-direction:column;gap:8px;min-width:0;}
.ac-form .ac-row > .ac-field{flex:1 1 100%;}
.ac-sizerow{display:flex;gap:6px;align-items:flex-end;}
.ac-sizerow .ac-field{flex:1 1 0;}
.ac-sizerow .ac-btn{flex:none;}
.ac-sizeswitchrow{display:flex;align-items:center;gap:0;margin-top:7px;line-height:1.55;}
.ac-sizeswitchrow .ac-switch{display:inline-flex;align-items:center;font-size:11.5px;line-height:1.55;color:var(--ac-dim);}
.ac-inlinehint{display:inline;font-size:11.5px;line-height:1.55;color:var(--ac-dim);}
.ac-genbtn{height:36px;min-width:112px;padding:0 18px;border-radius:8px;font-size:13.5px;font-weight:600;letter-spacing:.02em;margin-left:4px;}
.ac-deliverygrid{display:grid;grid-template-columns:minmax(0,1fr) 128px;gap:10px;align-items:start;min-width:0;}
.ac-deliverygrid .ac-field{min-width:0;}
.ac-deliveryacts{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-width:0;margin-top:10px;}
.ac-deliveryacts .ac-genbtn{margin-left:0;flex:none;}
.ac-deliverytoggles{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0;}
.ac-deliverybody{flex:1 1 100%;margin-bottom:10px;}
.ac-bodylabel{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;}
.ac-deliverybody .ac-ta{min-height:96px;max-height:240px;}
.ac-bodyhint{min-height:16px;margin-top:2px;font-size:11.5px;line-height:1.5;color:var(--ac-dim);word-break:break-all;}
@media (max-width:520px){.ac-deliverygrid{grid-template-columns:1fr;}}
.ac-jsonacts{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:7px;}
.ac-jsonacts .ac-filepick{background:#f3f6fa;border-color:#ffffff;color:#15181d;font-weight:650;box-shadow:0 0 0 1px rgba(255,255,255,.12),0 3px 10px rgba(0,0,0,.18);}
.ac-jsonacts .ac-filepick:hover{background:#ffffff;border-color:#ffffff;color:#0d1014;}
.ac-root.light .ac-jsonacts .ac-filepick{background:#ffffff;border-color:#9aa6b5;color:#141a22;box-shadow:0 1px 4px rgba(20,30,50,.12);}
.ac-root.light .ac-jsonacts .ac-filepick:hover{background:#f7f9fc;border-color:#6f7f93;}
.ac-tagrid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:8px;}
.ac-tagrid .ac-field{min-width:0;}
@media (max-width:520px){.ac-tagrid{grid-template-columns:1fr;}}
.ac-inline{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--ac-text2);min-width:0;}
.ac-switch{display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--ac-text2);user-select:none;line-height:1.35;}
.ac-switch input{accent-color:#8fa2ba;width:14px;height:14px;margin:0;flex:none;}
.ac-pill{display:inline-flex;align-items:center;gap:4px;min-height:20px;padding:2px 7px;border-radius:999px;background:#2a2a2c;border:1px solid #3a3a3d;font-size:11px;line-height:1.25;color:var(--ac-text2);white-space:nowrap;}
.ac-pill.ok{color:#b4d6c1;border-color:#3b5145;background:#1e2a23;}
.ac-pill.warn{color:#e0c79c;border-color:#514534;background:#2a241b;}
.ac-pill.err{color:#e2b6b6;border-color:#533a3a;background:#2b2021;}
.ac-pill.acc{color:#ccd5e1;border-color:#414752;background:#23262d;}
.ac-kv{display:grid;grid-template-columns:76px minmax(0,1fr);gap:4px 8px;font-size:var(--ac-fs-s);line-height:1.45;min-width:0;}
.ac-kv b{font-weight:400;color:var(--ac-dim);}
.ac-kv span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ac-kv.wrap{grid-template-columns:92px minmax(0,1fr);gap:6px 10px;}
.ac-kv.wrap span{white-space:normal;overflow:visible;text-overflow:clip;word-break:break-word;}
.ac-kv .ac-kvsub{color:var(--ac-dim);font-size:11px;}
.ac-wfbar{display:flex;align-items:center;gap:8px;min-width:0;font-size:12px;color:var(--ac-text2);line-height:1.45;}
.ac-wfbar .ac-wfname{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ac-text);}
.ac-help{display:flex;gap:6px;align-items:flex-start;margin-top:7px;padding:7px 8px;border:1px solid var(--ac-line);border-radius:6px;background:rgba(255,255,255,.025);font-size:11.5px;color:var(--ac-dim);line-height:1.55;}
.ac-thumbs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;}
.ac-thumb{position:relative;border:1px solid var(--ac-line2);border-radius:7px;overflow:hidden;background:#101114;cursor:zoom-in;width:100%;height:auto;aspect-ratio:1;min-width:0;}
.ac-thumb img{display:block;width:100%;height:100%;object-fit:cover;}
.ac-thumb.deleted{cursor:default;background:linear-gradient(135deg,#34363b,#202226);}
.ac-thumb.deleted img{filter:grayscale(1) brightness(.48);opacity:.72;}
.ac-thumb .ac-thumbdeleted{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;color:#c2c5cb;font-size:11px;letter-spacing:.04em;text-shadow:0 1px 2px rgba(0,0,0,.6);pointer-events:none;}
.ac-thumb .ac-thumbdeleted svg{opacity:.8;}
.ac-thumb .ac-tacts{position:absolute;right:4px;top:4px;display:flex;gap:3px;opacity:0;transition:opacity .12s;}
.ac-thumb:hover .ac-tacts{opacity:1;}
.ac-mini{width:24px;height:24px;border-radius:5px;border:1px solid rgba(255,255,255,.18);background:rgba(24,25,29,.78);color:#eceef2;font-size:12px;line-height:22px;text-align:center;cursor:pointer;backdrop-filter:blur(4px);}
.ac-mini:hover{background:rgba(54,56,64,.95);}
.ac-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;min-width:0;}
.ac-gallerybar{display:flex;flex-wrap:wrap;align-items:center;gap:7px 10px;min-width:0;}
.ac-gallerybar .ac-hint{min-width:0;flex:1 1 180px;}
.ac-galleryacts{margin-left:auto;display:flex;flex-wrap:wrap;gap:6px;align-items:center;justify-content:flex-end;}
.ac-gallery{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;min-width:0;}
.ac-pager-top{margin-top:2px;margin-bottom:1px;}
.ac-cell{background:var(--ac-card);border:1px solid var(--ac-line);border-radius:8px;overflow:hidden;display:flex;flex-direction:column;min-width:0;}
.ac-cell .ac-imgbox{position:relative;aspect-ratio:1;background:#101114;overflow:hidden;}
.ac-cell .ac-imgbox img{width:100%;height:100%;object-fit:cover;display:block;}
.ac-cell .ac-meta{padding:6px 7px;display:flex;flex-direction:column;gap:2px;min-width:0;}
.ac-cell .ac-meta .ac-t{font-size:11.5px;color:var(--ac-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.35;}
.ac-cell .ac-meta .ac-p{font-size:11px;color:var(--ac-text2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.35;}
.ac-pager{display:flex;align-items:center;gap:7px;margin-top:10px;font-size:11.5px;color:var(--ac-text2);flex-wrap:wrap;}
.ac-setcard{border:1px solid var(--ac-line);border-radius:7px;background:#1b1c21;padding:8px 9px;margin-bottom:7px;}
.ac-settitle{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--ac-text2);margin-bottom:5px;flex-wrap:wrap;}
.ac-steps{display:flex;gap:4px;flex-wrap:wrap;}
.ac-step{padding:4px 7px;border:1px solid var(--ac-line);border-radius:5px;background:#1a1b1f;font-size:11px;color:var(--ac-dim);display:flex;align-items:center;gap:4px;line-height:1.3;}
.ac-step.on{color:#d6deea;border-color:#465063;background:#20242c;}
.ac-step.done{color:#b4d6c1;border-color:#3b5145;background:#1e2a23;}
.ac-log{background:#1b1b1d;border:1px solid var(--ac-line);border-radius:7px;padding:7px 8px;font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.55;max-height:300px;overflow:auto;}
.ac-log .l{display:flex;gap:7px;min-width:0;}
.ac-log .t{color:#6d717b;flex:none;}
.ac-log .m{white-space:pre-wrap;word-break:break-word;min-width:0;}
.ac-log .lv-info{color:#b7bbc4;}.ac-log .lv-warn{color:#e0c79c;}.ac-log .lv-error{color:#e2b6b6;}
.ac-empty{border:1px dashed var(--ac-line2);border-radius:7px;padding:16px 10px;text-align:center;color:var(--ac-dim);font-size:12px;line-height:1.5;}
.ac-toaststack{position:fixed;right:18px;bottom:18px;z-index:2147483005;display:flex;flex-direction:column;align-items:flex-end;gap:6px;max-width:min(420px,calc(100vw - 36px));pointer-events:none;}
.ac-globaltoaststack{position:fixed;right:18px;bottom:18px;z-index:2147483006;display:flex;flex-direction:column;align-items:flex-end;gap:6px;max-width:min(440px,calc(100vw - 36px));pointer-events:none;}
.ac-globaltoaststack .ac-toast{pointer-events:none;}
.ac-toast{position:relative;max-width:min(420px,calc(100vw - 36px));background:#2C2C2E;border:1px solid #454548;border-radius:8px;padding:8px 11px;font-size:12px;color:#ececee;box-shadow:0 10px 34px rgba(0,0,0,.45);white-space:pre-wrap;line-height:1.45;pointer-events:auto;}
.ac-toast.err{border-color:#5d4141;color:#e6c3c3;}.ac-toast.ok{border-color:#3f5347;color:#c7e0d1;}.ac-toast.warn{border-color:#5c513d;color:#e0c79c;}
.ac-toast.light{background:#fff;border-color:#d5dbe4;color:#1c2027;box-shadow:0 12px 36px rgba(30,42,58,.18);}
.ac-toast.light.ok{border-color:#b9d9c5;color:#255d3b;}
.ac-toast.light.err{border-color:#e2bcbc;color:#8e3333;}
.ac-overlay{position:fixed;inset:0;background:rgba(8,9,11,.86);z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:18px;backdrop-filter:blur(4px);font-size:var(--ac-fs);line-height:1.5;color:var(--ac-text);color-scheme:dark;}
.ac-modal{width:min(620px,calc(100vw - 36px));max-height:min(78vh,720px);overflow:auto;background:#18191d;border:1px solid #3a3c44;border-radius:11px;padding:16px;box-shadow:0 18px 55px rgba(0,0,0,.48);}
.ac-modal h3{margin:0;font-size:14px;color:var(--ac-text);}
.ac-modal p{margin:0 0 9px;font-size:12px;line-height:1.7;color:var(--ac-text);}
.ac-modal .ac-helpcode{margin:0 0 10px;padding:10px;border-radius:7px;background:#101114;border:1px solid #34363e;color:#d8dbe3;font:11.5px/1.6 ui-monospace,Consolas,monospace;white-space:pre-wrap;overflow:auto;}
.ac-viewer{max-width:min(1120px,96vw);max-height:92vh;display:flex;gap:0;background:#18191d;border:1px solid #3a3c44;border-radius:10px;overflow:hidden;}
.ac-viewer .pic{min-width:0;min-height:0;display:flex;align-items:center;justify-content:center;background:#0d0e10;}
.ac-viewer .pic img{max-width:100%;max-height:88vh;object-fit:contain;display:block;}
.ac-viewer .side{width:300px;flex:none;padding:12px;overflow:auto;display:flex;flex-direction:column;gap:8px;}
.ac-viewer .side .ac-kv{grid-template-columns:62px minmax(0,1fr);}
.ac-code{white-space:pre-wrap;word-break:break-word;background:#1b1b1d;border:1px solid var(--ac-line);border-radius:6px;padding:7px 8px;font-size:11px;line-height:1.5;max-height:150px;overflow:auto;color:#c4c4c9;font-family:ui-monospace,Consolas,monospace;}
.ac-json{font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.45;}
.ac-wf{display:flex;flex-direction:column;gap:10px;align-items:stretch;}
.ac-wflist{display:flex;flex-direction:column;gap:5px;max-height:180px;overflow:auto;}
.ac-wfitem{padding:7px 8px;border:1px solid var(--ac-line);border-radius:6px;background:#1b1c20;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:6px;min-width:0;}
.ac-wfitem:hover{border-color:var(--ac-line2);}
.ac-wfitem.on{border-color:#4d5668;background:#22252c;}
.ac-wfitem .ac-nm{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ac-wfitem .ac-mini2{margin-left:auto;font-size:11px;color:var(--ac-dim);flex:none;}
.ac-table{width:100%;border-collapse:collapse;font-size:11.5px;line-height:1.4;}
.ac-table th,.ac-table td{border-bottom:1px solid var(--ac-line);padding:5px 4px;text-align:left;vertical-align:top;}
.ac-table th{color:var(--ac-dim);font-weight:400;font-size:11px;white-space:nowrap;}
.ac-table tr:hover td{background:#1f2025;}
.ac-tablewrap{overflow:auto;max-height:300px;border:1px solid var(--ac-line);border-radius:6px;}
.ac-tablewrap .ac-table th{position:sticky;top:0;background:var(--ac-card);z-index:1;}
.ac-monolist{max-height:180px;overflow:auto;border:1px solid var(--ac-line);border-radius:6px;background:#141519;padding:5px;display:flex;flex-direction:column;gap:2px;}
.ac-monorow{display:flex;gap:6px;align-items:center;font-size:11.5px;padding:3px 4px;border-radius:4px;min-width:0;}
.ac-monorow:hover{background:#1d1e23;}
.ac-scroll{overflow:auto;min-height:0;}
.ac-tabs{display:flex;gap:4px;flex-wrap:wrap;}
.ac-tab{padding:4px 8px;border-radius:5px;border:1px solid var(--ac-line);background:#1b1c20;color:var(--ac-text2);font-size:11.5px;cursor:pointer;font-family:inherit;line-height:1.35;}
.ac-tab.on{color:var(--ac-text);border-color:#4d5668;background:#22252c;}
.ac-subtabs{display:flex;gap:3px;padding:3px;background:#15161a;border:1px solid var(--ac-line);border-radius:7px;}
.ac-subtab{flex:1;height:25px;border:0;border-radius:5px;background:transparent;color:var(--ac-text2);font-size:11.5px;cursor:pointer;font-family:inherit;}
.ac-subtab.on{background:#2b2d35;color:var(--ac-text);}
.ac-lorarow{position:relative;display:grid;grid-template-columns:16px minmax(0,1fr) 48px 46px 40px;gap:5px;align-items:center;font-size:11.5px;padding:4px 0;min-width:0;}
.ac-lorarow.loose{grid-template-columns:16px minmax(0,1fr) 48px;}
.ac-lorarow .nm{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ac-lorarow .ac-loraname{display:block;width:100%;max-width:100%;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:text;border-radius:3px;}
.ac-lorarow .ac-loraname:hover{color:var(--ac-text);text-decoration:underline dotted;text-underline-offset:2px;}
.ac-lorarow .ac-loraname:disabled{cursor:default;color:var(--ac-dim);text-decoration:none;}
.ac-lorarow input.ac-loraname{width:100%;height:24px;padding:0 4px;background:#141519;border:1px solid var(--ac-line2);color:var(--ac-text);border-radius:4px;font-size:11.5px;}
.ac-lorarow.cont{opacity:.55;}
.ac-lorarow.cont input[type=checkbox],.ac-lorarow.cont input[type=number]{cursor:not-allowed;}
.ac-root.light .ac-lorarow input.ac-loraname{background:#fff;border-color:#cdd4de;color:#1c2027;}
.ac-lorarow input[type=number]{width:48px;height:24px;padding:0 4px;font-size:11.5px;background:#141519;border:1px solid var(--ac-line2);color:var(--ac-text);border-radius:4px;}
.ac-lorarow input[type=checkbox]{accent-color:#8fa2ba;width:14px;height:14px;margin:0;}
.ac-drag{display:flex;align-items:center;justify-content:center;width:28px;height:26px;cursor:grab;color:var(--ac-dim);border-radius:4px;flex:none;user-select:none;touch-action:none;-webkit-user-drag:none;}
.ac-drag:hover{background:var(--ac-raised);color:var(--ac-text);}
.ac-drag:active{cursor:grabbing;}
.ac-lorarow.dragging{opacity:.38;}
.ac-lorarow.drop-before:before,.ac-lorarow.drop-after:after{content:"";position:absolute;left:0;right:0;height:2px;border-radius:1px;background:#4d8dff;box-shadow:0 0 0 1px rgba(77,141,255,.18);pointer-events:none;}
.ac-lorarow.drop-before:before{top:-2px;}
.ac-lorarow.drop-after:after{bottom:-2px;}
.ac-lorahead{display:flex;align-items:center;gap:6px;margin:8px 0 3px;font-size:11.5px;color:var(--ac-text2);flex-wrap:wrap;}
.ac-lorahead b{color:var(--ac-text);font-weight:500;}
.ac-words{display:flex;flex-wrap:wrap;gap:4px;padding:4px 0 3px 21px;}
.ac-word{font-size:11px;padding:2px 6px;border-radius:999px;border:1px solid var(--ac-line);background:#191a1e;color:var(--ac-text2);cursor:pointer;}
.ac-word.on{color:#d3dfea;border-color:#465063;background:#20242c;}
.ac-word.off{text-decoration:line-through;opacity:.55;}
.ac-jobrow{display:flex;align-items:center;gap:7px;padding:6px 0;border-bottom:1px solid var(--ac-line);font-size:11.5px;min-width:0;}
.ac-jobrow:last-child{border-bottom:0;}
.ac-jobmain{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ac-text2);}
.ac-jobstatus{width:7px;height:7px;border-radius:50%;flex:none;background:var(--ac-dim);}
.ac-jobstatus.ok{background:var(--ac-ok);}.ac-jobstatus.err{background:var(--ac-err);}.ac-jobstatus.warn{background:var(--ac-warn);}
.ac-maprows{display:flex;flex-direction:column;gap:0;}
.ac-maprow{display:flex;flex-direction:column;gap:6px;min-width:0;padding:9px 0;border-bottom:1px solid var(--ac-line);}
.ac-maprow:last-child{border-bottom:0;}
.ac-mapnode{font-size:11.5px;color:var(--ac-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}
.ac-mapmeta{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0;}
.ac-maprole{display:flex;align-items:center;min-width:0;}
.ac-maprow.missing .ac-mapnode{color:var(--ac-dim);font-weight:400;}
.ac-mapmeta .ac-sel{flex:0 0 128px;width:128px;height:26px;font-size:11.5px;}
.ac-tokenlist{display:flex;flex-wrap:wrap;gap:5px 12px;margin-top:8px;padding-top:7px;border-top:1px solid var(--ac-line);}
.ac-tokenitem{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--ac-text2);}
.ac-tokenitem.muted{opacity:.45;}
.ac-tokenlabel,.ac-tokencount{color:var(--ac-dim);}
.ac-node{border:1px solid var(--ac-line);border-radius:6px;background:#1b1c20;padding:6px 7px;margin-bottom:5px;min-width:0;}
.ac-nodehead{font-size:11.5px;color:var(--ac-text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:4px;}
.ac-nodemeta{display:flex;gap:8px;align-items:center;justify-content:space-between;min-width:0;}
.ac-nodekind{display:flex;align-items:center;gap:6px;min-width:0;flex:1;flex-wrap:wrap;}
.ac-nodehint{font-size:10.5px;line-height:1.35;color:var(--ac-dim);min-width:0;}
.ac-nodemeta .ac-pill{flex:none;}
.ac-nodemeta .ac-sel{height:26px;font-size:11.5px;flex:0 0 118px;width:118px;min-width:0;}
.ac-subtitle{font-size:11.5px;font-weight:600;color:var(--ac-text2);margin:2px 0 6px;}
.ac-tokenlink{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;padding:1px 4px;border-radius:4px;background:#23262d;border:1px solid #3a3f4a;color:#9fc7ff;cursor:pointer;white-space:nowrap;}
.ac-tokenlink:hover{border-color:#5b6d86;background:#2b303a;}
.ac-dot{width:7px;height:7px;border-radius:50%;background:var(--ac-dim);flex:none;display:inline-block;}
.ac-dot.ok{background:var(--ac-ok);box-shadow:0 0 0 3px rgba(111,191,143,.12);}
.ac-dot.warn{background:var(--ac-warn);box-shadow:0 0 0 3px rgba(209,172,114,.12);}
.ac-dot.err{background:var(--ac-err);box-shadow:0 0 0 3px rgba(209,138,138,.12);}
.ac-tabtitle{display:inline-flex;align-items:center;gap:5px;min-width:0;color:inherit;font:inherit;line-height:1;}
.ac-details{margin-top:8px;border-top:1px solid var(--ac-line);padding-top:7px;}
.ac-details summary{cursor:pointer;color:var(--ac-text2);font-size:11.5px;list-style:none;display:flex;align-items:center;gap:5px;line-height:1.4;}
.ac-details summary::-webkit-details-marker{display:none;}
.ac-details summary:before{content:"▸";color:var(--ac-dim);font-size:10px;}
.ac-details[open] summary:before{content:"▾";}
.ac-overlay{pointer-events:auto;}
.ac-ballroot{position:fixed;inset:0;pointer-events:none;z-index:2147482000;}
.ac-ballroot.ac-debug-only{z-index:2147483200;}
.ac-ballroot.ac-debug-only > *{visibility:hidden!important;pointer-events:none!important;}
.ac-ballroot.ac-debug-only > .ac-followline,
.ac-ballroot.ac-debug-only > .ac-followhud,
.ac-ballroot.ac-debug-only > .ac-followoffset{visibility:visible!important;}
.ac-ballroot.ac-debug-only > .ac-followoffset{pointer-events:auto!important;}
.ac-followline{position:fixed;display:none;height:0;border-top:1px dashed rgba(80,226,196,.95);box-shadow:0 0 6px rgba(80,226,196,.55);pointer-events:none;z-index:2147483000;}
.ac-followline .ac-followtag{position:absolute;right:2px;top:3px;max-width:min(520px,70vw);padding:2px 7px;border-radius:5px;background:rgba(8,20,19,.88);color:#8ff0dc;border:1px solid rgba(80,226,196,.45);font:11px/1.45 ui-monospace,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ac-followline.ac-followline-offset{border-top-color:rgba(96,170,255,.95);box-shadow:0 0 6px rgba(96,170,255,.55);}
.ac-followline.ac-followline-offset .ac-followtag{background:rgba(8,15,28,.9);color:#b9dcff;border-color:rgba(96,170,255,.5);}
.ac-followoffset{position:fixed;right:14px;top:50%;transform:translateY(-50%);z-index:2147483001;pointer-events:auto;display:flex;flex-direction:column;align-items:center;gap:7px;padding:9px 8px;border-radius:10px;background:rgba(8,12,18,.9);border:1px solid rgba(120,170,210,.38);box-shadow:0 4px 18px rgba(0,0,0,.35);color:#cfe9ff;font:10.5px/1.35 ui-monospace,Consolas,monospace;user-select:none;touch-action:none;}
.ac-followoffset b{font-weight:600;color:#9fd2ff;font-size:10px;letter-spacing:.5px;}
.ac-followoffset-track{position:relative;width:28px;height:176px;border-radius:999px;background:linear-gradient(180deg,rgba(96,170,255,.16),rgba(255,255,255,.05));border:1px solid rgba(120,170,210,.28);cursor:ns-resize;touch-action:none;}
.ac-followoffset-track:before{content:"";position:absolute;left:50%;top:50%;width:22px;height:1px;transform:translate(-50%,-50%);background:rgba(160,200,235,.38);}
.ac-followoffset-mid{position:absolute;left:50%;top:50%;width:8px;height:1px;transform:translate(-50%,-50%);background:#9fd2ff;opacity:.8;}
.ac-followoffset-fill{position:absolute;left:50%;width:3px;transform:translateX(-50%);background:rgba(96,170,255,.75);border-radius:2px;}
.ac-followoffset-thumb{position:absolute;left:50%;width:18px;height:18px;border-radius:50%;transform:translate(-50%,-50%);background:#62b8ff;border:2px solid #d9efff;box-shadow:0 0 8px rgba(96,170,255,.7);}
.ac-followoffset-v{min-width:42px;text-align:center;color:#eaf5ff;}
.ac-followoffset button{border:1px solid rgba(120,170,210,.4);background:rgba(255,255,255,.06);color:#cfe9ff;border-radius:5px;padding:2px 6px;font:10px/1.3 inherit;cursor:pointer;}
.ac-followoffset button:hover{background:rgba(96,170,255,.18);}
.ac-followhud{position:fixed;left:12px;bottom:12px;max-width:min(560px,78vw);padding:7px 10px;border-radius:8px;background:rgba(8,12,18,.88);border:1px solid rgba(120,170,210,.38);box-shadow:0 4px 18px rgba(0,0,0,.35);color:#cfe9ff;font:11px/1.55 ui-monospace,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;pointer-events:none;z-index:2147483000;}
.ac-followhud .ac-followk{color:#7ce7d0;}
.ac-ball{position:fixed;width:46px;height:46px;border-radius:14px;background:rgba(38,39,44,.62);border:1px solid rgba(255,255,255,.18);box-shadow:0 5px 16px rgba(0,0,0,.30);backdrop-filter:blur(16px) saturate(140%);display:flex;align-items:center;justify-content:center;cursor:pointer;pointer-events:auto;user-select:none;touch-action:none;font-size:23px;line-height:1;color:#f1f3f6;}
.ac-ball:hover{background:rgba(58,59,66,.76);border-color:rgba(255,255,255,.28);}
.ac-frame{position:fixed;pointer-events:auto;background:rgba(128,128,128,.25);border:1px solid rgba(255,255,255,.30);border-radius:14px;box-shadow:0 4px 16px rgba(0,0,0,.18),0 0 8px rgba(0,0,0,.10);overflow:hidden;display:flex;flex-direction:column;will-change:transform;}
.ac-frame.square{border-radius:0;}
.ac-frame.square .ac-stage{border-radius:0;}
.ac-frame .ac-stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:transparent;overflow:hidden;cursor:grab;touch-action:none;}
.ac-frame.dragging{box-shadow:0 4px 14px rgba(0,0,0,.20);}
.ac-frame.dragging .ac-stage{cursor:grabbing;}
.ac-frame .ac-stage img{width:100%;height:100%;object-fit:contain;display:block;pointer-events:none;user-select:none;-webkit-user-drag:none;}
.ac-frame .ac-stage-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;color:#b4b6bd;font-size:13px;text-align:center;padding:20px;pointer-events:none;background:transparent;}
.ac-frame .ac-empty-hint{font-size:11px;color:#8f9199;letter-spacing:.02em;}
.ac-frame .ac-counter{position:absolute;left:50%;top:10px;transform:translateX(-50%);z-index:6;padding:4px 10px;border-radius:999px;background:rgba(24,25,29,.78);border:1px solid rgba(255,255,255,.16);color:#eef1f5;font-size:11px;line-height:1.3;letter-spacing:.03em;pointer-events:none;opacity:0;transition:opacity .18s;backdrop-filter:blur(8px);white-space:nowrap;}
.ac-frame .ac-counter.show{opacity:1;}
.ac-fullcounter{position:absolute;left:50%;top:10px;transform:translateX(-50%);z-index:4;padding:4px 10px;border-radius:999px;background:rgba(24,25,29,.78);border:1px solid rgba(255,255,255,.16);color:#eef1f5;font-size:11px;line-height:1.3;letter-spacing:.03em;pointer-events:none;opacity:0;transition:opacity .18s;backdrop-filter:blur(8px);white-space:nowrap;}
.ac-fullcounter.show{opacity:1;}
.ac-frame .ac-frameloading{position:absolute;inset:0;z-index:4;display:flex;align-items:center;justify-content:center;gap:7px;background:rgba(12,13,16,.16);color:#eef1f5;font-size:12px;pointer-events:none;backdrop-filter:blur(1px);}
.ac-spinner{width:14px;height:14px;border:2px solid rgba(255,255,255,.28);border-top-color:#fff;border-radius:50%;animation:acspin .8s linear infinite;flex:none;}
@keyframes acspin{to{transform:rotate(360deg);}}
.ac-frame .ac-cap{position:absolute;left:11px;top:11px;right:86px;display:flex;align-items:center;gap:6px;min-width:0;padding:4px 7px;border-radius:999px;background:rgba(28,29,34,.78);border:1px solid rgba(255,255,255,.12);color:#d9dde4;font-size:11px;line-height:1.3;backdrop-filter:blur(8px);opacity:0;transition:opacity .15s;pointer-events:none;}
.ac-frame .ac-cap.show{opacity:1;}
.ac-frame .ac-cap .ac-capname{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ac-frame .ac-bl,
.ac-fullview .ac-bl{position:absolute;left:11px;bottom:11px;z-index:5;display:flex;flex-direction:row;align-items:center;gap:8px;opacity:0;transition:opacity .15s;pointer-events:none;max-width:calc(100% - 62px);overflow:visible;}
.ac-frame .ac-bl.show,
.ac-fullview .ac-bl.show{opacity:1;pointer-events:auto;}
.ac-pencil{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer;font-size:14px;font-family:inherit;flex:none;color:#f4f5f7;}
.ac-pencil svg{display:block;pointer-events:none;}
.ac-bubblemenu{position:relative;display:flex;flex-direction:row;flex-wrap:nowrap;align-items:center;gap:6px;pointer-events:auto;flex:1 1 auto;min-width:0;max-width:100%;overflow:hidden;}
.ac-bubblemenu.clipped{-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 36px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 36px),transparent);}
.ac-bubble{display:inline-flex;align-items:center;gap:6px;min-height:30px;padding:0 11px;border-radius:15px;border:1px solid rgba(255,255,255,.17);background:#2c2c2e;color:#f1f3f6;box-shadow:none;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer;font-family:inherit;flex:0 0 auto;}
.ac-bubble:hover{background:#38383c;border-color:rgba(255,255,255,.26);}
.ac-bubble:disabled{opacity:.38;cursor:not-allowed;}
.ac-bubble.on{border-color:rgba(160,190,220,.55);color:#e6f0fa;}
.ac-bubble.ac-icononly{width:30px;padding:0;justify-content:center;border-radius:50%;}
.ac-bubble .ac-bubchev{margin-left:2px;color:#a9abb2;font-size:10px;}
.ac-bubble .ac-strike{text-decoration:line-through;text-decoration-thickness:1.6px;text-decoration-color:currentColor;}
.ac-morewrap{position:relative;flex:0 0 auto;}
.ac-bubble-sub{position:absolute;left:0;bottom:calc(100% + 8px);display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:0;z-index:7;}
.ac-regenbox{position:absolute;left:0;bottom:calc(100% + 8px);width:min(300px,calc(100vw - 34px));z-index:9;display:flex;flex-direction:column;gap:7px;padding:9px;border:1px solid rgba(255,255,255,.16);border-radius:10px;background:rgba(24,25,29,.97);box-shadow:0 10px 28px rgba(0,0,0,.42);pointer-events:auto;}
.ac-regenbox .ac-regentitle{font-size:12px;color:var(--ac-text);font-weight:600;line-height:1.3;}
.ac-regenbox .ac-regeninput{width:100%;box-sizing:border-box;resize:vertical;min-height:48px;font-size:11.5px;}
.ac-regenbox .ac-regenopt{display:grid;grid-template-columns:auto minmax(0,1fr);gap:7px;align-items:start;}
.ac-regenbox .ac-regenopt .ac-hint{font-size:10.5px;line-height:1.45;}
.ac-frame .ac-toolrow{display:flex;align-items:center;gap:5px;flex-wrap:wrap;max-width:100%;}
.ac-frame .ac-br{position:absolute;right:11px;bottom:11px;z-index:6;opacity:0;transition:opacity .15s;pointer-events:none;}
.ac-frame .ac-br.show{opacity:1;pointer-events:auto;}
.ac-frame .ac-tl{position:absolute;left:11px;top:11px;z-index:7;display:flex;align-items:center;gap:6px;opacity:0;transition:opacity .15s;pointer-events:none;}
.ac-frame .ac-tl.show{opacity:1;pointer-events:auto;}
.ac-fullview .ac-tl{position:absolute;left:11px;top:11px;z-index:6;display:flex;align-items:center;gap:6px;opacity:0;transition:opacity .15s;pointer-events:none;}
.ac-fullview .ac-tl.show{opacity:1;pointer-events:auto;}
.ac-frame .ac-tr{position:absolute;right:11px;top:11px;z-index:7;opacity:0;transition:opacity .15s;pointer-events:none;}
.ac-frame .ac-tr.show{opacity:1;pointer-events:auto;}
.ac-frame .ac-sidenav{position:absolute;top:50%;width:88px;height:176px;margin-top:-88px;z-index:4;border:0;border-radius:16px;background:transparent;color:#f2f4f8;display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer;opacity:0;pointer-events:auto;transition:opacity .15s;font-family:inherit;}
.ac-frame .ac-sidenav.left{left:0;justify-content:flex-start;padding-left:8px;}
.ac-frame .ac-sidenav.right{right:0;justify-content:flex-end;padding-right:8px;}
.ac-frame .ac-sidenav:hover,.ac-frame .ac-sidenav:focus-visible,.ac-frame .ac-sidenav.show{opacity:1;}
.ac-frame .ac-sidenav.is-disabled{opacity:.22;}
.ac-fullview .ac-sidenav{position:absolute;top:50%;width:96px;height:200px;margin-top:-100px;z-index:4;border:0;border-radius:18px;background:transparent;color:#f2f4f8;display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer;opacity:0;pointer-events:auto;transition:opacity .15s;}
.ac-fullview .ac-sidenav.left{left:0;justify-content:flex-start;padding-left:10px;}
.ac-fullview .ac-sidenav.right{right:0;justify-content:flex-end;padding-right:10px;}
.ac-fullview .ac-sidenav:hover,.ac-fullview .ac-sidenav:focus-visible,.ac-fullview .ac-sidenav.show{opacity:1;}
.ac-fullview .ac-sidenav.is-disabled{opacity:.22;}
.ac-frame.docked{box-sizing:border-box;border-radius:0;border:0;border-right:1px solid rgba(255,255,255,.22);box-shadow:none;background:transparent;}
.ac-frame.docked .ac-stage{background:transparent;}
/* 悬浮于左侧只放一次位，之后框不再随图变化；比例对不上时整张图装进来，不裁切。 */
.ac-frame.reserved .ac-stage img{object-fit:contain;}
.ac-frame .ac-dockgrip{position:absolute;right:0;top:0;bottom:0;width:9px;z-index:10;cursor:col-resize;touch-action:none;}
.ac-frame .ac-dockgrip:after{content:"";position:absolute;right:3px;top:50%;width:2px;height:42px;margin-top:-21px;border-radius:2px;background:rgba(255,255,255,.26);opacity:0;transition:opacity .15s;}
.ac-frame .ac-dockgrip:hover:after{opacity:1;}
[data-conversation-content][data-airp-dock="left"],[data-conversation-scroll][data-airp-dock="left"]{box-sizing:border-box;padding-left:var(--airp-dock-left,0px);}
[data-conversation-content][data-airp-dock="left"] [data-width-handle],[data-conversation-scroll][data-airp-dock="left"] [data-width-handle]{display:none!important;}
[data-conversation-content][data-airp-reserve="left"],[data-conversation-scroll][data-airp-reserve="left"]{box-sizing:border-box;padding-left:var(--airp-reserve-left,0px);}
[data-conversation-content][data-airp-reserve="left"] [data-width-handle],[data-conversation-scroll][data-airp-reserve="left"] [data-width-handle]{display:none!important;}
.ac-leftrail{position:fixed;width:15px;margin-left:-7px;z-index:12;cursor:col-resize;touch-action:none;background:transparent;pointer-events:auto;}
.ac-leftrail .ac-railline{position:absolute;left:7px;width:1px;background:linear-gradient(180deg,transparent 0,rgba(255,255,255,.52) 10%,rgba(255,255,255,.52) 90%,transparent 100%);opacity:0;transition:opacity .16s;pointer-events:none;}
.ac-leftrail.show .ac-railline{opacity:1;}
.ac-leftrail.show:hover .ac-railline{background:linear-gradient(180deg,transparent 0,rgba(255,255,255,.72) 10%,rgba(255,255,255,.72) 90%,transparent 100%);}
.ac-glass{background:#2c2c2e;border:1px solid rgba(255,255,255,.17);color:#f1f3f6;box-shadow:none;}
.ac-glass:hover{background:#38383c;border-color:rgba(255,255,255,.26);}
.ac-round{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:12px;flex:none;padding:0;font-family:inherit;}
.ac-round:disabled{opacity:.35;cursor:not-allowed;}
.ac-round.on{color:#dcecff;border-color:rgba(114,170,255,.62);background:#253247;}
.ac-tool{height:30px;border-radius:15px;padding:0 10px;display:inline-flex;align-items:center;gap:5px;font-size:11.5px;white-space:nowrap;cursor:pointer;flex:none;font-family:inherit;line-height:1;}
.ac-tool:disabled{opacity:.45;cursor:not-allowed;}
.ac-frame .ac-menu{position:absolute;right:11px;bottom:49px;min-width:132px;background:rgba(27,27,29,.98);border:1px solid rgba(255,255,255,.18);border-radius:9px;box-shadow:0 12px 34px rgba(0,0,0,.55);padding:4px;display:flex;flex-direction:column;gap:1px;backdrop-filter:blur(12px);}
.ac-menurow{display:flex;align-items:center;gap:7px;height:28px;padding:0 8px;border:0;border-radius:5px;background:transparent;color:#e6e9ee;font-size:12px;cursor:pointer;text-align:left;font-family:inherit;white-space:nowrap;}
.ac-menurow:hover{background:rgba(255,255,255,.09);}
.ac-submenu{display:flex;flex-direction:column;gap:1px;margin:2px 0 2px 7px;padding-left:6px;border-left:1px solid rgba(255,255,255,.14);}
.ac-frametoaststack{position:absolute;left:11px;top:52px;max-width:calc(100% - 24px);display:flex;flex-direction:column;align-items:flex-start;gap:4px;z-index:8;pointer-events:none;}
.ac-frametoast{position:relative;max-width:calc(100% - 24px);background:#2C2C2E;border:1px solid #454548;border-radius:7px;padding:6px 9px;font-size:11.5px;color:#ececee;box-shadow:0 8px 24px rgba(0,0,0,.45);white-space:pre-wrap;line-height:1.4;pointer-events:none;}
@media (min-width:680px){.ac-grid{grid-template-columns:repeat(3,minmax(0,1fr));}.ac-thumbs{grid-template-columns:repeat(3,minmax(0,1fr));}}
@media (max-width:520px){.ac-viewer{flex-direction:column;width:96vw;max-height:92vh;overflow:auto;}.ac-viewer .pic img{max-height:58vh;}.ac-viewer .side{width:100%;}.ac-top{padding:10px 10px 8px;}.ac-body{padding:8px 10px 24px;}.ac-seg{padding:5px 6px;}.ac-grid{gap:6px;}.ac-toolrow{gap:4px;}.ac-tool{padding:0 8px;font-size:11px;}}

/* 日间模式：只作用于右侧栏面板，不碰悬浮球和图片查看器 */
.ac-root.light{--ac-bg:#f5f6f8;--ac-bg2:#fff;--ac-card:#fff;--ac-raised:#eef1f5;--ac-line:#e1e5eb;--ac-line2:#cfd5de;--ac-text:#1c2027;--ac-text2:#3e4652;--ac-muted:#5f6875;--ac-dim:#7b8491;--ac-accent:#365b86;--ac-accent2:#244a73;--ac-ok:#2d7a50;--ac-warn:#8a6421;--ac-err:#a34040;background:var(--ac-bg);color:var(--ac-text);color-scheme:light;}
.ac-root.light ::selection{background:rgba(73,112,162,.24);}
.ac-root.light ::-webkit-scrollbar-thumb{background:#c5ccd6;border-color:transparent;}
.ac-root.light .ac-top{border-bottom-color:var(--ac-line);}
.ac-root.light .ac-logo{background:#fff;border-color:var(--ac-line2);color:#36404d;box-shadow:0 1px 2px rgba(20,30,50,.06);}
.ac-root.light .ac-title{color:#171b21;}
.ac-root.light .ac-sub{color:#5d6673;}
.ac-root.light .ac-segbtn:hover{background:#e9edf3;color:#171b21;}
.ac-root.light .ac-segbtn.on{background:#e6ebf2;border-color:#d5dce5;color:#171b21;}
.ac-root.light .ac-card{border-bottom-color:rgba(28,40,58,.1);}
.ac-root.light .ac-btn{background:#fff;border-color:#cfd5de;color:#232a33;box-shadow:0 1px 1px rgba(20,30,50,.03);}
.ac-root.light .ac-btn:hover{background:#eef1f5;border-color:#b9c1cc;}
.ac-root.light .ac-btn.primary{background:#35485d;border-color:#35485d;color:#fff;box-shadow:0 1px 3px rgba(30,48,70,.16);}
.ac-root.light .ac-btn.primary:hover{background:#2b3c4f;border-color:#2b3c4f;}
.ac-root.light .ac-btn.ghost{background:transparent;border-color:transparent;color:#4a5360;box-shadow:none;}
.ac-root.light .ac-btn.ghost:hover{background:#e9edf3;color:#171b21;}
.ac-root.light .ac-btn.danger{background:#fff5f5;border-color:#e6c7c7;color:#9c3f3f;}
.ac-root.light .ac-btn.danger:hover{background:#ffecec;}
.ac-root.light .ac-in,.ac-root.light .ac-ta,.ac-root.light .ac-sel{background:#fff;border-color:#cdd4de;color:#1c2027;}
.ac-root.light .ac-in::placeholder,.ac-root.light .ac-ta::placeholder{color:#9aa2ae;}
.ac-root.light .ac-in:focus,.ac-root.light .ac-ta:focus,.ac-root.light .ac-sel:focus{border-color:#7890ad;box-shadow:0 0 0 2px rgba(80,112,155,.13);}
.ac-root.light .ac-pill{background:#eef1f5;border-color:#d7dde6;color:#46505d;}
.ac-root.light .ac-pill.ok{background:#eaf6ef;border-color:#c3dfce;color:#2d6a46;}
.ac-root.light .ac-pill.warn{background:#fdf6e9;border-color:#ead7ad;color:#7b5a1e;}
.ac-root.light .ac-pill.err{background:#fff0f0;border-color:#eccaca;color:#963a3a;}
.ac-root.light .ac-pill.acc{background:#edf2f9;border-color:#d2dce9;color:#3c5572;}
.ac-root.light .ac-help{background:rgba(31,45,64,.035);border-color:#dde2e9;color:#68727f;}
.ac-root.light .ac-thumb{background:#eef1f5;border-color:#d5dbe4;}
.ac-root.light .ac-thumb.deleted{background:linear-gradient(135deg,#dfe3e9,#c9cfd8);}
.ac-root.light .ac-thumb .ac-thumbdeleted{color:#58606c;text-shadow:0 1px 1px rgba(255,255,255,.6);}
.ac-root.light .ac-cell{background:#fff;border-color:#dde2e9;}
.ac-root.light .ac-cell .ac-imgbox{background:#eef1f5;}
.ac-root.light .ac-cell .ac-meta .ac-t{color:#1c2027;}
.ac-root.light .ac-cell .ac-meta .ac-p{color:#4e5763;}
.ac-root.light .ac-setcard{background:#fff;border-color:#dde2e9;}
.ac-root.light .ac-step{background:#fff;border-color:#dde2e9;color:#6c7582;}
.ac-root.light .ac-step.on{background:#edf2f9;border-color:#c6d3e3;color:#35506f;}
.ac-root.light .ac-step.done{background:#eaf6ef;border-color:#c3dfce;color:#2d6a46;}
.ac-root.light .ac-log{background:#fff;border-color:#dde2e9;color:#424b57;}
.ac-root.light .ac-log .t{color:#929ba7;}
.ac-root.light .ac-log .lv-info{color:#48525f;}
.ac-root.light .ac-log .lv-warn{color:#7b5a1e;}
.ac-root.light .ac-log .lv-error{color:#963a3a;}
.ac-root.light .ac-empty{border-color:#cfd6e0;color:#7b8491;}
.ac-root.light .ac-basicrow{color:#4c5663;}
.ac-root.light .ac-basicrow:hover{background:rgba(31,45,64,.04);color:#171b21;}
.ac-root.light .ac-basicv{color:#1c2027;}
.ac-root.light .ac-basicgo,.ac-root.light .ac-basick,.ac-root.light .ac-basicarrow{color:#7b8491;}
.ac-root.light .ac-pathlink{border-bottom-color:#a9b3c1;color:#3f4a57;}
.ac-root.light .ac-pathlink:hover{color:#171b21;border-bottom-color:#5e6b7b;}
.ac-root.light .ac-in:disabled,.ac-root.light .ac-ta:disabled,.ac-root.light .ac-sel:disabled{background:#eef1f5;border-color:#d5dbe4;color:#8b94a0;}
.ac-root.light .ac-tab{background:#fff;border-color:#d8dee7;color:#4c5663;}
.ac-root.light .ac-tab.on{background:#e8edf4;border-color:#c2cfdf;color:#1c2027;}
.ac-root.light .ac-subtabs{background:#eef1f5;border-color:#dde2e9;}
.ac-root.light .ac-subtab{color:#4e5763;}
.ac-root.light .ac-subtab.on{background:#fff;color:#171b21;box-shadow:0 1px 2px rgba(20,30,50,.08);}
.ac-root.light .ac-wfitem{background:#fff;border-color:#dde2e9;}
.ac-root.light .ac-tokenlink{background:#eef3fa;border-color:#c8d4e3;color:#245b9e;}
.ac-root.light .ac-wfitem:hover{border-color:#c8d0db;}
.ac-root.light .ac-wfitem.on{background:#edf2f9;border-color:#b9c9dd;}
.ac-root.light .ac-node{background:#fff;border-color:#dde2e9;}
.ac-root.light .ac-code,.ac-root.light .ac-json{background:#f7f8fa;border-color:#dde2e9;color:#4b5562;}
.ac-root.light .ac-monolist{background:#fff;border-color:#dde2e9;}
.ac-root.light .ac-monorow:hover{background:#f1f4f8;}
.ac-root.light .ac-tablewrap{border-color:#dde2e9;}
.ac-root.light .ac-table th{color:#7b8491;background:#fff;}
.ac-root.light .ac-table tr:hover td{background:#f4f7fa;}
.ac-root.light .ac-lorarow input[type=number]{background:#fff;border-color:#cdd4de;color:#1c2027;}
.ac-root.light .ac-regenbox{background:rgba(255,255,255,.98);border-color:#d9dee7;box-shadow:0 10px 28px rgba(30,48,70,.18);}
.ac-root.light .ac-drag:hover{background:#e9edf3;color:#1c2027;}
.ac-root.light .ac-details{border-top-color:#e1e5eb;}
.ac-root.light .ac-details summary{color:#4c5663;}
.ac-root.light .ac-words .ac-word{background:#fff;border-color:#dde2e9;color:#4c5663;}
.ac-root.light .ac-word.on{background:#edf2f9;border-color:#c6d3e3;color:#35506f;}
.ac-root.light .ac-jobrow{border-bottom-color:#e7eaf0;}
.ac-root.fullimg .ac-fullhint{color:#e8ebf0;text-shadow:0 1px 3px rgba(0,0,0,.55);}
.ac-root.fullimg.light .ac-fullhint{color:#20242b;text-shadow:0 1px 2px rgba(255,255,255,.55);}
`;

      var styleInjected = false;
      function injectStyle() {
        if (styleInjected) return;
        try {
          var existing = document.getElementById("airp-comfy-style");
          if (existing) {
            try { existing.textContent = CSS; } catch (e) { /* ignore */ }
            styleInjected = true;
            return;
          }
          var st = document.createElement("style");
          st.id = "airp-comfy-style";
          st.textContent = CSS;
          document.head.appendChild(st);
          styleInjected = true;
        } catch (e) { /* ignore */ }
      }

      /* ===================================================================
       * 小部件
       * =================================================================== */
      function Btn(props) {
        var p = Object.assign({ type: "button" }, props);
        var className = cls("ac-btn", p.variant, p.small && "sm", p.icon && "icon", p.className);
        delete p.variant; delete p.small; delete p.icon; delete p.className;
        return h("button", Object.assign({}, p, { className: className }), props.children);
      }

      function Pill(props) {
        return h("span", { className: cls("ac-pill", props.tone), title: props.title || "" }, props.children);
      }

      function Card(props) {
        return h("section", { className: cls("ac-card", props.className) },
          props.title ? h("h2", null,
            props.title,
            props.actions ? h("span", { className: "ac-h2act" }, props.actions) : null,
            // 标题下面的小字 / 气泡：留在 h2 里，保证在标题区横线之上。
            props.subtitle ? h("span", { className: "ac-h2sub" }, props.subtitle) : null,
          ) : null,
          props.children);
      }

      function Field(props) {
        return h("div", { className: cls("ac-field", props.className) },
          props.label ? h("label", null, props.label) : null,
          props.children);
      }

      function TextInput(props) {
        var p = Object.assign({}, props, { type: "text", className: cls("ac-in", props.className) });
        return h("input", p);
      }

      function NumInput(props) {
        var p = Object.assign({}, props, { type: "number", className: cls("ac-in", props.className) });
        return h("input", p);
      }

      function TextArea(props) {
        var p = Object.assign({}, props, { className: cls("ac-ta", props.className) });
        return h("textarea", p);
      }

      function Select(props) {
        var p = Object.assign({}, props, { className: cls("ac-sel", props.className) });
        return h("select", p, props.children);
      }

      function Switch(props) {
        return h("label", { className: "ac-switch", title: props.title || "" },
          h("input", { type: "checkbox", checked: !!props.checked, onChange: props.onChange, disabled: props.disabled }),
          props.children);
      }

      function StatusDot(props) { return h("span", { className: cls("ac-dot", props.tone) }); }

      function KV(props) {
        var rows = props.rows || [];
        return h("div", { className: cls("ac-kv", props.className) },
          rows.map(function (r, i) {
            var value = r[1];
            var text = value === null || value === undefined ? "" : String(value);
            return [h("b", { key: "k" + i }, r[0]), h("span", { key: "v" + i, title: r[2] || text }, value === null || value === undefined ? "" : value)];
          }));
      }

      function Empty(props) { return h("div", { className: "ac-empty" }, props.children || "还没有内容"); }

      function Ico(props) {
        var paths = {
          home: "M3 11.5L12 4l9 7.5V21H3z",
          wand: "M4 20L15 9M14 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1z",
          image: "M3 5h18v14H3zM3 15l5-5 4 4 3-3 6 6",
          star: "M12 3l2.7 6.2 6.8.6-5.2 4.5 1.6 6.7L12 17.6 6.1 21l1.6-6.7L2.5 9.8l6.8-.6z",
          flow: "M5 6h6v4H5zM13 14h6v4h-6zM8 10v4h5",
          plug: "M8 3v5M16 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4",
          list: "M4 6h16M4 12h16M4 18h10",
          bars: "M4 6h16M4 12h16M4 18h16",
          gear: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2",
          play: "M8 5l11 7-11 7z",
          stop: "M6 6h12v12H6z",
          refresh: "M20 12a8 8 0 1 1-2.4-5.7M20 4v4h-4",
          trash: "M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14",
          dice: "M4 7h10v10H4zM14 4h6v6h-6z",
          layers: "M7 4h13v13H7zM4 7h13v13H4z",
          plus: "M12 5v14M5 12h14",
          down: "M12 4v13M6 11l6 6 6-6",
          download: "M12 3v12M7 10l5 5 5-5M4 21h16",
          close: "M6 6l12 12M18 6L6 18",
          copy: "M8 8h10v12H8zM6 16H4V4h12v2",
          folder: "M3 6h6l2 2h10v11H3z",
          check: "M4 12l5 5L20 6",
          chevL: "M14 6l-6 6 6 6",
          chevR: "M10 6l6 6-6 6",
          chevU: "M6 15l6-6 6 6",
          chevD: "M6 9l6 6 6-6",
          dots: "M5 12h.01M12 12h.01M19 12h.01",
          pencil: "M4 20l4.2-1.1L19.6 7.5a2.1 2.1 0 0 0-3-3L5.1 15.8 4 20zM14.8 6.3l3 3",
          expand: "M9 3H3v6M15 3h6v6M9 21H3v-6M21 15v6h-6",
          shrink: "M9 3v6H3M15 3v6h6M9 21v-6H3M21 15h-6v6",
          sidebarL: "M3 4h18v16H3zM9 4v16",
          sidebarR: "M3 4h18v16H3zM15 4v16",
          leftrail: "M3 4h18v16H3zM9 4v16M7 9l-2 3 2 3",
          square: "M3 3h18v18H3z",
          rounded: "M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z",
          pin: "M12 3l7 7-3 1-3 3v5l-2 2-2-2v-5l-3-3-1-1z",
          cursor: "M5 3l14 8-6 1.6L10.5 19z",
          bug: "M9 7a3 3 0 0 1 6 0v1h2v3h2v2h-2v5H7v-5H5v-2h2V8h2zM9 5L7 3M15 5l2-2M4 12h1M19 12h1M4 17l2-1M20 17l-2-1",
          sun: "M12 6.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4",
          moon: "M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z",
        };
        var d = paths[props.name] || paths.list;
        return h("svg", {
          className: "ac-ico", width: props.size || 15, height: props.size || 15,
          viewBox: "0 0 24 24", fill: props.fill ? "currentColor" : "none", stroke: "currentColor",
          strokeWidth: props.weight || 1.7, strokeLinecap: "round", strokeLinejoin: "round",
        }, h("path", { d: d }));
      }

      /* ===================================================================
       * 单页错误边界：某一页渲染炸了只显示错误，不拖死整个右侧栏
       * =================================================================== */
      var ReactComponent = React.Component || function () {};
      class PageBoundary extends ReactComponent {
        constructor(props) {
          super(props);
          this.props = props;
          this.state = { error: null };
        }
        static getDerivedStateFromError(error) {
          return { error: error };
        }
        componentDidCatch(error, info) {
          try { console.error("[airp-comfy] page error", error, info); } catch (e) { /* ignore */ }
        }
        render() {
          if (this.state.error) {
            return h("div", { className: "ac-empty" },
              "这一页渲染出错了：" + String((this.state.error && this.state.error.message) || this.state.error) + "。切到别的页再回来。",
            );
          }
          return this.props.children;
        }
      }

      /* ===================================================================
       * 悬浮球（shell.overlay）
       * =================================================================== */
      function normalizeFloatPrefs(input) {
        var out = input && typeof input === "object" ? input : {};
        // 自适应开关已删除；旧 localStorage 里残留的字段直接忽略。
        var adaptiveOff = out.adaptive === false;
        if (Object.prototype.hasOwnProperty.call(out, "adaptive")) delete out.adaptive;
        if (out.dock !== "left") out.dock = "";
        if (out.reserve !== "left") out.reserve = "";
        // 首次安装默认展开图片框；用户主动收起后会明确存成 false，继续尊重。
        out.open = out.open !== false;
        // 默认跟随会话滚动切图；旧配置没有这个字段。光标跟随是额外选项，默认关。
        out.follow = out.follow !== false;
        out.pointerFollow = out.pointerFollow === true;
        // 跟图调试：画出中线、当前区域和采样频率。首次安装默认关，只有明确开过才保留。
        out.debug = out.debug === true;
        // 两种“左侧让位”互斥：停靠会把图片框挪进左侧，留空只挪会话。
        if (out.reserve === "left") out.dock = "";
        if (out.dock === "left") out.reserve = "";
        var f = out.frame && typeof out.frame === "object" ? out.frame : null;
        if (f) {
          // emptyW/H = 没有图片时的框尺寸；图片尺寸不再覆盖它。
          // 旧版关过自适应的，框尺寸就是用户自己定的；开着自适应的按新默认 637×931。
          if (!(Number(f.emptyW) > 0)) {
            f.emptyW = adaptiveOff && Number(f.w) > 0 ? Number(f.w) : FLOAT_DEFAULT_W;
          }
          if (!(Number(f.emptyH) > 0)) {
            f.emptyH = adaptiveOff && Number(f.h) > 0 ? Number(f.h) : FLOAT_DEFAULT_H;
          }
          if (!(Number(f.dockW) > 0)) f.dockW = 0;
          if (!(Number(f.reserveW) > 0)) f.reserveW = 0;
        }
        return out;
      }
      function loadFloatPrefs() {
        try {
          var raw = localStorage.getItem(LS_KEY);
          if (raw) return normalizeFloatPrefs(JSON.parse(raw));
          // v3 换默认尺寸 637×931：只保留旧的球位置和置顶，丢弃旧框尺寸。
          var oldRaw = localStorage.getItem("airp-comfy:float:v2");
          if (oldRaw) {
            var old = JSON.parse(oldRaw) || {};
            return normalizeFloatPrefs({ ball: old.ball || null, pinned: old.pinned !== false, open: false });
          }
        } catch (e) { /* ignore */ }
        return normalizeFloatPrefs({});
      }
      function saveFloatPrefs(p) {
        try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ }
      }

      // 图片框 / 侧栏全屏共用的左下角菜单。两边只传各自的动作和禁用状态，
      // 结构、文案、顺序保持一致。
      function bubble(key, label, onClick, opts) {
        opts = opts || {};
        return h("button", {
          key: key,
          type: "button",
          className: cls("ac-bubble", opts.on && "on", opts.iconOnly && "ac-icononly"),
          disabled: !!opts.disabled,
          title: opts.title || label,
          ref: opts.ref || null,
          style: opts.bold ? { fontWeight: 700 } : null,
          "data-ui": "1",
          onClick: function (e) { e.stopPropagation(); if (!opts.disabled) onClick(); },
        },
          opts.icon ? h(Ico, { name: opts.icon, size: 14, fill: !!opts.filled }) : null,
          opts.strike
            ? h("span", { className: "ac-strike" }, label || "")
            : (label || null),
          opts.chev ? h("span", { className: "ac-bubchev" }, opts.chev) : null,
        );
      }

      function FrameTools(props) {
        var menuOpen = !!props.menuOpen;
        var subOpen = !!props.subOpen;
        return h("div", { ref: props.blRef, className: cls("ac-bl", props.show && "show"), "data-ui": "1" },
          h("button", {
            className: "ac-pencil ac-glass",
            type: "button",
            title: menuOpen ? "收起菜单" : "菜单",
            "data-ui": "1",
            onClick: function (e) {
              e.stopPropagation();
              props.onToggleMenu();
            },
          }, h(Ico, { name: "pencil", size: 15 })),
          menuOpen ? h("div", { ref: props.menuRef, className: cls("ac-bubblemenu", props.menuClipped && "clipped"), "data-ui": "1" },
            props.live
              ? bubble("stop", "终止", props.onStop)
              : bubble("capture", "请求生成", props.onCapture, { title: "发送正文，生成图片" }),
            bubble("regen", "重新生成", props.onToggleRegen, { disabled: props.live || !props.hasJob, on: props.regenOpen, title: "重新生成：仅此图 / 本轮全部" }),
            bubble("cont", props.contOn ? "连图·开" : "连图·关", props.onContinuous, { on: props.contOn }),
            bubble("auto", "A", props.onAuto, {
              title: props.autoOn
                ? "A：自动投递正文 + 自动出图都开"
                : "A（划掉）：不是全自动；点一下两项都开",
              strike: !props.autoOn,
              bold: true,
            }),
            bubble("trash", "", props.onDelete, { disabled: props.deleteDisabled, icon: "trash", title: props.deleteTitle || "删除" }),
            h("div", { key: "more", className: "ac-morewrap", "data-ui": "1" },
              bubble("morebtn", "", props.onToggleSub, { icon: "dots", title: "更多", on: subOpen, ref: props.moreRef }),
            ),
          ) : null,
          menuOpen && props.regenOpen
            ? h("div", { className: "ac-regenbox", "data-ui": "1" },
              h("div", { className: "ac-regentitle" }, "重新生成"),
              h(TextArea, {
                rows: 2,
                className: "ac-regeninput",
                value: props.regenText || "",
                placeholder: "可选要求（一次性，留空即可）：例如换一个动作 / 保留人物设定",
                onChange: function (e) { props.onRegenText(e.target.value); },
              }),
              h("div", { className: "ac-regenopt" },
                h(Btn, {
                  small: true, variant: "primary",
                  disabled: !props.hasImage || props.live,
                  onClick: props.onRegenSingle,
                }, "仅此图"),
                h("span", { className: "ac-hint" }, "只生成当前这张并替换，旧图进回收站；会自动发基础消息和【重新生成要求】。"),
              ),
              h("div", { className: "ac-regenopt" },
                h(Btn, {
                  small: true,
                  disabled: !props.hasJob || props.live,
                  onClick: props.onRegenAll,
                }, "全部"),
                h("span", { className: "ac-hint" }, "本轮全部图片一起替换，旧图进回收站；基础消息写明本轮全部张数。"),
              ),
            )
            : null,
          menuOpen && subOpen
            ? h("div", {
              className: "ac-bubble-sub", "data-ui": "1",
              style: props.subPos
                ? { left: props.subPos.left, bottom: props.subPos.bottom, visibility: "visible" }
                : { visibility: "hidden" },
            },
              bubble("fav", props.favorited ? "取消收藏" : "收藏", props.onFav, { disabled: props.favDisabled, icon: "star", filled: !!props.favorited, on: !!props.favorited, title: props.favorited ? "取消收藏" : "收藏" }),
              bubble("download", "下载", props.onDownload, { disabled: props.downloadDisabled, icon: "download", title: "下载图片" }),
              props.onToggleFollow ? bubble("follow", "滚动切图", props.onToggleFollow, { icon: "pin", on: !!props.followOn, filled: !!props.followOn, title: props.followOn ? "滚动切图：开" : "滚动切图：关" }) : null,
              props.onTogglePointer ? bubble("pointer", "光标切图", props.onTogglePointer, { icon: "cursor", on: !!props.pointerFollow, filled: !!props.pointerFollow, title: props.pointerFollow ? "光标切图：开" : "光标切图：关" }) : null,
              props.onToggleDebug ? bubble("debug", "切图调试", props.onToggleDebug, { icon: "bug", on: !!props.debug, filled: !!props.debug, title: props.debug ? "切图调试：开（画中线 / 区域 / 采样）" : "切图调试：关" }) : null,
              props.onClearAnchors ? bubble("clearanchors", "清空定位", props.onClearAnchors, { icon: "bars", title: "清空当前会话图片的原文锚点；之后按当前会话区域比例自动切图" }) : null,
              bubble("refresh", "刷新", props.onRefresh, { icon: "refresh", title: "刷新" }),
              bubble("square", props.square ? "切圆角" : "切直角", props.onToggleSquare, { icon: props.square ? "rounded" : "square", on: !!props.square, title: props.square ? "切换圆角" : "切换直角" }),
            )
            : null,
        );
      }

      function FloatBall() {
        var [prefs, setPrefs] = useState(loadFloatPrefs);
        var [hidden, setHidden] = useState(readFloatHidden);
        var [square, setSquare] = useState(readSquare);
        var [data, setData] = useState(null);
        var [toasts, setToasts] = useState([]);
        var [notices, setNotices] = useState([]);
        var [idx, setIdx] = useState(0);
        var [viewImg, setViewImg] = useState(null);
        var [viewSrc, setViewSrc] = useState("");
        var [fullOpen, setFullOpen] = useState(!!(rightViewMemory && rightViewMemory.open));
        var [followOffset, setFollowOffset] = useState(readFollowOffset);
        var [viewTick, setViewTick] = useState(0);
        var [switching, setSwitching] = useState(false);
        var [counterVisible, setCounterVisible] = useState(false);
        var [nearAny, setNearAny] = useState(false);
        var [nearBR, setNearBR] = useState(false);
        var [sideNav, setSideNav] = useState("");
        var [dockRect, setDockRect] = useState(null);
        var [railNear, setRailNear] = useState(false);
        var [railDragging, setRailDragging] = useState(false);
        var [railHint, setRailHint] = useState(false);
        var [menuOpen, setMenuOpen] = useState(false);
        var [subOpen, setSubOpen] = useState(false);
        var [regenOpen, setRegenOpen] = useState(false);
        var [regenText, setRegenText] = useState("");
        var [autoOn, setAutoOn] = useState(false);
        var [contOn, setContOn] = useState(false);
        var [followOn, setFollowOn] = useState(function () { return prefs.follow !== false; });
        var [pointerFollow, setPointerFollow] = useState(function () { return prefs.pointerFollow === true; });
        var [dragging, setDragging] = useState(false);
        // 单击图片框临时亮起所有菜单（四角按钮 + 铅笔菜单），到点自动收回。
        var [peek, setPeek] = useState(false);
        var [menuClipped, setMenuClipped] = useState(false);
        var [subPos, setSubPos] = useState(null);
        var [recycleBusy, setRecycleBusy] = useState(false);
        var frameRef = useRef(null);
        var imgRef = useRef(null);
        var blRef = useRef(null);
        var menuRef = useRef(null);
        var moreRef = useRef(null);
        // 单击亮菜单的计时器 / 是否处于亮菜单状态 / 这次按下是不是落在菜单按钮上。
        var peekRef = useRef(false);
        var peekTimer = useRef(null);
        var peekDelay = useRef(null);
        var uiDownRef = useRef(false);
        // 双指捏合：开始时的两指距离、中点、框尺寸都记下来，移动时按比例算绝对值，避免累积误差。
        var pinchRef = useRef({ active: false });
        var wheelTimer = useRef(null);
        var dockDrag = useRef(null);
        var reserveDrag = useRef(null);
        var reservePrevFrame = useRef(null);
        var railRectRef = useRef({ x: 0, y: 0, h: 0 });
        var railNearRef = useRef(false);
        var railHintTimer = useRef(null);
        var dockStateRef = useRef({ docked: false, dockW: 0, dockRect: null });
        var collapseRef = useRef(null);
        var dockTimer = useRef(null);
        var dockLeftHandlerRef = useRef(null);
        var reserveLeftHandlerRef = useRef(null);
        var toastTimers = useRef({});
        var toastSeq = useRef(0);
        var noticeTimers = useRef({});
        var noticeSeq = useRef(0);
        var jobNotices = useRef({});
        var recycleGuard = useRef(false);
        var blackTriedRef = useRef(new Set());
        var blackBusyRef = useRef(false);
        var blackRetryRef = useRef({});
        var blackCheckedJobsRef = useRef(new Set());
        var blackNotifiedRef = useRef(new Set());
        var BLACK_MAX_RETRIES = 3;
        var dragRef = useRef(null);
        var dragRaf = useRef(0);
        var dragPending = useRef(null);
        var suppressClick = useRef(null);
        var lastSessionId = useRef("");
        var localSessionRef = useRef({ sessionId: "", title: "" });
        var imgIdRef = useRef("");
        var fittedImgId = useRef("");
        var naturalSizeRef = useRef({ id: "", w: 0, h: 0 });
        var fitAnchorRef = useRef("");
        var dataSig = useRef("");
        var loadSeq = useRef(0);
        var pendingData = useRef(null);
        var pendingLoad = useRef(false);
        var pendingFit = useRef(null);
        var viewSeq = useRef(0);
        var pendingView = useRef(null);
        var counterTimer = useRef(null);
        var preferImgId = useRef("");
        // 重新生成 / 请求生成后，等新图进列表时自动跳到它。
        var pendingShowJobRef = useRef("");
        var pendingKeepImageRef = useRef(false);
        var jumpNewest = useRef(true);
        var prevImgIds = useRef([]);
        // 跟随滚动：句子锚点 + 本轮百分比回退。
        var followPauseKey = useRef("");
        var followTurnRef = useRef(null);
        var followCacheRef = useRef({ row: null, len: -1, text: "", segs: [] });
        var followMatchRef = useRef({ key: "", list: [] });
        var followGroupRef = useRef({ key: "", groups: [] });
        var pointerYRef = useRef(null);
        var pointerTimer = useRef(null);
        // 图片 id → 已经命中过的轮次；命中过的图不再在别的轮次按百分比重复出现。
        var followSeenRef = useRef({});
        // DOM 变化版本号：新消息 / 流式增量 / 折叠展开后，Range 和文本索引都要重算。
        var followRevision = useRef(0);
        var followTimer = useRef(null);
        var followTimerDue = useRef(0);
        var followNextAt = useRef(0);
        var followRaf = useRef(0);
        var pointerLastAt = useRef(0);
        var followObserver = useRef(null);
        // 调试面板直接写 DOM，避免每 70ms 触发一次整棵悬浮球重渲染。
        var followStatsRef = useRef({ samples: 0, switches: 0, lastAt: 0, lastGap: 0, gapSum: 0, lastReason: "" });
        var followLineRef = useRef(null);
        var followLineTagRef = useRef(null);
        var followLine2Ref = useRef(null);
        var followLine2TagRef = useRef(null);
        var followHudRef = useRef(null);
        // 手动偏移（px，负数 = 提前触发 / 蓝线在绿线上方）。用 ref 给高频采样读，state 只驱动滑块和蓝线。
        var followOffsetRef = useRef(followOffset);
        followOffsetRef.current = followOffset;
        var followOffsetDrag = useRef(false);
        var openRef = useRef(false);
        var hiddenRef = useRef(false);
        openRef.current = prefs.open;
        hiddenRef.current = hidden;

        var BALL = 46;
        var BALL_HALF = BALL / 2;
        var DEFAULT_W = FLOAT_DEFAULT_W;
        var DEFAULT_H = FLOAT_DEFAULT_H;
        var COLLAPSE = 26; // 右下收起按钮中心到边框的距离（11 边距 + 15 半径）
        var DOCK_MIN = 240;
        var DOCK_GAP = 1;
        var DOCK_MIN_CHAT = 640;
        var RESERVE_MIN = 260;
        var RESERVE_MIN_CHAT = 560;
        var RESERVE_MAX = 1400;
        var RESERVE_MIN_H = 320;

        var conversationBody = function () {
          try {
            // 新版 DSH 用 data-conversation-content；旧版社区 / Tavern 用
            // data-conversation-scroll 作为会话可滚动区域，两个都兼容。
            var nodes = document.querySelectorAll("[data-conversation-content], [data-conversation-scroll]");
            for (var i = 0; i < nodes.length; i += 1) {
              var el = nodes[i];
              if (!el || !el.getBoundingClientRect) continue;
              var r = el.getBoundingClientRect();
              if (r.width > 240 && r.height > 240) return el;
            }
          } catch (e) { /* ignore */ }
          return null;
        };
        var dockMaxWidth = function (body) {
          var rect = body && body.getBoundingClientRect ? body.getBoundingClientRect() : null;
          if (!rect) return 0;
          return Math.max(0, Math.min(920, rect.width - DOCK_MIN_CHAT - DOCK_GAP));
        };
        var defaultDockWidth = function (max) {
          return Math.max(DOCK_MIN, Math.min(420, Number(max) || DOCK_MIN));
        };
        var reserveMaxWidth = function (body) {
          var rect = body && body.getBoundingClientRect ? body.getBoundingClientRect() : null;
          if (!rect) return 0;
          return Math.max(0, Math.min(RESERVE_MAX, rect.width - RESERVE_MIN_CHAT - DOCK_GAP));
        };
        var defaultReserveWidth = function (max) {
          var want = Math.round((Number(max) || RESERVE_MIN) * 0.45);
          return Math.max(RESERVE_MIN, Math.min(720, want || RESERVE_MIN, Number(max) || RESERVE_MIN));
        };

        var vp = function () {
          return {
            w: (typeof window !== "undefined" && window.innerWidth) || 1440,
            h: (typeof window !== "undefined" && window.innerHeight) || 900,
          };
        };
        var setPref = function (patch) {
          setPrefs(function (old) {
            var next = Object.assign({}, old, patch);
            saveFloatPrefs(next);
            return next;
          });
        };
        var setBall = function (patch, persistNow) {
          setPrefs(function (old) {
            var next = Object.assign({}, old, { ball: Object.assign({}, old.ball || {}, patch) });
            if (persistNow !== false) saveFloatPrefs(next);
            return next;
          });
        };
        var setFrame = function (patch, persistNow) {
          setPrefs(function (old) {
            var next = Object.assign({}, old, { frame: Object.assign({}, old.frame || {}, patch) });
            if (persistNow !== false) saveFloatPrefs(next);
            return next;
          });
        };
        var persistPrefs = function () {
          setPrefs(function (old) { saveFloatPrefs(old); return old; });
        };

        /* ---------------------------------------------------------------
         * 单击图片框：把四角按钮和铅笔菜单一起亮出来，5 秒内框里没操作就收回。
         * 全部走 peekRef + 定时器，不依赖重渲染时序，所以连续点 / 拖 / 滚轮都不会串。
         * ------------------------------------------------------------- */
        var PEEK_MS = 5000;
        // 亮菜单稍微等一下：双击收框时不会被第一下点击先闪出一层菜单。
        var PEEK_DELAY_MS = 240;
        var clearPeekTimer = function () {
          if (peekTimer.current) { clearTimeout(peekTimer.current); peekTimer.current = null; }
          if (peekDelay.current) { clearTimeout(peekDelay.current); peekDelay.current = null; }
        };
        var endPeek = function () {
          clearPeekTimer();
          if (!peekRef.current) return;
          peekRef.current = false;
          setPeek(false);
          setMenuOpen(false);
          setSubOpen(false);
          setRegenOpen(false);
        };
        var bumpPeek = function () {
          if (!peekRef.current) return;
          clearPeekTimer();
          peekTimer.current = setTimeout(endPeek, PEEK_MS);
        };
        var startPeek = function () {
          if (peekRef.current) { bumpPeek(); return; }
          // 已经有一次点击在等：这是双击收框的前半截，直接撤掉，别让菜单闪一下。
          if (peekDelay.current) { clearPeekTimer(); return; }
          clearPeekTimer();
          peekDelay.current = setTimeout(function () {
            peekDelay.current = null;
            peekRef.current = true;
            setPeek(true);
            setMenuOpen(true);
            setSubOpen(false);
            setRegenOpen(false);
            bumpPeek();
          }, PEEK_DELAY_MS);
        };
        var showToast = function (text, tone) {
          var id = (toastSeq.current += 1);
          setToasts(function (old) {
            return old.concat([{ id: id, text: String(text), tone: tone || "" }]).slice(-4);
          });
          toastTimers.current[id] = setTimeout(function () {
            delete toastTimers.current[id];
            setToasts(function (old) { return old.filter(function (t) { return t.id !== id; }); });
          }, 2100);
        };
        var flashRailHint = function () {
          setRailHint(true);
          if (railHintTimer.current) clearTimeout(railHintTimer.current);
          railHintTimer.current = setTimeout(function () {
            railHintTimer.current = null;
            setRailHint(false);
          }, 1800);
        };
        // 右下角全局消息：即使面板没开、图片框收着，也能看到「收到提示词 / 出图完成」。
        var notify = function (text, tone) {
          var id = (noticeSeq.current += 1);
          setNotices(function (old) {
            return old.concat([{ id: id, text: String(text), tone: tone || "" }]).slice(-3);
          });
          noticeTimers.current[id] = setTimeout(function () {
            delete noticeTimers.current[id];
            setNotices(function (old) { return old.filter(function (t) { return t.id !== id; }); });
          }, 4200);
        };

        var stateSignature = function (s) {
          var j = s && s.jobs && s.jobs[0] ? s.jobs[0] : null;
          var rows = s && Array.isArray(s.images) && s.images.length
            ? s.images
            : (j && Array.isArray(j.images) ? j.images : []);
          var cap = s && s.config && s.config.capture ? s.config.capture : {};
          var src = s && s.capture && s.capture.source ? s.capture.source : {};
          return [
            s && s.activeSessionId,
            j && j.id,
            j && j.status,
            j && j.imageCount,
            rows.map(function (x) { return x.id + ":" + (x.favorited ? 1 : 0) + ":" + (x.recycled ? 1 : 0) + ":" + (x.url || ""); }).join(","),
            cap.autoForward, cap.autoGenerate,
            src.followActive, src.sessionId, src.title,
            s && s.config && s.config.generation && s.config.generation.continuous
              ? (s.config.generation.continuous.on ? 1 : 0) : 0,
          ].join("|");
        };
        var load = function (force) {
          // 拖动中完全不去请求 / 重算整帧；松手后补一次，长对话 / 多图时也不会边拖边卡。
          if (dragRef.current && !force) {
            pendingLoad.current = true;
            return Promise.resolve(null);
          }
          var seq = (loadSeq.current += 1);
          return api.stateC().then(function (s) {
            var sig = stateSignature(s);
            if (!force && sig === dataSig.current) return s;
            // 会话切换 / 连续刷新时只让最后一次请求落地，避免慢的旧响应把新会话盖回去。
            if (loadSeq.current !== seq) return s;
            dataSig.current = sig;
            // 拖动中先不换数据：部分会话生图/SSE 刷新频繁，整棵树重渲染会让拖动闪。
            if (dragRef.current) {
              pendingData.current = s;
              return s;
            }
            setData(s);
            return s;
          }).catch(function () { /* 宿主还没准备好 */ });
        };

        useEffect(function () {
          var onSession = function (ev) {
            var sid = ev && ev.detail && ev.detail.sessionId ? String(ev.detail.sessionId) : "";
            if (!sid) return;
            localSessionRef.current = { sessionId: sid, title: String(ev.detail.title || "") };
            var changed = sid !== lastSessionId.current;
            lastSessionId.current = sid;
            if (changed) {
              jumpNewest.current = true;
              imgIdRef.current = "";
              fittedImgId.current = "";
              setSwitching(false);
              setViewImg(null);
              setViewSrc("");
              setIdx(0);
            }
            dataSig.current = "";
            load(true).catch(function () { /* ignore */ });
          };
          try {
            if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
              window.addEventListener(SESSION_EVENT, onSession);
            }
          } catch (e) { /* ignore */ }
          return function () {
            try {
              if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
                window.removeEventListener(SESSION_EVENT, onSession);
              }
            } catch (e) { /* ignore */ }
          };
        }, []);

        // 直接吃 job SSE，不经过「当前会话」过滤：自动流程跑到别的会话时也能收到。
        var noticeJob = function (job) {
          if (!job || !job.id) return;
          var rec = jobNotices.current[job.id];
          if (!rec) {
            rec = { prompt: false, done: false, failed: false };
            jobNotices.current[job.id] = rec;
            var keys = Object.keys(jobNotices.current);
            if (keys.length > 120) { try { delete jobNotices.current[keys[0]]; } catch (e) { /* ignore */ } }
          }
          var sets = Array.isArray(job.sets) ? job.sets : [];
          if (!rec.prompt && sets.length && job.promptSource && job.promptSource !== "manual") {
            rec.prompt = true;
            var first = sets[0] && sets[0].title ? String(sets[0].title).slice(0, 28) : "";
            notify("已收到 " + sets.length + " 套提示词" + (first ? " · " + first : ""), "ok");
          }
          if (!rec.done && job.status === "done") {
            rec.done = true;
            // 黑图自动补图是内部原地替换，先不报「出图完成」：
            // 等替换后的图确认正常，再把「出图完成」作为最后一条提示。
            if (job.regenMode !== "auto") {
              var n = Array.isArray(job.images) ? job.images.length : (Number(job.imageCount) || 0);
              var sec = Number(job.comfyMs) > 0 ? (Number(job.comfyMs) / 1000).toFixed(1) : "";
              notify("出图完成" + (n ? " · " + n + " 张" : "") + (sec ? " · " + sec + "s" : ""), "ok");
            }
          }
          if (!rec.failed && job.status === "error") {
            rec.failed = true;
            var why = String(job.error || "").replace(/\s+/g, " ").slice(0, 80);
            notify("出图失败" + (why ? "：" + why : ""), "err");
          }
        };

        useEffect(function () {
          var alive = true;
          var timer = null;
          var es = null;
          var fallback = null;
          var schedule = function () {
            if (timer) clearTimeout(timer);
            timer = setTimeout(function () { if (alive) load(); }, 240);
          };
          var stopFallback = function () {
            if (fallback) { clearInterval(fallback); fallback = null; }
          };
          var startFallback = function () {
            if (fallback || !alive) return;
            fallback = setInterval(function () { if (alive) load(); }, 15000);
          };
          load();
          try {
            es = new EventSource(API + "/events");
            es.addEventListener("job", function (ev) {
              schedule();
              try { noticeJob(JSON.parse(ev.data)); } catch (e) { /* ignore */ }
            });
            ["image", "state", "active-session"].forEach(function (name) {
              es.addEventListener(name, schedule);
            });
            es.onopen = stopFallback;
            es.onerror = startFallback;
          } catch (e) {
            startFallback();
          }
          return function () {
            alive = false;
            if (timer) clearTimeout(timer);
            stopFallback();
            try { if (es) es.close(); } catch (e) { /* ignore */ }
            Object.keys(toastTimers.current).forEach(function (id) { clearTimeout(toastTimers.current[id]); });
            toastTimers.current = {};
            Object.keys(noticeTimers.current).forEach(function (id) { clearTimeout(noticeTimers.current[id]); });
            noticeTimers.current = {};
            if (counterTimer.current) clearTimeout(counterTimer.current);
            if (railHintTimer.current) { clearTimeout(railHintTimer.current); railHintTimer.current = null; }
            if (dragRaf.current) { try { caf(dragRaf.current); } catch (e) { /* ignore */ } dragRaf.current = 0; }
            if (wheelTimer.current) clearTimeout(wheelTimer.current);
          };
        }, []);

        // 图库 / 全屏 / 图片框任一处删除图片，都让悬浮框立刻重拉一次状态，
        // 不依赖 SSE 是否正好在线。
        useEffect(function () {
          var onImageChanged = function () {
            dataSig.current = "";
            load(true).catch(function () { /* ignore */ });
          };
          try {
            if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
              window.addEventListener(IMAGE_EVENT, onImageChanged);
            }
          } catch (e) { /* ignore */ }
          return function () {
            try {
              if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
                window.removeEventListener(IMAGE_EVENT, onImageChanged);
              }
            } catch (e) { /* ignore */ }
          };
        }, []);

        useEffect(function () {
          var onVisibility = function (ev) {
            setHidden(!!(ev && ev.detail && ev.detail.hidden));
          };
          try {
            if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
              window.addEventListener(FLOAT_VIS_EVENT, onVisibility);
            }
          } catch (e) { /* ignore */ }
          return function () {
            try {
              if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
                window.removeEventListener(FLOAT_VIS_EVENT, onVisibility);
              }
            } catch (e) { /* ignore */ }
          };
        }, []);

        var jobList = data && Array.isArray(data.jobs) ? data.jobs : [];
        var visibleJobs = jobList.filter(function (j) { return j && !j.internal; });
        var job = visibleJobs[0] || jobList[0] || null;
        var imgs = [];
        // state 是「当前会话、新→旧」；图片框内部统一按「旧→新」显示，
        // 最新一张在最后，页码从第一张 1/xx 开始。
        // ★ 图库删除后 state 列表会先少一张，但 job.images 兜底里可能还留着
        //   已删除记录；这里必须再过滤一次，图片框绝不能显示回收站里的图。
        var picRows = [];
        if (data && Array.isArray(data.images) && data.images.length) picRows = data.images.slice().reverse();
        else if (job && job.images && job.images.length) picRows = job.images.slice();
        imgs = picRows.filter(function (x) { return x && !x.recycled && !x.deletedAt; });
        var safeIdx = Math.max(0, Math.min(imgs.length - 1, idx));
        var img = imgs[safeIdx] || null;
        var view = viewImg;
        var viewSynced = !!(view && img && String(view.id) === String(img.id));
        // 记录悬浮框最后显示的图：右侧栏顶部无参「全屏看图」要用它作为起点。
        useEffect(function () {
          var shown = view || img || null;
          if (shown && shown.id) lastFrameView = shown;
        }, [view && view.id, view && view.url, img && img.id, img && img.url]);
        // 黑图补图是 internal 任务，不在 visibleJobs 里，所以「有没有在跑」要单看这个计数：
        // 补图进行中也要能把菜单里的「请求生成」换成「终止」。
        var blackActive = useBlackPending() > 0;
        var live = blackActive || !!(job && (job.status === "delivering" || job.status === "parsing" || job.status === "running" || job.status === "queued"));
        // anchor / turn 也进 key：旧图回填锚点后 id 不变，但跟随逻辑必须重建，
        // 否则监听器里还是“没有锚点”的旧 imgs。
        var imgKey = imgs.map(function (x) {
          // url 里带原地替换的 ?v=updatedAt；同一 id 换图时也要重建跟图 / 清掉待选任务。
          return String(x.id || "") + ":" + (x.anchor ? "a" : "") + ":"
            + (x.turn === null || x.turn === undefined ? "" : x.turn) + ":" + String(x.url || "");
        }).join("|");

        // 右侧栏全屏手动翻页 / 打开时，把当前图同步回悬浮框的跟图状态；
        // 这样退出全屏、调试 HUD、自动切图都不会停在另一张。
        useEffect(function () {
          var onFullNav = function (ev) {
            var d = ev && ev.detail ? ev.detail : {};
            var id = String(d.imageId || "");
            if (!id) return;
            var at = -1;
            for (var i = 0; i < imgs.length; i += 1) {
              if (String(imgs[i].id || "") === id) { at = i; break; }
            }
            if (at < 0) return;
            if (d.pause && (followOn || pointerFollow)) followPause();
            jumpNewest.current = false;
            imgIdRef.current = id;
            setIdx(at);
          };
          try {
            if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
              window.addEventListener(FULL_NAV_EVENT, onFullNav);
            }
          } catch (e) { /* ignore */ }
          return function () {
            try {
              if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
                window.removeEventListener(FULL_NAV_EVENT, onFullNav);
              }
            } catch (e) { /* ignore */ }
          };
        }, [imgKey, followOn, pointerFollow]);

        // 右侧栏全屏即使悬浮框收着，也要让跟图采样 / 调试层继续工作。
        useEffect(function () {
          var onFullState = function (ev) {
            setFullOpen(!!(ev && ev.detail && ev.detail.open));
          };
          try {
            if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
              window.addEventListener(FULL_STATE_EVENT, onFullState);
            }
          } catch (e) { /* ignore */ }
          return function () {
            try {
              if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
                window.removeEventListener(FULL_STATE_EVENT, onFullState);
              }
            } catch (e) { /* ignore */ }
          };
        }, []);
        // 每轮出图完成后最后再顺手查一次纯黑图；同一条提示词最多自动补 3 次。
        // 不只盯 jobs[0]：几张黑图会并行补图，完成顺序不一定等于创建顺序。
        var jobsSig = (data && Array.isArray(data.jobs) ? data.jobs : []).map(function (j) {
          return String(j.id || "") + ":" + String(j.status || "") + ":"
            + (j.images || []).map(function (x) { return String(x.id || "") + (x.recycled ? "r" : ""); }).join(",");
        }).join("|");
        useEffect(function () {
          var list = data && Array.isArray(data.jobs) ? data.jobs : [];
          for (var i = 0; i < list.length; i += 1) checkBlackImages(list[i]);
        }, [jobsSig]);

        /* ---------------------- 跟随滚动：原文锚点 / 百分比回退 ---------------------- */
        // 归一化只做“不影响语义”的字符级处理：空白、零宽、中英标点、大小写。
        // 绝不做整句改写，避免把不同句子匹配到一起。
        var followNormChar = function (ch) {
          if (!ch) return "";
          if (/\s/.test(ch)) return "";
          var code = ch.charCodeAt(0);
          if ((code >= 0x200b && code <= 0x200f) || code === 0xfeff) return "";
          if (ch >= "A" && ch <= "Z") return ch.toLowerCase();
          var map = {
            "，": ",", "、": ",", "。": ".", "！": "!", "？": "?", "；": ";", "：": ":",
            "“": "\"", "”": "\"", "‘": "'", "’": "'", "—": "-", "–": "-", "…": ".",
          };
          return map[ch] || ch;
        };
        var followNorm = function (text) {
          var s = String(text || "");
          var out = "";
          for (var i = 0; i < s.length; i += 1) out += followNormChar(s.charAt(i));
          return out;
        };

        var followScroller = function () {
          try {
            var nodes = document.querySelectorAll("[data-conversation-scroll]");
            var best = null;
            var bestArea = 0;
            for (var i = 0; i < nodes.length; i += 1) {
              var r = nodes[i] && nodes[i].getBoundingClientRect ? nodes[i].getBoundingClientRect() : null;
              if (!r || r.width < 240 || r.height < 240) continue;
              var area = r.width * r.height;
              if (area > bestArea) { best = nodes[i]; bestArea = area; }
            }
            if (best) return best;
          } catch (e) { /* ignore */ }
          return conversationBody();
        };

        // 找 DSH 的轮次行：优先 flow 的直接子节点，失败再退到所有 data-chat-turn。
        var followRows = function (host) {
          var rows = [];
          try {
            var flow = host.querySelector('[data-slot="conversation.chat.flow"]');
            var parent = flow || host;
            var kids = parent.children || [];
            for (var i = 0; i < kids.length; i += 1) {
              var el = kids[i];
              if (!el || !el.getAttribute || el.getAttribute("data-chat-turn") === null) continue;
              var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
              if (r && r.height > 0) rows.push(el);
            }
          } catch (e) { /* ignore */ }
          if (rows.length) return rows;
          try {
            var all = host.querySelectorAll("[data-chat-turn]");
            for (var j = 0; j < all.length; j += 1) {
              var el2 = all[j];
              var r2 = el2.getBoundingClientRect ? el2.getBoundingClientRect() : null;
              if (r2 && r2.height > 0) rows.push(el2);
            }
          } catch (e2) { /* ignore */ }
          return rows;
        };

        var followReadTurn = function (baselineY) {
          var host = followScroller();
          if (!host || !host.getBoundingClientRect) return null;
          var rect = host.getBoundingClientRect();
          if (!rect || rect.height <= 0) return null;
          var rows = followRows(host);
          if (!rows.length) return null;
          // 基线 = 会话可视区中线；指针跟随时用指针的 clientY（夹在会话区内）。
          var lineY = Number(baselineY);
          if (!isFinite(lineY)) lineY = rect.top + rect.height * 0.5;
          lineY = Math.max(rect.top, Math.min(rect.bottom, lineY));
          var lo = 0;
          var hi = rows.length;
          while (lo < hi) {
            var mid = (lo + hi) >> 1;
            var top = rows[mid].getBoundingClientRect().top;
            if (top <= lineY) lo = mid + 1; else hi = mid;
          }
          var at = Math.max(0, Math.min(rows.length - 1, lo - 1));
          var row = rows[at];
          var turn = Number(row.getAttribute("data-chat-turn"));
          if (!isFinite(turn)) return null;
          // 同一轮在 DSH 里可能拆成多行（user / assistant / tool），要按 turn 收齐，
          // 否则阅读线停在用户消息上时搜不到助手回复里的原文。
          var turnRows = [];
          for (var t = 0; t < rows.length; t += 1) {
            if (Number(rows[t].getAttribute("data-chat-turn")) === turn) turnRows.push(rows[t]);
          }
          var lastRow = rows[rows.length - 1];
          var lastTurn = Number(lastRow.getAttribute("data-chat-turn"));
          var atBottom = false;
          try {
            atBottom = host.scrollHeight - host.scrollTop - host.clientHeight <= 24;
          } catch (e) { atBottom = false; }
          return {
            host: host, row: row, rows: turnRows.length ? turnRows : [row],
            allRows: rows,
            turn: turn, lastTurn: isFinite(lastTurn) ? lastTurn : turn,
            lineY: lineY, top: rect.top, height: rect.height, atBottom: atBottom,
          };
        };

        /** 这一轮（可能多行）的“助手正文块”，用于百分比回退；找不到就用整轮各行并集。 */
        var followAnswerBlock = function (rows) {
          var list = Array.isArray(rows) ? rows : [rows];
          var min = Infinity;
          var max = -Infinity;
          for (var i = 0; i < list.length; i += 1) {
            var row = list[i];
            if (!row || !row.getBoundingClientRect) continue;
            var rowRect = row.getBoundingClientRect();
            if (rowRect.height <= 0) continue;
            if (rowRect.top < min) min = rowRect.top;
            if (rowRect.bottom > max) max = rowRect.bottom;
            try {
              var sel = '[data-chat-flow-kind="assistant-step"], [data-turn-process-answer]';
              var nodes = [];
              // 流式行本身可能就是 assistant-step，querySelectorAll 不会包含自己。
              if (row.matches && row.matches(sel)) nodes.push(row);
              var found = row.querySelectorAll(sel);
              for (var f = 0; f < found.length; f += 1) nodes.push(found[f]);
              var amin = Infinity;
              var amax = -Infinity;
              for (var n = 0; n < nodes.length; n += 1) {
                var r = nodes[n].getBoundingClientRect ? nodes[n].getBoundingClientRect() : null;
                if (!r || r.height <= 0) continue;
                if (r.top < amin) amin = r.top;
                if (r.bottom > amax) amax = r.bottom;
              }
              if (amax > amin) { if (amin < min) min = amin; if (amax > max) max = amax; }
            } catch (e) { /* ignore */ }
          }
          if (max > min) return { top: min, bottom: max };
          return { top: 0, bottom: 1 };
        };

        /** 把一轮（可能多行）里的可见文本节点连成一份归一化索引，并保留“位置 → 文本节点 / 原始偏移”的映射。 */
        var followBuildIndex = function (rows, cacheKey) {
          var list = Array.isArray(rows) ? rows : [rows];
          var len = 0;
          for (var a = 0; a < list.length; a += 1) {
            try { len += list[a].textContent ? list[a].textContent.length : 0; } catch (e) { /* ignore */ }
          }
          var key = String(cacheKey || "") + "|" + list.length + "|" + len + "|" + followRevision.current;
          var cache = followCacheRef.current;
          if (cache && cache.key === key) return cache;
          var text = "";
          var segs = [];
          for (var b = 0; b < list.length; b += 1) {
            try {
              if (typeof document.createTreeWalker !== "function") continue;
              var walker = document.createTreeWalker(list[b], 4, null);
              var node;
              while ((node = walker.nextNode())) {
                var raw = String(node.nodeValue || "");
                if (!raw || !raw.trim()) continue;
                var pe = node.parentElement;
                if (!pe) continue;
                var skip = null;
                try {
                  skip = pe.closest('script,style,[hidden],[data-chat-flow-kind="turn-process"],[data-turn-process-body],[data-chat-flow-kind="tool-call"],[data-chat-group-part="reasoning"],[data-chat-group-part="process"],[data-turn-process-hidden]');
                } catch (e2) { skip = null; }
                if (skip) continue;
                var norm = "";
                var map = [];
                for (var i = 0; i < raw.length; i += 1) {
                  var ch = followNormChar(raw.charAt(i));
                  if (!ch) continue;
                  norm += ch;
                  map.push(i);
                }
                if (!norm) continue;
                segs.push({ node: node, start: text.length, norm: norm, map: map });
                text += norm;
              }
            } catch (e3) { /* ignore */ }
          }
          cache = { key: key, rows: list, len: len, text: text, segs: segs };
          followCacheRef.current = cache;
          return cache;
        };

        var followSegmentAt = function (segs, pos) {
          var lo = 0;
          var hi = segs.length - 1;
          var ans = null;
          while (lo <= hi) {
            var mid = (lo + hi) >> 1;
            if (segs[mid].start <= pos) { ans = segs[mid]; lo = mid + 1; } else hi = mid - 1;
          }
          return ans;
        };

        var followRangeAt = function (index, pos, len) {
          if (!index || !index.segs || !index.segs.length || len <= 0) return null;
          var startSeg = followSegmentAt(index.segs, pos);
          var endSeg = followSegmentAt(index.segs, pos + len - 1);
          if (!startSeg || !endSeg) return null;
          var so = pos - startSeg.start;
          var eo = pos + len - 1 - endSeg.start;
          if (so < 0 || so >= startSeg.map.length || eo < 0 || eo >= endSeg.map.length) return null;
          try {
            var range = document.createRange();
            range.setStart(startSeg.node, startSeg.map[so]);
            range.setEnd(endSeg.node, endSeg.map[eo] + 1);
            return range;
          } catch (e) { return null; }
        };

        var followFindInRow = function (rows, anchor, turnHint) {
          var needle = followNorm(anchor);
          if (needle.length < 4) return null;
          var index = followBuildIndex(rows, turnHint);
          if (!index || !index.text) return null;
          var pos = index.text.indexOf(needle);
          var tries = 0;
          while (pos >= 0 && tries < 12) {
            var range = followRangeAt(index, pos, needle.length);
            if (range) {
              var top = Infinity;
              var bottom = -Infinity;
              // 最后一行文字的中心：用它当插入点，线会落在字上，而不是
              // 落在字下面那截行距（用户看到的就是“字在线上面一点点”）。
              var lineTop = 0;
              var lineBottom = 0;
              try {
                var rects = range.getClientRects ? range.getClientRects() : [];
                for (var i = 0; i < rects.length; i += 1) {
                  var rr = rects[i];
                  // 过滤零宽 rect：段尾 / 换行处浏览器可能给一个宽 0 的
                  // caret 框，它的 bottom 会落到下一行，导致插入点整体晚一行。
                  if (!rr || rr.height <= 0 || rr.width <= 0.5) continue;
                  if (rr.top < top) top = rr.top;
                  if (rr.bottom > bottom) {
                    bottom = rr.bottom;
                    lineTop = rr.top;
                    lineBottom = rr.bottom;
                  }
                }
              } catch (e) { top = Infinity; bottom = -Infinity; }
              if (bottom > top) {
                var pe = range.startContainer && range.startContainer.parentElement;
                var tr = pe && pe.closest ? pe.closest("[data-chat-turn]") : null;
                var turn = tr ? Number(tr.getAttribute("data-chat-turn")) : turnHint;
                var point = lineTop + (lineBottom - lineTop) * 0.5;
                if (isFinite(turn)) return { range: range, turn: turn, top: top, bottom: bottom, point: point };
              }
            }
            pos = index.text.indexOf(needle, pos + 1);
            tries += 1;
          }
          return null;
        };

        /** 当前轮里所有能命中的图片；按句子在屏幕上的位置排序。 */
        var followMatched = function (turn, rows) {
          var listRows = Array.isArray(rows) ? rows : [rows];
          var len = 0;
          for (var a = 0; a < listRows.length; a += 1) {
            try { len += listRows[a].textContent ? listRows[a].textContent.length : 0; } catch (e) { /* ignore */ }
          }
          var key = turn + "|" + imgKey + "|" + listRows.length + "|" + len + "|" + followRevision.current;
          if (followMatchRef.current && followMatchRef.current.key === key) return followMatchRef.current.list;
          var list = [];
          for (var i = 0; i < imgs.length; i += 1) {
            var im = imgs[i];
            if (!im || !im.anchor) continue;
            var hit = followFindInRow(listRows, im.anchor, turn);
            if (!hit || hit.turn !== turn) continue;
            followSeenRef.current[im.id] = turn;
            list.push({ im: im, index: i, range: hit.range, y: hit.top });
          }
          list.sort(function (a, b) {
            if (Math.abs(a.y - b.y) > 1) return a.y - b.y;
            var av = a.im.setIndex === null || a.im.setIndex === undefined ? 999 : Number(a.im.setIndex);
            var bv = b.im.setIndex === null || b.im.setIndex === undefined ? 999 : Number(b.im.setIndex);
            return av - bv;
          });
          followMatchRef.current = { key: key, list: list };
          return list;
        };

        /** 一句都匹配不到：当前轮有 turn 的图按“助手正文块”高度等分。 */
        var followPercentTarget = function (read) {
          var fallback = [];
          for (var i = 0; i < imgs.length; i += 1) {
            var im = imgs[i];
            if (!im || im.turn === null || im.turn === undefined || im.turn === '') continue;
            if (!isFinite(Number(im.turn)) || Number(im.turn) !== Number(read.turn)) continue;
            // 这句话已经在别处命中过：跟着原句走，不在提示词轮次里再按百分比出现。
            if (followSeenRef.current[im.id] !== undefined && followSeenRef.current[im.id] !== read.turn) continue;
            fallback.push({ im: im, index: i });
          }
          if (!fallback.length) {
            // 旧图既没有锚点也没有 turn：至少让最新一轮能按“最近一次出图的
            // 3 张图”等分切换，而不是整轮卡在最新一张；旧轮次仍然不乱猜。
            if (read.turn === read.lastTurn) {
              var recent = [];
              var latestJobId = job && job.id ? String(job.id) : "";
              for (var ri = 0; ri < imgs.length; ri += 1) {
                var rim = imgs[ri];
                if (!rim) continue;
                if (latestJobId && String(rim.jobId || "") === latestJobId
                  && (rim.turn === null || rim.turn === undefined || rim.turn === '')) {
                  recent.push({ im: rim, index: ri });
                }
              }
              if (!recent.length && !imgs.some(function (x) { return x.anchor; })
                && !imgs.some(function (x) { return x.turn !== null && x.turn !== undefined && x.turn !== ''; })) {
                recent = imgs.slice(-Math.min(3, imgs.length)).map(function (im, offset, list) {
                  return { im: im, index: imgs.length - list.length + offset };
                });
              }
              if (recent.length) {
                recent.sort(function (a, b) {
                  var av = a.im.setIndex === null || a.im.setIndex === undefined ? 999 : Number(a.im.setIndex);
                  var bv = b.im.setIndex === null || b.im.setIndex === undefined ? 999 : Number(b.im.setIndex);
                  if (av !== bv) return av - bv;
                  return a.index - b.index;
                });
                var recentBlock = followAnswerBlock(read.rows);
                var recentHeight = Math.max(1, recentBlock.bottom - recentBlock.top);
                var recentP = Math.max(0, Math.min(0.999, ((read.triggerY !== undefined ? read.triggerY : read.lineY) - recentBlock.top) / recentHeight));
                var recentBucket = Math.min(recent.length - 1, Math.floor(recentP * recent.length));
                var recentItem = recent[recentBucket];
                return {
                  turn: read.turn, region: "p" + recentBucket, index: recentItem.index,
                  id: recentItem.im.id, reason: "percent",
                };
              }
              if (imgs.length && !imgs.some(function (x) { return x.anchor; })) {
                var lastIndex = imgs.length - 1;
                return { turn: read.turn, region: "latest", index: lastIndex, id: imgs[lastIndex].id, reason: "latest" };
              }
            }
            return null;
          }
          fallback.sort(function (a, b) {
            var av = a.im.setIndex === null || a.im.setIndex === undefined ? 999 : Number(a.im.setIndex);
            var bv = b.im.setIndex === null || b.im.setIndex === undefined ? 999 : Number(b.im.setIndex);
            if (av !== bv) return av - bv;
            return a.index - b.index;
          });
          var block = followAnswerBlock(read.rows);
          var height = Math.max(1, block.bottom - block.top);
          var p = Math.max(0, Math.min(0.999, ((read.triggerY !== undefined ? read.triggerY : read.lineY) - block.top) / height));
          var bucket = Math.min(fallback.length - 1, Math.floor(p * fallback.length));
          var item = fallback[bucket];
          return { turn: read.turn, region: "p" + bucket, index: item.index, id: item.im.id, reason: "percent" };
        };

        var isContinuousImage = function (im) {
          if (!im) return false;
          var shot = im.continuousShot;
          if (shot && Number(shot.total) > 1) return true;
          // 旧记录没有 continuousShot 字段时，用标题里的「连续 1/3」兜底。
          return /连续\s*\d+\s*\/\s*\d+/.test(String(im.title || ""));
        };

        /**
         * 把每张图的“原文锚点”当成场面结束的插入点：最后一行文字中心越过中线
         * = 这一幕结束（用中心而不是行框底部，线才会落在字上）。
         * 同一句对应多张连续图时，把上一场结束到这一句之间的段落按张数等分，
         * 让每一张都有自己的滚动位置；段落太短时仍然滚到底切最后一张。
         */
        var followAnchorGroups = function (read) {
          var rows = read.allRows || read.rows || [];
          var len = 0;
          for (var a = 0; a < rows.length; a += 1) {
            try { len += rows[a].textContent ? rows[a].textContent.length : 0; } catch (e) { /* ignore */ }
          }
          var key = "g|" + imgKey + "|" + followRevision.current + "|" + rows.length + "|" + len
            // 会话区在视口里的位置 / 宽度变了（DSH 顶部菜单栏、侧边栏收放、Tavern 全屏），
            // 缓存的 yDoc 也必须重建；否则会一直用旧布局的偏移量。
            + "|" + Math.round(Number(read.top) || 0) + "|" + Math.round(Number(read.height) || 0)
            + "|" + Math.round((read.host && read.host.clientWidth) || 0);
          if (followGroupRef.current && followGroupRef.current.key === key) return followGroupRef.current.groups;
          var groups = [];
          var byKey = {};
          for (var i = 0; i < imgs.length; i += 1) {
            var im = imgs[i];
            if (!im || !im.anchor) continue;
            var nk = followNorm(im.anchor);
            if (nk.length < 4) continue;
            // 先走一次全局索引（一次建索引可服务所有图），命中轮次不对时
            // 再到图片自己所属的轮次里找，避免同一句话在更早轮次里先出现。
            var hit = followFindInRow(rows, im.anchor, null);
            if (hit && im.turn !== null && im.turn !== undefined && isFinite(Number(im.turn))
              && isFinite(Number(hit.turn)) && Number(hit.turn) !== Number(im.turn)) {
              var ownRows = [];
              for (var tr = 0; tr < rows.length; tr += 1) {
                if (Number(rows[tr].getAttribute("data-chat-turn")) === Number(im.turn)) ownRows.push(rows[tr]);
              }
              if (ownRows.length) hit = followFindInRow(ownRows, im.anchor, Number(im.turn)) || hit;
            }
            if (!hit) continue;
            var old = byKey[nk];
            if (old) {
              // 同一句锚点可能对应连续图的 N 张变体；先全部收着，后面按段落位置拆开。
              if (!old.variants) old.variants = [{ im: old.im, index: old.index }];
              old.variants.push({ im: im, index: i });
              if (i > old.index) { old.im = im; old.index = i; }
              continue;
            }
            var g = {
              key: nk, im: im, index: i, range: hit.range,
              top: hit.top, bottom: hit.bottom,
              point: hit.point !== undefined ? hit.point : hit.bottom,
              variants: [{ im: im, index: i }],
            };
            byKey[nk] = g;
            groups.push(g);
          }
          var scrollTop = 0;
          try { scrollTop = read.host.scrollTop || 0; } catch (e2) { scrollTop = 0; }
          var viewTop = Number(read.top);
          if (!isFinite(viewTop)) viewTop = 0;
          for (var n = 0; n < groups.length; n += 1) {
            // point 是 getClientRects() 的视口坐标；scrollTop 是相对滚动内容的坐标。
            // 必须先减掉会话区在视口里的 top，才能和 baselineDoc 用同一个原点。
            // 少减这一项时，偏移量正好等于会话区 top（DSH 菜单栏 / Tavern 全屏一变就偏）。
            groups[n].yDoc = groups[n].point - viewTop + scrollTop;
          }
          groups.sort(function (a, b) { return a.yDoc - b.yDoc; });
          // 同一行 / 相邻 2px 内的多个句子合并成一个插入点，避免一次跳两张。
          var merged = [];
          for (var m = 0; m < groups.length; m += 1) {
            var cur = groups[m];
            var last = merged[merged.length - 1];
            if (last && Math.abs(cur.yDoc - last.yDoc) <= 2) {
              if (cur.index > last.index) { last.im = cur.im; last.index = cur.index; }
              last.variants = (last.variants || []).concat(cur.variants || []);
              continue;
            }
            merged.push(cur);
          }
          // 连续图：同一句锚点前有 N 张变体时，把上一场结束到这一句的段落
          // 按 N 等分，每张变体占一个子位置；不是连续图就保持一个插入点。
          var expanded = [];
          for (var e = 0; e < merged.length; e += 1) {
            var mg = merged[e];
            var vars = (mg.variants || []).slice();
            var refJob = String(mg.im && mg.im.jobId || "");
            // 只有同一轮、同一连续图组的变体才按段落拆；同一句在别的轮次
            // 重复出现时仍按旧规则只留最新一张做代表。
            var continuous = vars.length > 1
              && vars.every(function (v) {
                return isContinuousImage(v.im)
                  && String(v.im && v.im.jobId || "") === refJob;
              });
            if (!continuous) {
              expanded.push(mg);
              continue;
            }
            vars.sort(function (a, b) {
              var av = a.im.setIndex === null || a.im.setIndex === undefined ? 999 : Number(a.im.setIndex);
              var bv = b.im.setIndex === null || b.im.setIndex === undefined ? 999 : Number(b.im.setIndex);
              if (av !== bv) return av - bv;
              return a.index - b.index;
            });
            var start = e > 0 ? merged[e - 1].yDoc : 0;
            var end = mg.yDoc;
            if (!(end > start)) {
              expanded.push(mg);
              continue;
            }
            var step = (end - start) / vars.length;
            for (var k = 0; k < vars.length; k += 1) {
              var v = vars[k];
              expanded.push({
                key: mg.key + "#" + k,
                im: v.im,
                index: v.index,
                range: mg.range,
                top: mg.top,
                bottom: mg.bottom,
                point: mg.point,
                yDoc: start + step * (k + 1),
                variants: [v],
              });
            }
          }
          followGroupRef.current = { key: key, groups: expanded };
          return expanded;
        };

        var followInsertTarget = function (read) {
          var anchorCount = 0;
          for (var a = 0; a < imgs.length; a += 1) {
            if (imgs[a] && imgs[a].anchor) anchorCount += 1;
          }
          // 用户要的硬规则：滚到正文最底部就强制最后一张。
          if (read.atBottom && imgs.length) {
            var lastIndex = imgs.length - 1;
            return {
              turn: read.turn, region: "bottom", index: lastIndex, id: imgs[lastIndex].id,
              reason: "bottom", anchorCount: anchorCount, groupCount: 0,
            };
          }
          var groups = followAnchorGroups(read);
          if (!groups.length) {
            var pct = followPercentTarget(read);
            if (pct) {
              pct.reason = "percent";
              pct.groupCount = 0;
              pct.anchorCount = anchorCount;
            }
            return pct;
          }
          var scrollTop = 0;
          try { scrollTop = read.host.scrollTop || 0; } catch (e) { scrollTop = 0; }
          var triggerY = read.triggerY !== undefined ? read.triggerY : read.lineY;
          var baselineDoc = scrollTop + (triggerY - read.top);
          var count = 0;
          for (var i = 0; i < groups.length; i += 1) {
            if (groups[i].yDoc < baselineDoc - 1) count += 1;
          }
          var at = Math.min(count, groups.length - 1);
          var g = groups[at];
          return {
            turn: read.turn, region: "g" + at, index: g.index, id: g.im.id,
            reason: "anchor", anchorCount: anchorCount, groupCount: groups.length,
            baselineDoc: baselineDoc, scrollTop: scrollTop,
            // 插入点相对基线的位置：负数 = 插入点已经过线。
            triggerDelta: Math.round((g.yDoc - baselineDoc) * 10) / 10,
          };
        };

        var followTarget = function (baselineY) {
          var read = followReadTurn(baselineY);
          if (!read) return { read: null, reason: "no-read" };
          var offset = Number(followOffsetRef.current);
          if (!isFinite(offset)) offset = 0;
          offset = clamp(offset, -200, 200);
          read.triggerY = Math.max(read.top, Math.min(read.top + read.height, read.lineY + offset));
          followTurnRef.current = read.turn;
          var t = followInsertTarget(read);
          if (!t) {
            var count = 0;
            for (var ai = 0; ai < imgs.length; ai += 1) if (imgs[ai] && imgs[ai].anchor) count += 1;
            return { read: read, reason: "no-target", anchorCount: count, groupCount: 0 };
          }
          t.read = read;
          return t;
        };

        var followReasonText = function (reason) {
          return ({
            bottom: "触底→强制最后一张",
            anchor: "原文锚点组",
            percent: "百分比回退",
            latest: "旧图→最新一张",
            "no-target": "锚点/轮次都没命中",
            "no-read": "找不到会话区",
            "no-index": "目标下标越界",
            paused: "手动暂停在这个区间",
            same: "已经是目标图",
            switch: "已切图",
          })[reason] || String(reason || "未知");
        };

        /**
         * 调试层：画出中线，并把“当前图 / 目标区域 / 锚点数 / 采样间隔”写进左下角。
         * 直接操作 DOM，不 setState —— 采样是 10Hz 级别，走 React 会把整棵悬浮球拖慢。
         */
        var followDebugSnapshot = function (t, extra) {
          // 关掉调试时不做任何 DOM / 字符串工作。
          if (!followHudRef.current && !followLineRef.current) return;
          var now = extra && extra.at ? extra.at : Date.now();
          var s = followStatsRef.current;
          var gap = s.lastAt ? now - s.lastAt : 0;
          s.samples += 1;
          s.lastAt = now;
          s.lastGap = gap;
          if (gap > 0) s.gapSum += gap;
          var reason = (extra && extra.reason) || (t && t.reason) || "unknown";
          s.lastReason = reason;

          var read = t && t.read ? t.read : null;
          var curId = String(imgIdRef.current || (img && img.id) || "");
          var curIdx = -1;
          for (var ci = 0; ci < imgs.length; ci += 1) {
            if (String(imgs[ci].id || "") === curId) { curIdx = ci; break; }
          }
          var cur = curIdx >= 0 ? imgs[curIdx] : null;
          var target = t && t.index >= 0 && t.index < imgs.length ? imgs[t.index] : null;
          var mode = extra && extra.mode === "pointer" ? "光标" : "滚动";
          var region = t && t.region ? String(t.region) : "无";
          var line = followLineRef.current;
          if (line) {
            if (read && read.host) {
              var rr = read.host.getBoundingClientRect();
              line.style.display = "block";
              line.style.left = Math.max(0, Math.round(rr.left)) + "px";
              line.style.width = Math.max(0, Math.round(rr.width)) + "px";
              line.style.top = Math.round(read.lineY) + "px";
            } else {
              line.style.display = "none";
            }
            var tag = followLineTagRef.current;
            if (tag) {
              tag.textContent = mode + "基线 · 区域 " + region
                + (target ? " · 图 " + (t.index + 1) + "/" + imgs.length : "")
                + (reason === "paused" ? " · 暂停" : "");
            }
          }
          var hud = followHudRef.current;
          var line2 = followLine2Ref.current;
          var offsetPx = Math.round(Number(followOffsetRef.current) || 0);
          if (line2) {
            if (read && read.host && offsetPx !== 0) {
              var rr2 = read.host.getBoundingClientRect();
              line2.style.display = "block";
              line2.style.left = Math.max(0, Math.round(rr2.left)) + "px";
              line2.style.width = Math.max(0, Math.round(rr2.width)) + "px";
              line2.style.top = Math.round(read.triggerY !== undefined ? read.triggerY : read.lineY) + "px";
              if (followLine2TagRef.current) {
                followLine2TagRef.current.textContent = "偏移基线 " + (offsetPx > 0 ? "+" : "") + offsetPx + "px"
                  + (target ? " · 图 " + (t.index + 1) + "/" + imgs.length : "");
              }
            } else {
              line2.style.display = "none";
            }
          }
          if (!hud) return;
          // 中线每帧更新；文字 10Hz 就够了，避免 60fps 采样时反复改 DOM 文本。
          if (now - (s.lastHudAt || 0) < 100) return;
          s.lastHudAt = now;
          var avg = s.samples > 1 ? Math.round(s.gapSum / (s.samples - 1)) : 0;
          var lines = [
            "跟图采样 #" + s.samples + " · " + mode + " · 本次 " + (gap ? gap + "ms" : "首帧") + " · 平均 " + (avg ? avg + "ms" : "-") + " · 切图 " + s.switches,
            "当前图：" + (cur ? (curIdx + 1) + "/" + imgs.length + (cur.anchor ? "（有锚点）" : "（无锚点）") : "无")
              + " · 目标区域：" + (target ? region + " → 图 " + (t.index + 1) + "/" + imgs.length : "无"),
            "原因：" + followReasonText(reason)
              + " · 锚点 " + (t && t.anchorCount !== undefined ? t.anchorCount : 0) + "/" + imgs.length
              + " · 插入点 " + (t && t.groupCount !== undefined ? t.groupCount : 0)
              + (t && t.triggerDelta !== undefined ? " · 触发差 " + t.triggerDelta + "px" : ""),
            read
              ? "轮次 " + read.turn + "/" + read.lastTurn + " · 基线 y=" + Math.round(read.lineY)
                + (offsetPx ? " · 偏移 " + (offsetPx > 0 ? "+" : "") + offsetPx + "px → 触发线 y=" + Math.round(read.triggerY !== undefined ? read.triggerY : read.lineY) : "")
                + " · 滚动 " + Math.round((read.host && read.host.scrollTop) || 0)
                + " · 触底 " + (read.atBottom ? "是" : "否")
              : "轮次 - · 找不到 [data-conversation-scroll] 或 [data-chat-turn]",
            "目标图：" + (target ? String(target.id).slice(-12) + (target.anchor ? " · " + String(target.anchor).slice(0, 46) : " · 无锚点") : "无"),
            "当前图锚点：" + (cur && cur.anchor ? String(cur.anchor).slice(0, 60) : "（空）"),
          ];
          hud.textContent = lines.join("\n");
        };

        var followApply = function (baselineY) {
          if ((!followOn && !pointerFollow) || (!prefs.open && !fullOpen) || dragRef.current) return;
          var at = Date.now();
          var y = baselineY;
          if (pointerFollow && pointerYRef.current !== null && pointerYRef.current !== undefined) y = pointerYRef.current;
          var mode = pointerFollow && pointerYRef.current !== null && pointerYRef.current !== undefined ? "pointer" : "scroll";
          var t = followTarget(y);
          if (!t || !t.read) {
            followDebugSnapshot(t || { read: null, reason: "no-read" }, { at: at, mode: mode });
            return;
          }
          var key = t.turn + ":" + t.region;
          // 手动翻页后先停在这个锚点 / 百分比区间；滚到下一个区间再恢复。
          var paused = followPauseKey.current === key;
          var reason = t.reason || "no-target";
          if (paused) {
            reason = "paused";
          } else {
            if (followPauseKey.current) followPauseKey.current = "";
            if (t.index < 0 || t.index >= imgs.length) {
              reason = "no-index";
            } else {
              var target = imgs[t.index];
              // ★ 这里不能比较闭包里的 img：effect 只在图片列表变化时重建，
              //   切图后闭包里的 img 还是旧图，会出现“切过去就再也切不回来”。
              var currentId = String(imgIdRef.current || (img && img.id) || "");
              if (!target) {
                reason = "no-index";
              } else if (currentId && currentId === String(target.id)) {
                reason = "same";
              } else {
                jumpNewest.current = false;
                imgIdRef.current = String(target.id);
                setIdx(t.index);
                followStatsRef.current.switches += 1;
                reason = "switch";
                // 右侧栏全屏也跟随同一套切图结果。
                try {
                  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
                    var fev;
                    if (typeof CustomEvent === "function") fev = new CustomEvent(FULL_FOLLOW_EVENT, { detail: { imageId: String(target.id || "") } });
                    else if (typeof document !== "undefined" && document.createEvent) {
                      fev = document.createEvent("CustomEvent");
                      fev.initCustomEvent(FULL_FOLLOW_EVENT, false, false, { imageId: String(target.id || "") });
                    }
                    if (fev) window.dispatchEvent(fev);
                  }
                } catch (eFull) { /* ignore */ }
              }
            }
          }
          followDebugSnapshot(t, { at: at, mode: mode, reason: reason });
        };

        var followPause = function () {
          var y = pointerFollow && pointerYRef.current !== null && pointerYRef.current !== undefined
            ? pointerYRef.current
            : undefined;
          var t = followTarget(y);
          followPauseKey.current = t && t.turn !== undefined && t.region ? t.turn + ":" + t.region : "";
        };

        var followQueue = function (delay) {
          // 节流而不是防抖：滚动过程中可以连续采样，不会因为每个 scroll
          // 事件都把定时器往后推，导致“滚动时一直不切，停下才切”。
          var now = Date.now();
          var wait = Math.max(0, Number(delay) || 0, followNextAt.current - now);
          var due = now + wait;
          if (followTimer.current) {
            if (due >= followTimerDue.current) return;
            clearTimeout(followTimer.current);
          }
          followTimerDue.current = due;
          followTimer.current = setTimeout(function () {
            followTimer.current = null;
            followNextAt.current = Date.now() + 70;
            followApply();
          }, wait);
        };

        // 滚动 / 光标都按屏幕帧采样：只等一帧，避免 55–70ms 节流在快速
        // 滚动时看起来“差一两行才切”。锚点组有缓存，读一帧很轻。
        var followFrame = function () {
          if (followRaf.current) return;
          var run = function () {
            followRaf.current = 0;
            followApply();
          };
          try { followRaf.current = raf(run); } catch (e) { followRaf.current = setTimeout(run, 16); }
        };

        // 指针跟随同理：连续移动时不能用防抖，否则鼠标不停就永远不采样。
        var followPointerPulse = function () {
          pointerLastAt.current = Date.now();
          followFrame();
        };

        /** 调试滑块：负数 = 蓝线在绿线上方 = 提前触发；0 = 只显示绿线。 */
        var changeFollowOffset = function (next) {
          var value = Math.round(clamp(next, -200, 200));
          followOffsetRef.current = value;
          setFollowOffset(value);
          writeFollowOffset(value);
          // 只调偏移、还没滚动时也要立刻把蓝线 / HUD 刷新出来。
          if (debugOn && (prefs.open || fullOpen)) {
            var t = followTarget();
            followDebugSnapshot(t || { read: null, reason: "no-read" }, {
              at: Date.now(),
              mode: pointerFollow ? "pointer" : "scroll",
              reason: (t && t.reason) || "no-read",
            });
          }
          if (followOn || pointerFollow) followFrame();
        };

        /** 竖向滑轨：顶端 = -200（提前），底端 = +200（延后）。 */
        var applyFollowOffsetFromY = function (clientY, track) {
          if (!track || !track.getBoundingClientRect) return;
          var r = track.getBoundingClientRect();
          if (!r || r.height <= 0) return;
          var p = clamp((clientY - r.top) / r.height, 0, 1);
          changeFollowOffset(Math.round((p - 0.5) * 400));
        };

        var flashCounter = function () {
          if (!imgs.length) return;
          setCounterVisible(true);
          if (counterTimer.current) clearTimeout(counterTimer.current);
          counterTimer.current = setTimeout(function () {
            counterTimer.current = null;
            setCounterVisible(false);
          }, 1800);
        };

        useEffect(function () {
          if (prefs.open) { setNearAny(false); setNearBR(true); setSideNav(""); }
        }, []);

        useEffect(function () {
          var sid = data && data.activeSessionId ? data.activeSessionId : "";
          if (sid && sid !== lastSessionId.current) {
            lastSessionId.current = sid;
            jumpNewest.current = true;
            imgIdRef.current = "";
            fittedImgId.current = "";
            setSwitching(false);
            followPauseKey.current = "";
            followTurnRef.current = null;
            followCacheRef.current = { key: "", len: -1, text: "", segs: [] };
            followMatchRef.current = { key: "", list: [] };
            followGroupRef.current = { key: "", groups: [] };
            followSeenRef.current = {};
            followRevision.current += 1;
          } else if (!sid) {
            lastSessionId.current = "";
          }
        }, [data && data.activeSessionId]);

        useEffect(function () {
          setFollowOn(prefs.follow !== false);
        }, [prefs.follow]);

        useEffect(function () {
          setPointerFollow(prefs.pointerFollow === true);
        }, [prefs.pointerFollow]);

        // 图片框、全屏菜单、右侧栏共用同一份开关状态：任一处切换后立刻广播。
        useEffect(function () {
          var onPrefs = function (ev) {
            var next = ev && ev.detail && ev.detail.prefs;
            if (next && typeof next === "object") setPrefs(normalizeFloatPrefs(next));
          };
          var onUiConfig = function (ev) {
            var d = ev && ev.detail && typeof ev.detail === "object" ? ev.detail : {};
            if (typeof d.autoOn === "boolean") setAutoOn(d.autoOn);
            if (typeof d.contOn === "boolean") setContOn(d.contOn);
          };
          try {
            if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
              window.addEventListener(PREFS_EVENT, onPrefs);
              window.addEventListener(UI_CONFIG_EVENT, onUiConfig);
            }
          } catch (e) { /* ignore */ }
          return function () {
            try {
              if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
                window.removeEventListener(PREFS_EVENT, onPrefs);
                window.removeEventListener(UI_CONFIG_EVENT, onUiConfig);
              }
            } catch (e) { /* ignore */ }
          };
        }, []);

        // 滚动 / 光标 / 新消息 / 窗口变化时切图；90ms 防抖，不跟滚动过程抢帧。
        useEffect(function () {
          if ((!prefs.open && !fullOpen) || (!followOn && !pointerFollow)) return undefined;
          var onScroll = function (ev) {
            if (!followOn) return;
            // 只认真实会话区的滚动；侧栏 / 图库 / 菜单的滚动不能触发切图。
            var host = followScroller();
            var target = ev && ev.target;
            if (host && target && target.nodeType === 1 && target !== host && !host.contains(target)) return;
            followFrame();
          };
          var onResize = function () {
            // 宽度变化会改段落高度：插入点的文档坐标要重算。
            followGroupRef.current = { key: "", groups: [] };
            if (followOn) followQueue(50);
          };
          var onPointerMove = function (ev) {
            if (!pointerFollow) return;
            // 鼠标在图片框 / 控件上时不算“在正文区域”，否则拖图片框也会切图。
            try {
              if (frameRef.current && ev.target && frameRef.current.contains(ev.target)) return;
            } catch (e0) { /* ignore */ }
            var host = followScroller();
            if (!host || !host.getBoundingClientRect) return;
            var r = host.getBoundingClientRect();
            if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) {
              if (pointerYRef.current !== null) {
                pointerYRef.current = null;
                followFrame();
              }
              return;
            }
            pointerYRef.current = ev.clientY;
            followPointerPulse();
          };
          try {
            if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
              document.addEventListener("scroll", onScroll, true);
              document.addEventListener("pointermove", onPointerMove, true);
            }
          } catch (e) { /* ignore */ }
          try {
            if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
              window.addEventListener("resize", onResize);
            }
          } catch (e2) { /* ignore */ }
          var tick = setInterval(function () { if (followOn) followQueue(0); }, 600);
          var host = followScroller();
          if (host && typeof MutationObserver === "function") {
            try {
              followObserver.current = new MutationObserver(function () {
                followRevision.current += 1;
                followQueue(250);
              });
              followObserver.current.observe(host, { childList: true, subtree: true, characterData: true });
            } catch (e3) { followObserver.current = null; }
          }
          if (followOn) followQueue(0);
          return function () {
            try {
              if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
                document.removeEventListener("scroll", onScroll, true);
                document.removeEventListener("pointermove", onPointerMove, true);
              }
            } catch (e4) { /* ignore */ }
            try {
              if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
                window.removeEventListener("resize", onResize);
              }
            } catch (e5) { /* ignore */ }
            clearInterval(tick);
            if (followTimer.current) { clearTimeout(followTimer.current); followTimer.current = null; }
            if (followRaf.current) {
              try { caf(followRaf.current); } catch (e7) { /* ignore */ }
              followRaf.current = 0;
            }
            if (pointerTimer.current) { clearTimeout(pointerTimer.current); pointerTimer.current = null; }
            pointerYRef.current = null;
            if (followObserver.current) {
              try { followObserver.current.disconnect(); } catch (e6) { /* ignore */ }
              followObserver.current = null;
            }
          };
        }, [prefs.open, prefs.debug, followOn, pointerFollow, fullOpen, imgKey, data && data.activeSessionId]);

        // 图片列表变化后，旧的锚点匹配缓存作废（手动暂停状态保留）。
        useEffect(function () {
          followMatchRef.current = { key: "", list: [] };
        }, [imgKey]);

        // 先预加载下一张，显示层仍保留旧图；新图缓存完成后再换，避免中间出现空白。
        useEffect(function () {
          var target = img;
          var seq = viewSeq.current + 1;
          viewSeq.current = seq;
          if (!target) {
            setSwitching(false);
            setViewImg(null);
            setViewSrc("");
            return;
          }
          // 刚换会话 / 第一次加载时先等下面把下标跳到最新，别先预加载最旧那张。
          if (jumpNewest.current) return;
          if (viewImg && viewImg.url === target.url) {
            // 同一张图只同步收藏 / 回收状态，不重新预加载、不重置缩放。
            setSwitching(false);
            if (viewImg.favorited !== target.favorited || viewImg.recycled !== target.recycled) setViewImg(target);
            return;
          }
          var done = false;
          var failed = false;
          var triedOriginal = false;
          var slowTimer = null;
          var fallbackTimer = null;
          var show = function (nw, nh, src) {
            if (seq !== viewSeq.current || done) return;
            done = true;
            if (slowTimer) { clearTimeout(slowTimer); slowTimer = null; }
            if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
            if (nw > 0 && nh > 0) naturalSizeRef.current = { id: String(target.id || ""), w: nw, h: nh };
            if (dragRef.current) {
              pendingView.current = { target: target, nw: nw, nh: nh, src: src || target.url };
              return;
            }
            if (nw > 0 && nh > 0) fittedImgId.current = target.id;
            setViewImg(target);
            setViewSrc(src || target.url);
            setSwitching(false);
            if (nw > 0 && nh > 0) fitFrameToImage(nw, nh);
          };
          if (typeof Image !== "function") {
            show(0, 0, target.url);
            return;
          }
          var pre = new Image();
          var finishing = false;
          var finish = function () {
            if (finishing) return;
            finishing = true;
            var apply = function () { show(pre.naturalWidth, pre.naturalHeight, pre.src || target.url); };
            // decode 完成后再换，避免缓存命中但解码慢时闪一下空白。
            if (typeof pre.decode === "function") pre.decode().then(apply, apply);
            else apply();
          };
          var startPreload = function (src) {
            if (seq !== viewSeq.current || done || failed || !src) return;
            pre.onload = finish;
            pre.onerror = function () {
              // Blob 读失败时退回原始 URL 再试一次。
              if (!triedOriginal && pre.src && pre.src !== target.url) {
                triedOriginal = true;
                startPreload(target.url);
                return;
              }
              failed = true;
              if (slowTimer) { clearTimeout(slowTimer); slowTimer = null; }
              if (seq !== viewSeq.current) return;
              setSwitching(false);
              showToast("图片加载失败，保留当前图", "err");
            };
            pre.src = src;
            if (pre.complete && pre.naturalWidth) finish();
          };
          // 先在本地 Blob 缓存里找；切回看过的图时不用再走网络 / 磁盘。
          var readySrc = cachedImageSrcNow(target.url);
          if (readySrc) {
            setSwitching(false);
            startPreload(readySrc);
          } else {
            cachedImageSrc(target.url).then(startPreload, function () { startPreload(target.url); });
          }
          // 只有还没缓存的图才显示“加载中”；看过的图直接换，旧图一直留到新图可显示。
          if (!readySrc) {
            slowTimer = setTimeout(function () { if (seq === viewSeq.current && !done && !failed) setSwitching(true); }, 90);
          }
          // 删除 / 出图后大图预加载偶尔会很慢；最多等 1.5 秒，先把图换上，
          // 让浏览器自己继续解码，避免“一直加载中”。自然尺寸回来后再补自适应。
          fallbackTimer = setTimeout(function () {
            fallbackTimer = null;
            if (seq !== viewSeq.current || done || failed) return;
            show(0, 0, target.url);
          }, 1500);
          return function () {
            if (slowTimer) { clearTimeout(slowTimer); slowTimer = null; }
            if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
          };
        }, [img && img.url, img && img.favorited, img && img.recycled, viewTick]);

        // 新图画进来时不要按旧下标硬切：当前选中的图尽量留在原地；
        // 本来就在最新一张时，继续跟最新一张（旧→新顺序，最新在最后）。
        useEffect(function () {
          var ids = imgs.map(function (x) { return String(x.id || ""); });
          var prev = prevImgIds.current;
          prevImgIds.current = ids;
          if (!imgs.length) {
            imgIdRef.current = "";
            fittedImgId.current = "";
            setCounterVisible(false);
            if (idx !== 0) setIdx(0);
            return;
          }
          // 重新生成 / 请求生成完成后，优先落到新任务的那张图；
          // 不能等“当前图还在不在”的保护逻辑，否则会继续停在旧图。
          var pendingJob = pendingShowJobRef.current;
          if (pendingJob) {
            var pendingAt = -1;
            var currentPendingAt = -1;
            var currentAnyAt = -1;
            var currentId = String(imgIdRef.current || "");
            for (var pj = 0; pj < imgs.length; pj += 1) {
              if (currentId && String(imgs[pj].id || "") === currentId) currentAnyAt = pj;
              if (String(imgs[pj].jobId || "") !== pendingJob) continue;
              pendingAt = pj;
              // 连续图整组替换时，组里每张都指向新任务；停在用户点的那一张。
              if (currentId && String(imgs[pj].id || "") === currentId) currentPendingAt = pj;
            }
            if (currentPendingAt >= 0) pendingAt = currentPendingAt;
            // 仅此图 / 连续图替换是原地更新；新 jobId 可能比当前这张先到，
            // 先按当前 id 停住，别跳到同组别的位置。
            else if (pendingKeepImageRef.current && currentAnyAt >= 0) pendingAt = currentAnyAt;
            if (pendingAt >= 0) {
              pendingShowJobRef.current = "";
              pendingKeepImageRef.current = false;
              jumpNewest.current = false;
              imgIdRef.current = ids[pendingAt];
              fittedImgId.current = "";
              if (pendingAt !== idx) setIdx(pendingAt);
              else setViewTick(function (v) { return v + 1; });
              return;
            }
          }
          var last = imgs.length - 1;
          if (jumpNewest.current) {
            jumpNewest.current = false;
            imgIdRef.current = ids[last];
            if (idx !== last) setIdx(last);
            else setViewTick(function (v) { return v + 1; });
            return;
          }
          // 删除后指定一个邻图：优先下一张（更新），没有下一张再上一张（更早）。
          var prefer = preferImgId.current;
          if (prefer) {
            preferImgId.current = "";
            var pi = -1;
            for (var k = 0; k < imgs.length; k += 1) {
              if (String(imgs[k].id || "") === prefer) { pi = k; break; }
            }
            if (pi >= 0) {
              imgIdRef.current = prefer;
              if (pi !== idx) setIdx(pi);
              return;
            }
          }
          var wasNewest = prev.length > 0 && idx >= prev.length - 1;
          if (wasNewest) {
            imgIdRef.current = ids[last];
            if (idx !== last) setIdx(last);
            return;
          }
          var keep = imgIdRef.current;
          var pos = -1;
          for (var i = 0; i < imgs.length; i += 1) {
            if (String(imgs[i].id || "") === keep) { pos = i; break; }
          }
          if (pos >= 0) {
            if (pos !== idx) setIdx(pos);
          } else {
            // 当前图被外部删掉、又没有指定邻图：夹在最近位置，不跳回最新。
            var fallback = Math.min(idx, last);
            imgIdRef.current = ids[fallback];
            if (fallback !== idx) setIdx(fallback);
          }
        }, [imgKey]);

        // 页码：切图 / 开关框 / 图片数量变化时显示一会儿。
        useEffect(function () {
          if (!prefs.open || !imgs.length || (jumpNewest.current && imgs.length > 1)) {
            if (!imgs.length) setCounterVisible(false);
            return undefined;
          }
          flashCounter();
          return undefined;
        }, [prefs.open, safeIdx, imgs.length, viewTick]);

        // 预取前后两张：翻页前就把图拉进本地 Blob 缓存，避免每次都现读。
        useEffect(function () {
          if (!prefs.open || typeof Image !== "function" || imgs.length < 2) return undefined;
          var timer = setTimeout(function () {
            [safeIdx - 1, safeIdx + 1].forEach(function (i) {
              var item = imgs[i];
              if (!item || !item.url) return;
              cachedImageSrc(item.url).then(function (src) {
                if (!src) return;
                try {
                  var pre = new Image();
                  pre.decoding = "async";
                  pre.src = src;
                } catch (e) { /* ignore */ }
              });
            });
          }, 120);
          return function () { clearTimeout(timer); };
        }, [prefs.open, safeIdx, imgKey]);

        useEffect(function () {
          var cap = data && data.config && data.config.capture ? data.config.capture : {};
          setAutoOn(cap.autoForward !== false && cap.autoGenerate !== false);
          var g = data && data.config && data.config.generation && data.config.generation.continuous ? data.config.generation.continuous.on : false;
          setContOn(g === true);
        }, [
          data && data.config && data.config.capture && data.config.capture.autoForward,
          data && data.config && data.config.capture && data.config.capture.autoGenerate,
          data && data.config && data.config.generation && data.config.generation.continuous && data.config.generation.continuous.on,
        ]);

        var size = vp();
        var ball = prefs.ball || {};
        var frame = prefs.frame || {};
        var bx = ball.x === null || ball.x === undefined ? size.w - 68 : clamp(ball.x, 0, size.w - BALL);
        var by = ball.y === null || ball.y === undefined ? size.h - 126 : clamp(ball.y, 0, size.h - BALL);

        // 没有图片时用之前保存的框尺寸；有图片时先按图片比例自适应，再允许滚轮缩放。
        var emptyW = Math.max(1, Number(frame.emptyW) || DEFAULT_W);
        var emptyH = Math.max(1, Number(frame.emptyH) || DEFAULT_H);
        var baseW = view ? Math.max(1, Number(frame.w) || emptyW) : emptyW;
        var baseH = view ? Math.max(1, Number(frame.h) || emptyH) : emptyH;
        var maxW = Math.max(1, size.w);
        var maxH = Math.max(1, size.h);
        var fit = Math.min(1, maxW / baseW, maxH / baseH);
        var fw = Math.max(1, Math.round(baseW * fit));
        var fh = Math.max(1, Math.round(baseH * fit));

        // 展开时让右下收起按钮的中心落在悬浮球中心；收起时反过来。
        var alignX = bx + BALL_HALF - fw + COLLAPSE;
        var alignY = by + BALL_HALF - fh + COLLAPSE;
        var fxDefault = clamp(alignX, 0, Math.max(0, size.w - fw));
        var fyDefault = clamp(alignY, 0, Math.max(0, size.h - fh));
        var fx = frame.x === null || frame.x === undefined ? fxDefault : clamp(frame.x, 0, Math.max(0, size.w - fw));
        var fy = frame.y === null || frame.y === undefined ? fyDefault : clamp(frame.y, 0, Math.max(0, size.h - fh));

        // 左侧停靠：图片框作为“会话内的左侧栏”，给会话 body 留出对应 padding。
        // 这里只做视觉让位，不注册 DSH 左侧 pane（DSH 没有这个扩展位）。
        var docked = prefs.dock === "left";
        var dockMax = dockRect ? Math.max(0, Math.min(920, dockRect.width - DOCK_MIN_CHAT - DOCK_GAP)) : 0;
        var savedDockW = Number(frame.dockW) || 0;
        var dockW = Math.max(DOCK_MIN, Math.min(savedDockW || defaultDockWidth(dockMax), dockMax || DOCK_MIN));
        var dockedActive = !!(docked && prefs.open && dockRect && dockRect.width > 0 && dockMax >= DOCK_MIN);
        dockStateRef.current = { docked: docked, dockW: dockW, dockRect: dockRect };
        // 测试功能：左侧留空。只给会话 body 加 padding，图片框位置 / 大小完全不动。
        // 竖线拖动只改留空宽度；把图片框滚轮放大盖到这块空白上，就是“左侧全屏”。
        var reserved = prefs.reserve === "left";
        var reserveMax = dockRect ? Math.max(0, Math.min(RESERVE_MAX, dockRect.width - RESERVE_MIN_CHAT - DOCK_GAP)) : 0;
        var savedReserveW = Number(frame.reserveW) || 0;
        var reserveW = Math.max(1, Math.min(savedReserveW || defaultReserveWidth(reserveMax), reserveMax || RESERVE_MIN));
        var reservedActive = !!(reserved && prefs.open && dockRect && dockRect.width > 0 && reserveMax >= RESERVE_MIN);
        var railX = reservedActive ? dockRect.left + reserveW : 0;
        // 拖动命中区是整段竖线（会话 body 全高）；真正画出来的白线只跟图片框一样高。
        var railTop = reservedActive ? dockRect.top : 0;
        var railHeight = reservedActive ? dockRect.height : 0;
        var railLineTop = reservedActive ? Math.max(0, Math.round(fy - dockRect.top)) : 0;
        var railLineH = reservedActive ? Math.max(0, Math.min(fh, dockRect.height - railLineTop)) : 0;
        railRectRef.current = { x: railX, y: railTop, h: railHeight };
        var drawW = dockedActive ? dockW : fw;
        var drawH = dockedActive ? dockRect.height : fh;
        var drawX = dockedActive ? dockRect.left : fx;
        var drawY = dockedActive ? dockRect.top : fy;

        // 框尺寸策略：默认按图片比例自适应（翻页时把点击的那侧箭头钉在原地）；
        // 用户自己滚轮缩放 / 拖动过之后，切图不再动框。
        var fitFrameToImage = function (nw, nh) {
          if (dockedActive) { fitAnchorRef.current = ""; return; }
          if (reservedActive) {
            // 「悬浮于左侧」只在点按钮时放一次位。之后它就是普通悬浮窗：
            // 新图 / 翻页都不许再回写位置、尺寸和分隔线宽度，用户怎么调就怎么留着
            // （图比例对不上时由 .ac-frame.reserved 的 contain 兜住，不裁图）。
            fitAnchorRef.current = "";
            return;
          }
          // 普通悬浮窗：用户自己缩放 / 拖过之后，切图一律保留他调好的尺寸和位置，
          // 不再回归「按图自适应」的初始大小；没动过之前仍按第一张图定框。
          // 新图比例对不上时由 .ac-frame .ac-stage 的 contain 整张显示，不裁图。
          if (frame.userSized) { fitAnchorRef.current = ""; return; }
          var wide = Number(nw) || 0;
          var high = Number(nh) || 0;
          if (wide <= 0 || high <= 0) return;
          var fitAnchor = fitAnchorRef.current || "";
          fitAnchorRef.current = "";
          var ratio = wide / high;
          // 以当前框宽 / 默认宽为下限，避免在窄框里切到横图时被压得太小；
          // 高度用整个视口，不再被“当前底边”卡住（竖图在靠上的位置也能正常放大）。
          var maxW = Math.max(1, Math.min(size.w - fx, Math.max(fw, DEFAULT_W)));
          var maxH = Math.max(1, size.h);
          var bottom = fy + fh;
          var targetX = fx;
          var targetY = 0;
          if (fitAnchor === "left" || fitAnchor === "right") {
            // 箭头在图片框左右边缘；水平方向钉住，垂直方向尽量让箭头中心不动。
            var arrowMidY = fy + fh / 2;
            var oldRight = fx + fw;
            if (fitAnchor === "left") {
              maxW = Math.max(1, Math.min(size.w - fx, Math.max(fw, DEFAULT_W)));
            } else {
              maxW = Math.max(1, Math.min(oldRight, Math.max(fw, DEFAULT_W)));
            }
            maxH = Math.max(1, size.h);
            targetY = arrowMidY;
          }
          var scale = Math.min(maxW / wide, maxH / high);
          var tw = Math.max(1, Math.round(wide * scale));
          var th = Math.max(1, Math.round(high * scale));
          // 四舍五入可能让比例差 1px，按高度反推一次宽度，保证图片和框同比例。
          if (th > 0) tw = Math.max(1, Math.round(th * ratio));
          if (fitAnchor === "left") {
            targetX = fx;
            targetY = arrowMidY - th / 2;
          } else if (fitAnchor === "right") {
            targetX = oldRight - tw;
            targetY = arrowMidY - th / 2;
          } else {
            targetX = fx;
            targetY = bottom - th;
          }
          setFrame({
            x: clamp(targetX, 0, Math.max(0, size.w - tw)),
            y: clamp(targetY, 0, Math.max(0, size.h - th)),
            w: tw, h: th, emptyW: emptyW, emptyH: emptyH,
          }, true);
        };

        // 左侧留空激活时：保持图片框原来的比例和外观，只把它等比放大、移到右侧贴线。
        // 不拉宽 / 不压扁 / 不裁切图片本体；放大到留空区能容纳的最大尺寸。
        var fitFrameToReserve = function (rect, areaW, nwArg, nhArg) {
          if (!rect) return;
          var maxW = Math.max(1, Math.round(areaW));
          var v = vp();
          var availableH = Math.max(1, Math.round(v.h - Math.max(0, rect.top)));
          var maxH = Math.max(1, Math.round(Math.min(Number(rect.height) || availableH, availableH)));
          // 翻页时新图还没进 imgRef，直接用手头这张图的实际尺寸重算。
          var nw = Number(nwArg) > 0 ? Number(nwArg) : 0;
          var nh = Number(nhArg) > 0 ? Number(nhArg) : 0;
          if (!(nw > 0 && nh > 0) && imgRef.current && imgRef.current.naturalWidth) {
            nw = Number(imgRef.current.naturalWidth);
            nh = Number(imgRef.current.naturalHeight);
          }
          var nat = naturalSizeRef.current;
          if (!(nw > 0 && nh > 0) && view && nat && nat.id === String(view.id)) {
            nw = Number(nat.w) || 0;
            nh = Number(nat.h) || 0;
          }
          if (!(nw > 0 && nh > 0)) {
            nw = Math.max(1, fw);
            nh = Math.max(1, fh);
          }
          var ratio = nw / nh;
          var scale = Math.min(maxW / nw, maxH / nh);
          if (!(scale > 0) || !isFinite(scale)) scale = 1;
          var tw = Math.max(1, Math.round(nw * scale));
          var th = Math.max(1, Math.round(nh * scale));
          if (th > 0) tw = Math.max(1, Math.round(th * ratio));
          if (tw > maxW) { tw = maxW; th = Math.max(1, Math.round(tw / ratio)); }
          if (th > maxH) { th = maxH; tw = Math.max(1, Math.round(th * ratio)); }
          // 留空宽度直接取图片框宽度：图片框和线贴在一起，整体靠左，左侧不再留空带。
          var reserveW = Math.max(1, Math.min(tw, maxW));
          setFrame({
            x: Math.max(0, Math.round(rect.left + reserveW - tw)),
            y: Math.max(0, Math.round(rect.top + maxH - th)),
            w: tw,
            h: th,
            reserveW: reserveW,
          }, true);
        };

        // 滚轮以光标为中心缩放；到最小 / 最大就停，不再改变尺寸。
        // 监听 window（不是图片框 DOM）：切会话 / 重挂图片框后不会丢监听。
        useEffect(function () {
          var onWheel = function (ev) {
            if (!openRef.current || hiddenRef.current) return;
            var el = frameRef.current;
            if (!el) return;
            var r = el.getBoundingClientRect();
            if (!r.width || !r.height) return;
            if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return;
            var overDockGrip = !!(ev.target && ev.target.closest && ev.target.closest(".ac-dockgrip"));
            if (!overDockGrip && ev.target && ev.target.closest && ev.target.closest("[data-ui]")) return;
            bumpPeek();
            ev.preventDefault();
            var ds = dockStateRef.current;
            if (ds.docked) {
              var maxDock = ds.dockRect ? Math.max(DOCK_MIN, Math.min(920, ds.dockRect.width - DOCK_MIN_CHAT - DOCK_GAP)) : DOCK_MIN;
              var nextDock = Math.max(DOCK_MIN, Math.min(maxDock, ds.dockW + (ev.deltaY > 0 ? -24 : 24)));
              if (nextDock !== ds.dockW) {
                setFrame({ dockW: nextDock }, false);
                if (wheelTimer.current) clearTimeout(wheelTimer.current);
                wheelTimer.current = setTimeout(function () { persistPrefs(); }, 260);
              }
              return;
            }
            var s = vp();
            var baseW2 = r.width;
            var baseH2 = r.height;
            var maxW2 = Math.max(1, s.w);
            var maxH2 = Math.max(1, s.h);
            var minW2 = Math.min(280, maxW2);
            var minH2 = Math.min(360, maxH2);
            var maxF = Math.min(maxW2 / baseW2, maxH2 / baseH2);
            var minRatio = Math.max(minW2 / baseW2, minH2 / baseH2);
            // 下限按“绝对像素”算：图片框再缩也不小于 280×360（或视口更小时的实际尺寸）。
            // 不能写死 0.45，否则每滚一次都在当前尺寸上再乘 0.45，会一路缩到看不见。
            var minF = Math.min(maxF, minRatio);
            if (minF > maxF) return;
            var raw = ev.deltaY > 0 ? 0.88 : 1.14;
            var factor = clamp(raw, minF, maxF);
            if (Math.abs(factor - 1) < 0.002) return;
            var nw = baseW2 * factor;
            var nh = baseH2 * factor;
            var rx = (ev.clientX - r.left) / baseW2;
            var ry = (ev.clientY - r.top) / baseH2;
            var nx = ev.clientX - rx * nw;
            var ny = ev.clientY - ry * nh;
            var patch = {
              x: clamp(nx, 0, Math.max(0, s.w - nw)),
              y: clamp(ny, 0, Math.max(0, s.h - nh)),
              w: nw, h: nh,
              // 滚轮是用户主动调尺寸，空白框也记住这个大小；图片自适应不写这里。
              emptyW: nw,
              emptyH: nh,
              // 用户自己定过尺寸：以后切图不再回退成按图自适应。
              userSized: true,
            };
            setFrame(patch, false);
            if (wheelTimer.current) clearTimeout(wheelTimer.current);
            wheelTimer.current = setTimeout(function () { persistPrefs(); }, 260);
          };
          try {
            if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
              window.addEventListener("wheel", onWheel, { passive: false });
            }
          } catch (e) { /* ignore */ }
          return function () {
            try {
              if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
                window.removeEventListener("wheel", onWheel);
              }
            } catch (e) { /* ignore */ }
            if (wheelTimer.current) clearTimeout(wheelTimer.current);
          };
        }, []);

        // 双指捏合缩放：和滚轮走同一条改框尺寸的路径，只是锚点换成两指中点，
        // 顺带支持捏合时两指一起平移。挂在 window 上（和滚轮一致），
        // 切会话 / 重挂图片框都不会丢监听。
        useEffect(function () {
          if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
          var dist2 = function (a, b) {
            var dx = a.clientX - b.clientX;
            var dy = a.clientY - b.clientY;
            return Math.sqrt(dx * dx + dy * dy);
          };
          var mid2 = function (a, b) {
            return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
          };
          var onTouchStart = function (ev) {
            if (!openRef.current || hiddenRef.current) return;
            // 单指还是原来的拖动；只有两根手指落在框里才当成捏合。
            if (!ev.touches || ev.touches.length !== 2) return;
            var el = frameRef.current;
            if (!el || !el.getBoundingClientRect) return;
            var r = el.getBoundingClientRect();
            if (!r.width || !r.height) return;
            var a = ev.touches[0];
            var b = ev.touches[1];
            var inside = function (p) {
              return p.clientX >= r.left && p.clientX <= r.right
                && p.clientY >= r.top && p.clientY <= r.bottom;
            };
            // 两指都在框里才接管；在框外双指缩放还能正常缩页面。
            if (!inside(a) || !inside(b)) return;
            if (ev.target && ev.target.closest && ev.target.closest("[data-ui]")) return;
            var d = dist2(a, b);
            if (!(d > 8)) return;
            // 捏合一开始就掐掉单指拖动，别让框跟着其中一根手指跑。
            if (dragRaf.current) { caf(dragRaf.current); dragRaf.current = 0; }
            dragPending.current = null;
            dragRef.current = null;
            setDragging(false);
            var ds = dockStateRef.current;
            var dr = ds.dockRect;
            var dm = dr ? Math.max(DOCK_MIN, Math.min(920, dr.width - DOCK_MIN_CHAT - DOCK_GAP)) : DOCK_MIN;
            var mid = mid2(a, b);
            pinchRef.current = {
              active: true,
              dist: d,
              midX: mid.x,
              midY: mid.y,
              w: r.width,
              h: r.height,
              x: r.left,
              y: r.top,
              docked: !!ds.docked,
              dockW: Number(ds.dockW) || 0,
              dockMax: dm,
            };
            bumpPeek();
          };
          var onTouchMove = function (ev) {
            var p = pinchRef.current;
            if (!p || !p.active) return;
            if (!ev.touches || ev.touches.length !== 2) return;
            var a = ev.touches[0];
            var b = ev.touches[1];
            var s = vp();
            var step = pinchFrameStep(p, a, b, s.w, s.h, DOCK_MIN);
            if (!step) return;
            // 双指手势到这一步还没被浏览器拿走，说明它归我们，先掐掉页面缩放 / 滚动。
            ev.preventDefault();
            if (step.docked) {
              if (step.dockW !== dockStateRef.current.dockW) setFrame({ dockW: step.dockW }, false);
            } else {
              if (Math.abs(step.factor - 1) < 0.002) return;
              setFrame({
                x: step.x,
                y: step.y,
                w: step.w, h: step.h,
                // 和滚轮一致：空白框也记住这个大小，用户自己定过尺寸后切图不再回退。
                emptyW: step.w,
                emptyH: step.h,
                userSized: true,
              }, false);
            }
            bumpPeek();
          };
          var onTouchEnd = function (ev) {
            var p = pinchRef.current;
            if (!p || !p.active) return;
            if (ev.touches && ev.touches.length >= 2) return;
            pinchRef.current = { active: false };
            // 捏合收尾后浏览器常补一个 click，别让它再触发「单击亮菜单」。
            suppressClick.current = Date.now();
            persistPrefs();
          };
          try {
            window.addEventListener("touchstart", onTouchStart, { passive: false });
            window.addEventListener("touchmove", onTouchMove, { passive: false });
            window.addEventListener("touchend", onTouchEnd, { passive: false });
            window.addEventListener("touchcancel", onTouchEnd, { passive: false });
          } catch (e) { /* 老浏览器不支持 passive 选项就退化成默认 */ }
          return function () {
            pinchRef.current = { active: false };
            try {
              window.removeEventListener("touchstart", onTouchStart);
              window.removeEventListener("touchmove", onTouchMove);
              window.removeEventListener("touchend", onTouchEnd);
              window.removeEventListener("touchcancel", onTouchEnd);
            } catch (e) { /* ignore */ }
          };
        }, []);

        useEffect(function () {
          if (!menuOpen) { setMenuClipped(false); return undefined; }
          var el = menuRef.current;
          if (!el) return undefined;
          var check = function () { setMenuClipped(el.scrollWidth - el.clientWidth > 2); };
          check();
          var ro = null;
          try {
            if (typeof ResizeObserver === "function") {
              ro = new ResizeObserver(check);
              ro.observe(el);
            }
          } catch (e) { /* ignore */ }
          if (typeof window !== "undefined") window.addEventListener("resize", check);
          return function () {
            try { if (ro) ro.disconnect(); } catch (e) { /* ignore */ }
            if (typeof window !== "undefined") window.removeEventListener("resize", check);
          };
        }, [menuOpen, drawW, drawH, imgs.length]);

        useEffect(function () {
          if (!subOpen || !menuOpen) { setSubPos(null); return undefined; }
          var calc = function () {
            var m = moreRef.current;
            var b = blRef.current;
            if (!m || !b) return;
            var mr = m.getBoundingClientRect();
            var br = b.getBoundingClientRect();
            setSubPos({
              left: Math.max(0, Math.round(mr.left - br.left)),
              bottom: Math.max(0, Math.round(br.bottom - mr.top + 8)),
            });
          };
          calc();
          var timer = setTimeout(calc, 0);
          if (typeof window !== "undefined") window.addEventListener("resize", calc);
          return function () {
            clearTimeout(timer);
            if (typeof window !== "undefined") window.removeEventListener("resize", calc);
          };
        }, [subOpen, menuOpen, drawW, drawH, menuClipped]);

        var expandAtBall = function () {
          var s = vp();
          var nx = clamp(bx + BALL_HALF - fw + COLLAPSE, 0, Math.max(0, s.w - fw));
          var ny = clamp(by + BALL_HALF - fh + COLLAPSE, 0, Math.max(0, s.h - fh));
          setFrame({ x: nx, y: ny, w: fw, h: fh }, true);
          setPref({ open: true });
          endPeek();
          setMenuOpen(false);
          setSubOpen(false);
          setNearAny(false);
          setNearBR(true);
          setSideNav("");
        };

        var collapse = function (atX, atY) {
          if (dockTimer.current) { clearTimeout(dockTimer.current); dockTimer.current = null; }
          var s = vp();
          var rect = frameRef.current && frameRef.current.getBoundingClientRect
            ? frameRef.current.getBoundingClientRect()
            : null;
          var direct = Number.isFinite(atX) && Number.isFinite(atY);
          var cx = direct ? atX : (rect && rect.width ? rect.right - COLLAPSE : fx + fw - COLLAPSE);
          var cy = direct ? atY : (rect && rect.height ? rect.bottom - COLLAPSE : fy + fh - COLLAPSE);
          setBall({
            x: clamp(cx - BALL_HALF, 0, s.w - BALL),
            y: clamp(cy - BALL_HALF, 0, s.h - BALL),
          }, true);
          setPref({ open: false, dock: "", reserve: "" });
          if (reserved) restoreReserveFrame();
          endPeek();
          setMenuOpen(false);
          setSubOpen(false);
          setNearAny(false);
          setNearBR(false);
          setSideNav("");
        };
        collapseRef.current = collapse;

        var onBallDown = function (e) {
          if (e.button !== undefined && e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch (e2) { /* ignore */ }
          dragRef.current = { kind: "ball", sx: e.clientX, sy: e.clientY, ox: bx, oy: by, moved: false };
          setDragging(true);
        };
        var onFrameDown = function (e) {
          if (dockTimer.current) { clearTimeout(dockTimer.current); dockTimer.current = null; }
          if (e.button !== undefined && e.button !== 0) return;
          // 捏合中的第二根手指不参与拖动；非触屏按下（说明捏合早就该结束了）顺手复位，
          // 免得一次没收尾的捏合把后面的拖动 / 单击全卡住。
          if (pinchRef.current.active) {
            if (e.pointerType === "touch" && !e.isPrimary) return;
            pinchRef.current = { active: false };
          }
          // 记下这次按下的起点是不是菜单按钮：落在菜单上就不算「单击图片框」。
          var onUi = !!(e.target && e.target.closest && e.target.closest("[data-ui]"));
          uiDownRef.current = onUi;
          bumpPeek();
          if (onUi) return;
          e.preventDefault();
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch (e2) { /* ignore */ }
          if (dockedActive) {
            // 停靠时先按下，真正拖动超过阈值才脱离停靠，避免单击误触。
            // 拖动脱开停靠时用“停靠前的浮动尺寸”，不能把停靠区的显示宽高写回 frame。
            dragRef.current = { kind: "frame", sx: e.clientX, sy: e.clientY, ox: drawX, oy: drawY, w: fw, h: fh, moved: false, undock: true, undocked: false };
          } else {
            dragRef.current = { kind: "frame", sx: e.clientX, sy: e.clientY, ox: fx, oy: fy, w: fw, h: fh, moved: false };
          }
          setDragging(true);
        };
        var raf = typeof requestAnimationFrame === "function"
          ? function (fn) { return requestAnimationFrame(fn); }
          : function (fn) { return setTimeout(fn, 16); };
        var caf = typeof cancelAnimationFrame === "function"
          ? function (id) { cancelAnimationFrame(id); }
          : function (id) { clearTimeout(id); };
        var flushDrag = function () {
          var p = dragPending.current;
          dragPending.current = null;
          if (!p) return;
          if (p.kind === "ball") setBall(p.patch, false);
          else setFrame(p.patch, false);
        };
        var onMove = function (e) {
          var d = dragRef.current;
          if (!d) return;
          if (pinchRef.current.active) return;
          var dx = e.clientX - d.sx;
          var dy = e.clientY - d.sy;
          if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
          if (d.undock && !d.undocked && d.moved) {
            d.undocked = true;
            setPref({ dock: "" });
            setFrame({ x: d.ox, y: d.oy, w: d.w, h: d.h }, false);
          }
          var s = vp();
          var patch;
          if (d.kind === "ball") {
            patch = { x: clamp(d.ox + dx, 0, s.w - BALL), y: clamp(d.oy + dy, 0, s.h - BALL) };
          } else {
            var dw = Number(d.w) || fw;
            var dh = Number(d.h) || fh;
            patch = {
              x: clamp(d.ox + dx, 0, Math.max(0, s.w - dw)),
              y: clamp(d.oy + dy, 0, Math.max(0, s.h - dh)),
              w: dw, h: dh,
              // 用户挪过框：别再让切图把它拉回按图自适应的尺寸。
              userSized: true,
            };
          }
          dragPending.current = { kind: d.kind, patch: patch };
          if (dragRaf.current) return;
          dragRaf.current = raf(function () {
            dragRaf.current = 0;
            flushDrag();
          });
        };
        var onUp = function () {
          if (dragRaf.current) {
            caf(dragRaf.current);
            dragRaf.current = 0;
          }
          flushDrag();
          var d = dragRef.current;
          if (!d) return;
          dragRef.current = null;
          setDragging(false);
          // 单击（按下后没拖动、不是捏合、不是点在菜单按钮上）= 短暂亮出所有菜单。
          // 放在 pointerup 上而不是 click：触屏上 pointerdown 被 preventDefault 后
          // click 不一定还来，pointerup 一定来。
          if (!d.moved && d.kind === "frame" && !uiDownRef.current && !pinchRef.current.active) {
            startPeek();
          }
          if (d.moved) {
            suppressClick.current = Date.now();
            persistPrefs();
          }
          var pending = pendingData.current;
          pendingData.current = null;
          if (pending) setData(pending);
          var pv = pendingView.current;
          pendingView.current = null;
          var fit = pendingFit.current;
          pendingFit.current = null;
          if (pv) {
            if (pv.nw > 0 && pv.nh > 0) fittedImgId.current = pv.target.id;
            setViewImg(pv.target);
            setViewSrc(pv.src || pv.target.url);
            setSwitching(false);
            if (pv.nw > 0 && pv.nh > 0) fitFrameToImage(pv.nw, pv.nh);
          } else if (fit) {
            setSwitching(false);
            fitFrameToImage(fit.nw, fit.nh);
          }
          if (pendingLoad.current) {
            pendingLoad.current = false;
            load();
          }
        };
        var onFrameMove = function (e) {
          bumpPeek();
          if (dragRef.current) return;
          var r = e.currentTarget.getBoundingClientRect();
          var x = e.clientX - r.left;
          var y = e.clientY - r.top;
          var nearAnyCorner = (x < 100 && y < 100)
            || (x > r.width - 100 && y < 100)
            || (x < 100 && y > r.height - 150)
            || (x > r.width - 100 && y > r.height - 100);
          setNearAny(nearAnyCorner);
          setNearBR(false);
          setSideNav(x < 80 ? "left" : x > r.width - 80 ? "right" : "");
        };
        var onFrameLeave = function () {
          setNearAny(false);
          setNearBR(false);
          setSideNav("");
        };

        useEffect(function () {
          var onSquare = function (ev) {
            setSquare(!!(ev && ev.detail && ev.detail.square));
          };
          try {
            if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
              window.addEventListener(SQUARE_EVENT, onSquare);
            }
          } catch (e) { /* ignore */ }
          return function () {
            try {
              if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
                window.removeEventListener(SQUARE_EVENT, onSquare);
              }
            } catch (e) { /* ignore */ }
          };
        }, []);

        useEffect(function () {
          var onCollapse = function (ev) {
            try {
              var detail = ev && ev.detail ? ev.detail : {};
              if (collapseRef.current) collapseRef.current(detail.x, detail.y);
            } catch (e) { /* ignore */ }
          };
          try {
            if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
              window.addEventListener(COLLAPSE_EVENT, onCollapse);
            }
          } catch (e) { /* ignore */ }
          return function () {
            try {
              if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
                window.removeEventListener(COLLAPSE_EVENT, onCollapse);
              }
            } catch (e) { /* ignore */ }
          };
        }, []);

        useEffect(function () {
          var onDockLeft = function (ev) {
            try { if (dockLeftHandlerRef.current) dockLeftHandlerRef.current(ev && ev.detail); } catch (e) { /* ignore */ }
          };
          var onReserveLeft = function (ev) {
            try { if (reserveLeftHandlerRef.current) reserveLeftHandlerRef.current(ev && ev.detail); } catch (e) { /* ignore */ }
          };
          try {
            if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
              window.addEventListener(DOCK_LEFT_EVENT, onDockLeft);
              window.addEventListener(RESERVE_LEFT_EVENT, onReserveLeft);
            }
          } catch (e) { /* ignore */ }
          return function () {
            try {
              if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
                window.removeEventListener(DOCK_LEFT_EVENT, onDockLeft);
                window.removeEventListener(RESERVE_LEFT_EVENT, onReserveLeft);
              }
            } catch (e) { /* ignore */ }
          };
        }, []);

        var toggleSquare = function () {
          var next = !square;
          setSquare(next);
          writeSquare(next);
        };

        useEffect(function () {
          return function () {
            if (dockTimer.current) { clearTimeout(dockTimer.current); dockTimer.current = null; }
            clearPeekTimer();
          };
        }, []);

        // 停靠左侧时给会话 body 留出宽度；只动 padding，不碰 DSH 的宽度算法。
        // 测量和“加 padding”分开：拖动右边框改 dockW 时只更新 padding，不反复摘挂属性。
        useEffect(function () {
          var body = conversationBody();
          if (!body || (!docked && !reserved) || !prefs.open) {
            setDockRect(null);
            return undefined;
          }
          var measure = function () {
            var r = body.getBoundingClientRect();
            setDockRect({ left: r.left, top: r.top, width: r.width, height: r.height });
          };
          measure();
          var ro = null;
          try {
            if (typeof ResizeObserver === "function") {
              ro = new ResizeObserver(measure);
              ro.observe(body);
            }
          } catch (e) { ro = null; }
          window.addEventListener("resize", measure);
          return function () {
            window.removeEventListener("resize", measure);
            if (ro) ro.disconnect();
            body.removeAttribute("data-airp-dock");
            body.style.removeProperty("--airp-dock-left");
            body.removeAttribute("data-airp-reserve");
            body.style.removeProperty("--airp-reserve-left");
          };
        }, [docked, reserved, prefs.open]);

        useEffect(function () {
          if (!docked || !prefs.open) return;
          var body = conversationBody();
          if (!body) return;
          var max = Math.max(0, Math.min(920, (dockRect ? dockRect.width : body.getBoundingClientRect().width) - DOCK_MIN_CHAT - DOCK_GAP));
          if (max < DOCK_MIN) {
            body.removeAttribute("data-airp-dock");
            body.style.removeProperty("--airp-dock-left");
            setPref({ dock: "" });
            return;
          }
          var w = Math.max(DOCK_MIN, Math.min(Number(frame.dockW) || defaultDockWidth(max), max));
          body.setAttribute("data-airp-dock", "left");
          body.style.setProperty("--airp-dock-left", (w + DOCK_GAP) + "px");
        }, [docked, prefs.open, frame.dockW, dockRect]);

        useEffect(function () {
          if (!reserved || !prefs.open) return;
          var body = conversationBody();
          if (!body) return;
          var max = reserveMaxWidth(body);
          if (max < RESERVE_MIN) {
            body.removeAttribute("data-airp-reserve");
            body.style.removeProperty("--airp-reserve-left");
            setPref({ reserve: "" });
            return;
          }
          var w = Math.max(1, Math.min(Number(frame.reserveW) || defaultReserveWidth(max), max));
          body.setAttribute("data-airp-reserve", "left");
          body.style.setProperty("--airp-reserve-left", (w + DOCK_GAP) + "px");
        }, [reserved, prefs.open, frame.reserveW, dockRect]);

        // 竖线像 DSH 自己的分栏线：光标靠近才显示，整根线高度都能按住拖。
        useEffect(function () {
          if (!reservedActive) {
            railNearRef.current = false;
            setRailNear(false);
            setRailDragging(false);
            setRailHint(false);
            return undefined;
          }
          var onMove = function (ev) {
            var r = railRectRef.current;
            var near = r.h > 0
              && Math.abs(ev.clientX - r.x) <= 16
              && ev.clientY >= r.y - 10
              && ev.clientY <= r.y + r.h + 10;
            if (near !== railNearRef.current) {
              railNearRef.current = near;
              setRailNear(near);
            }
          };
          var clear = function () {
            if (!railNearRef.current) return;
            railNearRef.current = false;
            setRailNear(false);
          };
          try {
            window.addEventListener("pointermove", onMove, { passive: true });
            document.addEventListener("pointerleave", clear);
          } catch (e) { /* ignore */ }
          return function () {
            try {
              window.removeEventListener("pointermove", onMove);
              document.removeEventListener("pointerleave", clear);
            } catch (e) { /* ignore */ }
          };
        }, [reservedActive]);

        var act = function (fn, label) {
          Promise.resolve().then(fn).then(function (r) {
            if (r && r.ok === false) showToast(r.reason || r.error || "失败", "err");
          }).catch(function (e) { showToast(label + "失败：" + (e.message || e), "err"); });
        };

        var captureCurrent = function () {
          if (live) return;
          var sourceCfg = (data && data.capture && data.capture.source) || (data && data.config && data.config.source) || {};
          var local = localSessionRef.current || {};
          var sessionId = local.sessionId || (data && data.activeSessionId) || "";
          var sessionTitle = local.title || (data && data.activeSessionTitle) || "";
          var followActive = sourceCfg.followActive !== false;
          if (!(followActive ? sessionId : sourceCfg.sessionId)) return showToast("先设置正文来源（设置 → 正文来源）", "err");
          // 手动「请求生成」不受自动出图开关影响：点它就是要图。
          var genNow = true;
          act(function () {
            return api.forwardSource({
              autoGenerate: genNow, continuous: contOn,
              ownerSessionId: sessionId,
              sessionId: followActive ? sessionId : (sourceCfg.sessionId || ""),
              sessionTitle: followActive ? sessionTitle : (sourceCfg.title || ""),
              // 图片框的「请求生成」：新图整套替换当前会话的旧图。
              replaceOld: genNow,
            }).then(function (r) {
              if (r && r.job && r.job.id) pendingShowJobRef.current = String(r.job.id);
              pendingKeepImageRef.current = false;
              showToast((genNow ? "已投递正文来源并出图（同一正文的旧图会在新图成功后进回收站）" : "已投递正文来源（只投递，不出图）") + (r.job ? "（" + shortId(r.job.id) + "）" : ""), "ok");
            });
          }, "投递");
        };
        var toggleAuto = function () {
          var next = !autoOn;
          setAutoOn(next);
          announceUiConfig({ autoOn: next });
          // A 是总开关：亮 = 自动投递正文 + 自动出图都开；划掉 = 不是全自动，点一下两项都开。
          api.saveConfig({ capture: { autoForward: next, autoGenerate: next } }).then(function () { return load(); }).catch(function (e) {
            setAutoOn(!next);
            announceUiConfig({ autoOn: !next });
            showToast("切换自动失败：" + (e.message || e), "err");
          });
        };
        var toggleContinuous = function () {
          var next = !contOn;
          setContOn(next);
          announceUiConfig({ contOn: next });
          showToast(next ? "连续图：开" : "连续图：关", next ? "ok" : "");
          api.saveConfig({ generation: { continuous: { on: next } } }).then(function () { return load(); }).catch(function (e) {
            setContOn(!next);
            announceUiConfig({ contOn: !next });
            showToast("切换连图失败：" + (e.message || e), "err");
          });
        };
        var generateLatest = function () {
          if (!job || !job.sets || !job.sets.length) return showToast("还没有可用的提示词（先投递一次）", "err");
          var local = localSessionRef.current || {};
          // 多窗口时 data.activeSessionId 是全局最后上报者，图片会归错聊天；优先本悬浮球所在会话。
          var sid = String(local.sessionId || (data && data.activeSessionId) || "");
          var title = String(local.title || (data && data.activeSessionTitle) || "");
          act(function () {
            return api.generate({ sets: job.sets, continuous: contOn, sessionId: sid, sessionTitle: title }).then(function () { showToast("已开始出图", "ok"); });
          }, "出图");
        };
        var runRegenFor = function (target, mode) {
          // 没有图片时仍允许「全部」用最近一轮的 job 重生成；「仅此图」必须有一张。
          var fallback = mode === "all" && job && job.id ? job : null;
          if (!target && !fallback) return showToast("当前没有图片可重新生成", "warn");
          var extra = String(regenText || "").trim();
          var imageId = String(target && target.id || "");
          var jobId = target && target.jobId ? target.jobId : (fallback ? fallback.id : "");
          var setId = target && target.setIndex !== null && target.setIndex !== undefined ? target.setIndex : null;
          setRegenOpen(false);
          setRegenText("");
          act(function () {
            return api.regenerate({
              imageId: imageId,
              jobId: jobId,
              setIndex: setId,
              continuous: contOn,
              sessionId: (localSessionRef.current && localSessionRef.current.sessionId) || (data && data.activeSessionId) || "",
              sessionTitle: (localSessionRef.current && localSessionRef.current.title) || (data && data.activeSessionTitle) || "",
              mode: mode === "all" ? "all" : "single",
              extra: extra,
            }).then(function (r) {
              if (r && r.job && r.job.id) pendingShowJobRef.current = String(r.job.id);
              // 仅此图 / 连续图整组替换：停在用户点的那张；本轮全部才去新组。
              pendingKeepImageRef.current = mode !== "all";
              var regenMode = r && r.job && r.job.regenMode;
              showToast(
                regenMode === "continuous"
                  ? "已提交：连续图整组替换（" + ((r.job.sets && r.job.sets.length) || 0) + " 张）"
                  : (mode === "all" ? "已提交：本轮图片全部替换" : "已提交：仅重生成当前这张"),
                "ok",
              );
            });
          }, "重新生成");
        };
        /**
         * 纯黑判定（纯函数，便于自检）：从缩放后的 RGBA 采样里算，三条同时满足才算黑：
         *   ① 暗像素（亮度 < 14）占比 ≥ 99.5%
         *   ② 平均亮度 ≤ 8
         *   ③ 亮点（亮度 > 110）占比 < 0.1%
         * 只满足 ① 会误伤夜景 / 黑底小主体——之前就是这么误判的。
         * 另外要求不透明像素覆盖 ≥ 50%：透明底的小图不是“黑图”，是透明图。
         */
        function judgeNearlyBlack(d) {
          var pixels = d.length / 4;
          var opaque = 0;
          var dark = 0;
          var bright = 0;
          var lumSum = 0;
          for (var i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 16) continue; // 透明像素不算
            opaque += 1;
            var lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
            lumSum += lum;
            if (lum < 14) dark += 1;
            else if (lum > 110) bright += 1;
          }
          var darkRatio = opaque ? dark / opaque : 0;
          var brightRatio = opaque ? bright / opaque : 0;
          var meanLum = opaque ? lumSum / opaque : 0;
          var coverage = pixels ? opaque / pixels : 0;
          var black = opaque >= 8 && coverage >= 0.5
            && darkRatio >= 0.995 && meanLum <= 8 && brightRatio < 0.001;
          return { black: black, darkRatio: darkRatio, brightRatio: brightRatio, meanLum: meanLum, coverage: coverage, opaque: opaque };
        }
        // 纯黑图 PNG 压缩后极小（832×1216 的真黑图 ≈ 25 KB），超过这个体积不可能是纯黑。
        // 这条是硬保险：就算画布绘制 / 解码出了岔子，也不会把一张有内容的图当成黑图。
        var BLACK_MAX_BYTES = 120000;
        // 返回 judgeNearlyBlack 的统计对象；bust=true 时加个 nc 参数绕过浏览器缓存（确认二次判定用）。
        var isNearlyBlack = function (url, bust) {
          return new Promise(function (resolve) {
            if (!url || typeof document === "undefined" || typeof Image === "undefined") return resolve({ black: false });
            var probe = new Image();
            probe.onload = function () {
              try {
                if (!probe.naturalWidth || !probe.naturalHeight) return resolve({ black: false });
                var w = Math.max(1, Math.min(256, probe.naturalWidth));
                var h = Math.max(1, Math.min(256, probe.naturalHeight));
                var canvas = document.createElement("canvas");
                canvas.width = w;
                canvas.height = h;
                var g = canvas.getContext("2d");
                if (!g) return resolve({ black: false });
                g.drawImage(probe, 0, 0, w, h);
                var d = g.getImageData(0, 0, w, h).data;
                resolve(judgeNearlyBlack(d));
              } catch (e) { resolve({ black: false }); }
            };
            probe.onerror = function () { resolve({ black: false }); };
            probe.src = url + (bust ? (url.indexOf("?") >= 0 ? "&" : "?") + "nc=" + Date.now() : "");
          });
        };
        // 判定入口：先看体积，再验像素；判黑要**两次都黑**才算数（第二次绕过缓存）。
        var probeBlackImage = function (im) {
          var url = im && im.url ? String(im.url) : "";
          var bytes = im && im.bytes ? Number(im.bytes) : 0;
          if (!url) return Promise.resolve({ black: false, skipped: "no-url" });
          if (bytes > BLACK_MAX_BYTES) return Promise.resolve({ black: false, skipped: "bytes", bytes: bytes, url: url });
          return isNearlyBlack(url).then(function (first) {
            if (!first.black) return { black: false, stats: first, url: url, bytes: bytes };
            return new Promise(function (resolve) { setTimeout(resolve, 900); })
              .then(function () { return isNearlyBlack(url, true); })
              .then(function (second) {
                return { black: !!second.black, stats: second, first: first, url: url, bytes: bytes, confirmed: true };
              });
          });
        };
        // 把判定结果写进 Host 日志（日志页可见），误判时能直接看到当时的统计。
        var reportBlackCheck = function (im, verdict) {
          try {
            var s = verdict && verdict.stats ? verdict.stats : {};
            api.blackCheck({
              imageId: im && im.id ? String(im.id) : "",
              fileName: im && im.fileName ? String(im.fileName) : "",
              bytes: verdict && verdict.bytes ? verdict.bytes : (im && im.bytes) || 0,
              black: !!(verdict && verdict.black),
              skipped: (verdict && verdict.skipped) || "",
              darkRatio: s.darkRatio, meanLum: s.meanLum, brightRatio: s.brightRatio, coverage: s.coverage,
            }).catch(function () { /* 诊断日志失败不影响主流程 */ });
          } catch (e) { /* ignore */ }
        };
        var blackQueueRef = useRef([]);
        // 自动补图可以随时叫停：队列清空 + 正在跑的那单 abort，并且这一轮不再自动补。
        // blackStopRef 在下一轮新任务完成时复位，避免「点过一次停止后就再也不补」。
        var blackStopRef = useRef(false);
        var blackJobRef = useRef("");
        var syncBlackPending = function () {
          setBlackPendingGlobal(blackQueueRef.current.length + (blackBusyRef.current ? 1 : 0));
        };
        var stopBlack = function () {
          blackStopRef.current = true;
          blackQueueRef.current = [];
          var jid = blackJobRef.current;
          blackJobRef.current = "";
          syncBlackPending();
          showToast("已停止自动补图", "ok");
          if (jid) api.abort(jid).catch(function () { /* 任务可能已经结束了 */ });
        };
        // 面板上的「停止自动补图」通过这个入口回调过来。
        useEffect(function () {
          BLACK_UI.stop = stopBlack;
          return function () { if (BLACK_UI.stop === stopBlack) BLACK_UI.stop = null; };
        }, []);
        /** 同一张图（同一套提示词）跨多次自动换种子仍用同一个 key，用来限制最多补几次。 */
        var blackSlotKey = function (sourceJob, im) {
          var sets = Array.isArray(sourceJob && sourceJob.sets) ? sourceJob.sets : [];
          var idx = im && im.setIndex !== null && im.setIndex !== undefined && Number.isFinite(Number(im.setIndex))
            ? Number(im.setIndex) : 0;
          var set = sets[idx] || sets[0] || {};
          var sig = set.anchor || set.title || String(set.positive || "").slice(0, 80) || String(im && im.title || "");
          return [
            sourceJob && (sourceJob.ownerSessionId || sourceJob.sourceSessionId) || "",
            sourceJob && sourceJob.sourceSeq !== null && sourceJob.sourceSeq !== undefined ? sourceJob.sourceSeq : "",
            sig,
          ].join("|");
        };
        var enqueueBlack = function (im, sourceJob, attempt, key, label) {
          if (!im || !im.id || !im.url) return;
          if (blackStopRef.current) return;
          blackQueueRef.current.push({
            id: String(im.id), jobId: im.jobId || (sourceJob && sourceJob.id) || "",
            setIndex: im.setIndex, url: im.url, bytes: im.bytes || 0,
            attempt: attempt || 1, key: key || "", label: label || "",
          });
          syncBlackPending();
        };
        var drainBlackQueue = function () {
          if (blackBusyRef.current) return;
          var next = blackQueueRef.current.shift();
          if (!next) { syncBlackPending(); return; }
          if (blackStopRef.current) { blackQueueRef.current = []; syncBlackPending(); return; }
          blackBusyRef.current = true;
          syncBlackPending();
          probeBlackImage(next).then(function (verdict) {
            reportBlackCheck(next, verdict);
            if (!verdict.black) return null;
            if (next.attempt === 1) {
              var nk = String(next.jobId || next.id || "");
              if (!blackNotifiedRef.current.has(nk)) {
                blackNotifiedRef.current.add(nk);
                notify("检测到纯黑图，正在自动替换", "warn");
              }
            }
            showToast("检测到纯黑图，正在自动重新生成" + (next.label || "")
              + (next.attempt > 1 ? "（第 " + next.attempt + " 次）" : ""), "warn");
            // 黑图补图是原地替换同一张图片，不把图片框跳到“新任务”的那张。
            return api.regenerate({
              imageId: next.id,
              jobId: next.jobId || "",
              setIndex: next.setIndex,
              mode: "auto",
              sessionId: data && data.activeSessionId || "",
              sessionTitle: data && data.activeSessionTitle || "",
            }).then(function (r) {
              blackJobRef.current = r && r.job && r.job.id ? String(r.job.id) : "";
              return r;
            });
          }).catch(function () { /* 黑图重生成失败不阻塞其它图 */ }).then(function () {
            blackBusyRef.current = false;
            blackJobRef.current = "";
            syncBlackPending();
            drainBlackQueue();
          });
        };
        var checkBlackImages = function (sourceJob) {
          if (!sourceJob || sourceJob.status !== "done") return;
          // 工作流页「图片输出相关 → 黑图自动替换」关掉就整个不检测（连已在队列里的也清掉）。
          if (data && data.activeWorkflow && data.activeWorkflow.blackRetry === false) {
            if (blackQueueRef.current.length || blackBusyRef.current) {
              blackQueueRef.current = [];
              syncBlackPending();
            }
            return;
          }
          // 只处理刚完成的这一轮；翻旧记录 / 重启页面不追溯历史图。
          var finished = Date.parse(sourceJob.finishedAt || "");
          if (!Number.isFinite(finished) || Date.now() - finished > 120000) return;
          // 新一轮（非自动补图）开始时解除上一次的「停止」，否则停过一次就再也不会补了。
          if (sourceJob.regenMode !== "auto") blackStopRef.current = false;

          if (sourceJob.regenMode === "auto") {
            // 自动补图后继续检查：仍然黑就再换种子，最多 BLACK_MAX_RETRIES 次。
            var jobKey = String(sourceJob.id || "");
            if (!jobKey || blackCheckedJobsRef.current.has(jobKey)) return;
            blackCheckedJobsRef.current.add(jobKey);
            var retried = (sourceJob.images || [])[0];
            if (!retried || !retried.id || !retried.url) return;
            var slotKey = blackSlotKey(sourceJob, retried);
            var attempt = Math.max(1, Number(blackRetryRef.current[slotKey]) || 1);
            probeBlackImage(retried).then(function (verdict) {
              reportBlackCheck(retried, verdict);
              if (!verdict.black) {
                delete blackRetryRef.current[slotKey];
                notify("黑图已替换为正常图", "ok");
                // 替换已经落到图片上、也确认不是黑图了，最后再报出图完成。
                notify("出图完成", "ok");
                return;
              }
              if (attempt >= BLACK_MAX_RETRIES) {
                notify("黑图连续 " + BLACK_MAX_RETRIES + " 次仍是纯黑，已停止自动替换；可换种子或检查工作流", "warn");
                return;
              }
              var nextAttempt = attempt + 1;
              blackRetryRef.current[slotKey] = nextAttempt;
              showToast("第 " + attempt + " 次替换仍是黑图，继续第 " + nextAttempt + " 次", "warn");
              enqueueBlack(retried, sourceJob, nextAttempt, slotKey,
                "「" + String((sourceJob.sets && sourceJob.sets[0] && sourceJob.sets[0].title) || "当前图") + "」");
              drainBlackQueue();
            });
            return;
          }

          var list = Array.isArray(sourceJob.images) ? sourceJob.images : [];
          list.forEach(function (im, i) {
            if (!im || !im.id || im.recycled || blackTriedRef.current.has(String(im.id))) return;
            blackTriedRef.current.add(String(im.id));
            var key = blackSlotKey(sourceJob, im);
            blackRetryRef.current[key] = 1;
            enqueueBlack(im, sourceJob, 1, key, "第 " + (i + 1) + " 张");
          });
          drainBlackQueue();
        };
        var stopJob = function () {
          // 图片框左下菜单的「终止」就是真正的终止：黑图补图是 internal 任务，
          // 一起停掉（清队列 + 中止正在跑的那单），否则点了终止它还在后台接着补。
          if (blackQueueRef.current.length || blackBusyRef.current) {
            stopBlack();
            return;
          }
          if (!job || !job.id) return;
          act(function () {
            return api.abort(job.id).then(function () { showToast("已终止", "ok"); });
          }, "终止");
        };
        var toggleFav = function () {
          if (!img) return;
          if (!viewSynced) return showToast("图片切换中，请稍候", "warn");
          act(function () {
            return (img.favorited ? api.unfavorite(img.id) : api.favorite(img.id)).then(function () {
              showToast(img.favorited ? "已取消收藏" : "已收藏", "ok");
            });
          }, "收藏");
        };
        var recycle = function () {
          if (!img) return;
          if (!viewSynced) return showToast("图片切换中，请稍候", "warn");
          if (recycleGuard.current) return showToast("这张图正在删除，请稍候", "warn");
          recycleGuard.current = true;
          setRecycleBusy(true);
          // 删除后优先停在下一张（更新），没有下一张再退回上一张（更早）；
          // 不按旧下标直接回最新。
          var target = imgs[safeIdx + 1] || imgs[safeIdx - 1] || null;
          recycleImage(img.id).then(function (r) {
            var removed = !(r && (r.already || r.duplicate));
            if (removed) {
              preferImgId.current = target ? String(target.id) : "";
            }
            showToast(recycleNotice(r), r && (r.already || r.duplicate) ? "warn" : "ok");
            return load();
          }).catch(function (e) {
            preferImgId.current = "";
            showToast("删除失败：" + (e.message || e), "err");
          }).finally(function () {
            recycleGuard.current = false;
            setRecycleBusy(false);
          });
        };
        var goOlder = function () {
          if (safeIdx <= 0) return;
          if (followOn || pointerFollow) followPause();
          fitAnchorRef.current = "left";
          var next = Math.max(0, safeIdx - 1);
          imgIdRef.current = imgs[next] ? String(imgs[next].id || "") : "";
          setIdx(next);
        };
        var goNewer = function () {
          if (safeIdx >= imgs.length - 1) return;
          if (followOn || pointerFollow) followPause();
          fitAnchorRef.current = "right";
          var next = Math.min(imgs.length - 1, safeIdx + 1);
          imgIdRef.current = imgs[next] ? String(imgs[next].id || "") : "";
          setIdx(next);
        };
        var toggleFollow = function () {
          var next = !followOn;
          var nextPrefs = Object.assign({}, prefs, { follow: next });
          setFollowOn(next);
          setPref({ follow: next });
          announceFloatPrefs(nextPrefs);
          followPauseKey.current = "";
          if (followTimer.current) { clearTimeout(followTimer.current); followTimer.current = null; }
          followTimerDue.current = 0;
          showToast("跟随滚动：" + (next ? "开" : "关"), next ? "ok" : "warn");
          if (next) followQueue(0);
        };

        var togglePointerFollow = function () {
          var next = !pointerFollow;
          var nextPrefs = Object.assign({}, prefs, { pointerFollow: next });
          setPointerFollow(next);
          setPref({ pointerFollow: next });
          announceFloatPrefs(nextPrefs);
          followPauseKey.current = "";
          pointerYRef.current = null;
          if (pointerTimer.current) { clearTimeout(pointerTimer.current); pointerTimer.current = null; }
          pointerLastAt.current = 0;
          showToast("光标跟随：" + (next ? "开（鼠标在正文里移动时切图）" : "关"), next ? "ok" : "warn");
          if (next) followQueue(0);
        };

        var debugOn = prefs.debug === true;
        var toggleDebug = function () {
          var next = !debugOn;
          var nextPrefs = Object.assign({}, prefs, { debug: next });
          setPref({ debug: next });
          announceFloatPrefs(nextPrefs);
          followStatsRef.current = { samples: 0, switches: 0, lastAt: 0, lastGap: 0, gapSum: 0, lastReason: "" };
          showToast("跟图调试：" + (next ? "开（中线 + 区域 + 采样）" : "关"), next ? "ok" : "warn");
          if (next) followQueue(0);
        };

        /** 一键清空当前会话图片的原文锚点；之后跟图回退到「按当前会话区域比例分配」。 */
        var clearAnchors = function () {
          var local = localSessionRef.current || {};
          var sid = String(local.sessionId || (data && data.activeSessionId) || "");
          if (!sid) return showToast("没有当前会话，无法清空定位", "err");
          var title = String(local.title || (data && data.activeSessionTitle) || "");
          try {
            if (typeof window !== "undefined" && typeof window.confirm === "function"
              && !window.confirm("清空当前会话所有图片的原文锚点？\n\n其它会话不受影响；清空后会按当前会话区域比例平均分配，仍会自动切图。")) return;
          } catch (e) { /* ignore */ }
          api.clearAnchors({ sessionId: sid, sessionTitle: title }).then(function (r) {
            followSeenRef.current = {};
            followMatchRef.current = { key: "", list: [] };
            followGroupRef.current = { key: "", groups: [] };
            followCacheRef.current = { key: "", len: -1, text: "", segs: [] };
            followPauseKey.current = "";
            dataSig.current = "";
            load(true);
            showToast("已清空当前会话 " + (Number(r && r.images) || 0) + " 张图的定位，改为按比例分配", "ok");
          }).catch(function (e) {
            showToast("清空定位失败：" + (e.message || e), "err");
          });
        };

        var closeSidePanels = function () {          var changed = false;
          try {
            var layout = clientCtx && (clientCtx.layout || (clientCtx.get && clientCtx.get("layout")));
            var leftCollapsed = false;
            try {
              leftCollapsed = !!document.querySelector('[data-sidebar-collapsed]');
            } catch (e2) { leftCollapsed = false; }
            if (!leftCollapsed && layout && typeof layout.toggleSidebar === "function") {
              layout.toggleSidebar();
              changed = true;
            }
          } catch (e) { /* ignore */ }
          try {
            var sr = clientCtx && (clientCtx.sidebarRight || (clientCtx.get && clientCtx.get("sidebarRight")));
            if (sr && typeof sr.isExpanded === "function" && sr.isExpanded() && typeof sr.toggleExpanded === "function") {
              sr.toggleExpanded();
              changed = true;
            }
          } catch (e) { /* ignore */ }
          return changed;
        };

        var toggleDockLeft = function () {
          if (docked) {
            if (dockTimer.current) { clearTimeout(dockTimer.current); dockTimer.current = null; }
            setPref({ dock: "" });
            return;
          }
          if (dockTimer.current) {
            clearTimeout(dockTimer.current);
            dockTimer.current = null;
            return;
          }
          var body = conversationBody();
          if (!body) return showToast("找不到会话区域，暂时不能停靠", "err");
          // 先收起左右两侧面板，等宽度让出来后再判断剩余空间并停靠。
          var waited = closeSidePanels();
          var doDock = function () {
            dockTimer.current = null;
            var nowBody = conversationBody();
            if (!nowBody) return showToast("找不到会话区域，暂时不能停靠", "err");
            var max = dockMaxWidth(nowBody);
            if (max < DOCK_MIN) return showToast("窗口太窄，停靠后正文不够宽", "err");
            // 从“左侧留空”切到停靠时，先把留空前的浮动尺寸还回去，
            // 否则关闭 / 拖回来后图片框会沿用留空时的大尺寸。
            if (reserved) restoreReserveFrame();
            var want = Number(frame.dockW) > 0 ? Number(frame.dockW) : defaultDockWidth(max);
            setFrame({ dockW: Math.max(DOCK_MIN, Math.min(want, max)) }, true);
            setPref({ dock: "left", reserve: "", open: true });
          };
          if (waited) dockTimer.current = setTimeout(doDock, 280);
          else doDock();
        };

        // 退出“左侧留空”时尽量把图片框还原到点按钮前的尺寸 / 位置。
        var restoreReserveFrame = function () {
          var prev = reservePrevFrame.current;
          reservePrevFrame.current = null;
          if (prev && prev.w > 0 && prev.h > 0) setFrame(prev, true);
        };

        // 测试功能：图片框保持普通图片框，只在会话左侧留空；激活时先收起左右侧栏，
        // 再把图片框放到留空区域里最大并右对齐，方便用户直接看到右侧的分隔线。
        var toggleReserveLeft = function () {
          if (reserved) {
            if (dockTimer.current) { clearTimeout(dockTimer.current); dockTimer.current = null; }
            setRailHint(false);
            if (railHintTimer.current) { clearTimeout(railHintTimer.current); railHintTimer.current = null; }
            setPref({ reserve: "" });
            restoreReserveFrame();
            return;
          }
          if (dockTimer.current) {
            clearTimeout(dockTimer.current);
            dockTimer.current = null;
            return;
          }
          var waited = closeSidePanels();
          var rescueTries = 0;
          var doReserve = function () {
            dockTimer.current = null;
            var body = conversationBody();
            if (!body) {
              if (waited && rescueTries < 6) {
                rescueTries += 1;
                dockTimer.current = setTimeout(doReserve, 160);
                return;
              }
              return showToast("找不到会话区域，暂时不能悬浮", "err");
            }
            var rect = body.getBoundingClientRect();
            var max = reserveMaxWidth(body);
            var v = vp();
            var availableH = Math.min(Number(rect.height) || 0, v.h - Math.max(0, rect.top));
            if ((max < RESERVE_MIN || availableH < RESERVE_MIN_H) && waited && rescueTries < 6) {
              // 左右侧栏收起有动画 / 布局延迟时，等宽度真正让出来再量一次。
              rescueTries += 1;
              dockTimer.current = setTimeout(doReserve, 160);
              return;
            }
            if (max < RESERVE_MIN) return showToast("窗口太窄，悬浮后正文不够宽", "err");
            if (availableH < RESERVE_MIN_H) return showToast("窗口太矮，放不下最大图片框", "err");
            // 图片框按原比例放到最大、贴着左侧；留空宽度取图片框宽度，
            // 这样图片框和分隔线都在左边，不会在左侧留一条空带。
            var prevRect = frameRef.current && frameRef.current.getBoundingClientRect
              ? frameRef.current.getBoundingClientRect() : null;
            if (!dockedActive && prevRect && prevRect.width > 0 && prevRect.height > 0) {
              reservePrevFrame.current = { x: prevRect.left, y: prevRect.top, w: prevRect.width, h: prevRect.height };
            }
            setPref({ reserve: "left", dock: "", open: true });
            fitFrameToReserve(rect, max);
            flashRailHint();
          };
          if (waited) dockTimer.current = setTimeout(doReserve, 280);
          else doReserve();
        };

        var handleDockLeftRequest = function (detail) {
          // 全屏看图打开时要求把左侧停靠 / 留空一起清掉，否则会话左边会一直空着。
          if (detail && detail.dock === false) {
            if (dockTimer.current) { clearTimeout(dockTimer.current); dockTimer.current = null; }
            if (reserved) restoreReserveFrame();
            if (docked || reserved) setPref({ dock: "", reserve: "" });
            setRailHint(false);
            return;
          }
          var id = detail && detail.imageId ? String(detail.imageId) : "";
          if (id) {
            if (followOn || pointerFollow) followPause();
            preferImgId.current = id;
            jumpNewest.current = false;
            var at = -1;
            for (var i = 0; i < imgs.length; i += 1) {
              if (String(imgs[i].id || "") === id) { at = i; break; }
            }
            if (at >= 0) { imgIdRef.current = id; setIdx(at); }
          }
          var start = function () {
            if (reserved) restoreReserveFrame();
            setPref({ open: true, dock: "left", reserve: "" });
            if (id) load(true).catch(function () { /* ignore */ });
          };
          if (dockTimer.current) { clearTimeout(dockTimer.current); dockTimer.current = null; }
          if (closeSidePanels()) dockTimer.current = setTimeout(start, 280);
          else start();
        };
        dockLeftHandlerRef.current = handleDockLeftRequest;

        var handleReserveLeftRequest = function (detail) {
          if (reserved) return;
          var id = detail && detail.imageId ? String(detail.imageId) : "";
          if (id) {
            if (followOn || pointerFollow) followPause();
            preferImgId.current = id;
            jumpNewest.current = false;
            var at = -1;
            for (var i = 0; i < imgs.length; i += 1) {
              if (String(imgs[i].id || "") === id) { at = i; break; }
            }
            if (at >= 0) { imgIdRef.current = id; setIdx(at); }
          }
          setPref({ open: true });
          if (id) load(true).catch(function () { /* ignore */ });
          toggleReserveLeft();
        };
        reserveLeftHandlerRef.current = handleReserveLeftRequest;

        var onDockGripDown = function (e) {
          if (!dockedActive) return;
          if (e.button !== undefined && e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch (e2) { /* ignore */ }
          dockDrag.current = { sx: e.clientX, start: dockW, last: dockW };
        };
        var onDockGripMove = function (e) {
          var d = dockDrag.current;
          if (!d) return;
          if (e.currentTarget.hasPointerCapture && !e.currentTarget.hasPointerCapture(e.pointerId)) return;
          e.preventDefault();
          e.stopPropagation();
          var max = dockRect ? Math.max(DOCK_MIN, Math.min(920, dockRect.width - DOCK_MIN_CHAT - DOCK_GAP)) : DOCK_MIN;
          var next = Math.max(DOCK_MIN, Math.min(max, d.start + (e.clientX - d.sx)));
          d.last = next;
          setFrame({ dockW: next }, false);
        };
        var onDockGripUp = function (e) {
          var d = dockDrag.current;
          if (!d) return;
          e.preventDefault();
          e.stopPropagation();
          dockDrag.current = null;
          setFrame({ dockW: d.last }, true);
        };

        var onRailDown = function (e) {
          if (!reservedActive) return;
          if (e.button !== undefined && e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch (e2) { /* ignore */ }
          reserveDrag.current = { sx: e.clientX, start: reserveW, last: reserveW };
          setRailDragging(true);
        };
        var onRailMove = function (e) {
          var d = reserveDrag.current;
          if (!d) return;
          if (e.currentTarget.hasPointerCapture && !e.currentTarget.hasPointerCapture(e.pointerId)) return;
          e.preventDefault();
          e.stopPropagation();
          var max = dockRect ? Math.max(RESERVE_MIN, Math.min(RESERVE_MAX, dockRect.width - RESERVE_MIN_CHAT - DOCK_GAP)) : RESERVE_MIN;
          var next = Math.max(RESERVE_MIN, Math.min(max, d.start + (e.clientX - d.sx)));
          d.last = next;
          setFrame({ reserveW: next }, false);
        };
        var onRailUp = function (e) {
          var d = reserveDrag.current;
          if (!d) return;
          e.preventDefault();
          e.stopPropagation();
          reserveDrag.current = null;
          setRailDragging(false);
          setFrame({ reserveW: d.last }, true);
        };

        // peek 期间四角一起亮：单击图片框就能看到所有入口，不用先把鼠标挪到角上。
        var showBL = nearAny || menuOpen || peek;
        var showBR = nearAny || nearBR || peek;
        var showTR = nearAny || peek;
        var showTL = nearAny || peek;
        var openSidebarFull = function () {
          var shown = view || img || null;
          var id = shown && shown.id ? String(shown.id) : "";
          // 去右侧栏看图就退出悬浮于左侧，别再给会话保留左边的空位。
          if (reserved) {
            setRailHint(false);
            if (railHintTimer.current) { clearTimeout(railHintTimer.current); railHintTimer.current = null; }
            setPref({ reserve: "" });
            restoreReserveFrame();
          }
          pendingFullOpen = { id: id, image: shown, at: Date.now() };
          // 先让右侧栏展开并切到 ComfyRP；BridgePanel 没挂载时，挂载后会读 pendingFullOpen。
          try {
            var sr = null;
            try { sr = clientCtx && (clientCtx.sidebarRight || (clientCtx.get && clientCtx.get("sidebarRight"))); } catch (e) { sr = null; }
            if (sr) {
              var active = null;
              try { active = typeof sr.active === "function" ? sr.active() : null; } catch (e2) { active = null; }
              if (!active || active.kind !== TAB_KIND) {
                try {
                  if (typeof sr.openTab === "function") sr.openTab(TAB_KIND, { revealIfOpened: true });
                } catch (e3) { /* 宿主版本不支持就只发事件 */ }
              }
              try {
                if (typeof sr.isExpanded === "function" && !sr.isExpanded() && typeof sr.toggleExpanded === "function") {
                  sr.toggleExpanded();
                }
              } catch (e4) { /* ignore */ }
            }
          } catch (e3) { /* ignore */ }
          var fire = function () {
            try {
              if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
              var ev;
              if (typeof window.CustomEvent === "function") {
                ev = new window.CustomEvent(FULL_OPEN_EVENT, { detail: { imageId: id, image: shown } });
              } else if (typeof document !== "undefined" && typeof document.createEvent === "function") {
                ev = document.createEvent("CustomEvent");
                ev.initCustomEvent(FULL_OPEN_EVENT, false, false, { imageId: id, image: shown });
              } else return;
              window.dispatchEvent(ev);
            } catch (e4) { /* ignore */ }
          };
          fire();
          setTimeout(fire, 90);
          setTimeout(fire, 320);
        };
        var ballTitle = "ComfyRP" + (img ? "：" + (img.fileName || "") : "；点开图片框");

        var noticeLayer = notices.length
          ? withPortal(h("div", { className: "ac-globaltoaststack" }, notices.map(function (n) {
            return h("div", { key: n.id, className: cls("ac-toast", n.tone) }, n.text);
          })))
          : null;
        if (hidden && !(debugOn && (prefs.open || fullOpen))) return noticeLayer;
        var followOffsetPct = ((followOffset + 200) / 400) * 100;
        var root = h("div", {
          className: cls("ac-ballroot", hidden && debugOn && (prefs.open || fullOpen) && "ac-debug-only"),
          style: { zIndex: prefs.pinned === false ? 9999 : 2147482000 },
          onPointerMove: onMove,
          onPointerUp: onUp,
          onPointerCancel: onUp,
        },
          !prefs.open ? h("div", {
            className: "ac-ball",
            style: { left: bx, top: by },
            title: ballTitle,
            role: "button",
            "aria-label": ballTitle,
            onPointerDown: onBallDown,
            onClick: function () {
              if (suppressClick.current && Date.now() - suppressClick.current < 350) return;
              expandAtBall();
            },
          },
            h(PaletteGlyph, { size: 25 }),
          ) : null,

          debugOn && (prefs.open || fullOpen) ? h("div", { className: "ac-followline", ref: followLineRef },
            h("span", { className: "ac-followtag", ref: followLineTagRef }, "跟图调试：等待采样…"),
          ) : null,
          debugOn && (prefs.open || fullOpen) ? h("div", { className: "ac-followline ac-followline-offset", ref: followLine2Ref },
            h("span", { className: "ac-followtag", ref: followLine2TagRef }, "偏移基线"),
          ) : null,
          debugOn && (prefs.open || fullOpen) ? h("div", { className: "ac-followhud", ref: followHudRef }, "跟图调试：等待采样…") : null,
          debugOn && (prefs.open || fullOpen) ? h("div", { className: "ac-followoffset", "data-ui": "1", title: "往上拖 = 提前触发原文锚点；0 = 不偏移" },
            h("b", null, "手动偏移"),
            h("div", {
              className: "ac-followoffset-track",
              "data-ui": "1",
              onPointerDown: function (e) {
                e.preventDefault();
                e.stopPropagation();
                followOffsetDrag.current = true;
                try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
                applyFollowOffsetFromY(e.clientY, e.currentTarget);
              },
              onPointerMove: function (e) {
                if (!followOffsetDrag.current) return;
                e.preventDefault();
                e.stopPropagation();
                applyFollowOffsetFromY(e.clientY, e.currentTarget);
              },
              onPointerUp: function (e) {
                followOffsetDrag.current = false;
                try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
              },
              onPointerCancel: function () { followOffsetDrag.current = false; },
            },
              h("div", {
                className: "ac-followoffset-fill",
                style: {
                  top: Math.min(50, followOffsetPct) + "%",
                  height: Math.abs(followOffsetPct - 50) + "%",
                },
              }),
              h("div", { className: "ac-followoffset-mid" }),
              h("div", { className: "ac-followoffset-thumb", style: { top: followOffsetPct + "%" } }),
            ),
            h("span", { className: "ac-followoffset-v" }, (followOffset > 0 ? "+" : "") + followOffset + "px"),
            h("button", { type: "button", onClick: function () { changeFollowOffset(0); } }, "归零"),
            h("span", { style: { color: "#7f98ad", fontSize: "9px" } }, "上=提前"),
          ) : null,

          prefs.open ? h("div", {
            ref: frameRef,
            className: cls("ac-frame", dragging && "dragging", dockedActive && "docked", reservedActive && "reserved", square && "square"),
            style: { left: 0, top: 0, width: drawW, height: drawH, transform: "translate3d(" + drawX + "px," + drawY + "px,0)" },
            onPointerDown: onFrameDown,
            onPointerMove: onFrameMove,
            onPointerLeave: onFrameLeave,
            onDoubleClick: function (e) {
              if (suppressClick.current && Date.now() - suppressClick.current < 350) return;
              if (e.target && e.target.closest && e.target.closest("[data-ui]")) return;
              // 双击图片框收回到悬浮球；看大图走右上角的侧栏按钮。
              collapse(e.clientX, e.clientY);
            },
          },
            h("div", { className: "ac-stage" },
              view ? h("img", {
                ref: imgRef, src: viewSrc || view.url, alt: view.fileName || "", draggable: false,
                decoding: "async",
                onLoad: function (e) {
                  // 同一张图刷新 state 不重置用户滚轮缩放；但框比例和图片比例
                  // 对不上时（切图 / 布局变化后）必须补一次自适应。
                  if (!view) return;
                  var nw = Number(e.currentTarget.naturalWidth) || 0;
                  var nh = Number(e.currentTarget.naturalHeight) || 0;
                  if (!(nw > 0 && nh > 0)) return;
                  var frameRatio = fw / Math.max(1, fh);
                  var imgRatio = nw / nh;
                  if (fittedImgId.current === view.id && Math.abs(frameRatio - imgRatio) <= 0.01) return;
                  fittedImgId.current = view.id;
                  // 拖动中图片刚好加载完：先别改框，等松手再贴比例，避免拖到一半跳一下。
                  if (dragRef.current) {
                    pendingFit.current = { nw: nw, nh: nh };
                    return;
                  }
                  fitFrameToImage(nw, nh);
                },
              })
                : h("div", { className: "ac-stage-empty" },
                  h("span", null, "暂无图片"),
                  h("span", { className: "ac-empty-hint" }, "（滚轮缩放大小）"),
                ),
            ),

            imgs.length
              ? h("div", { className: cls("ac-counter", counterVisible && "show") }, (safeIdx + 1) + "/" + imgs.length)
              : null,

            switching
              ? h("div", { className: "ac-frameloading" }, h("span", { className: "ac-spinner" }), h("span", null, "加载中…"))
              : null,

            imgs.length > 1 ? h(React.Fragment, null,
              h("button", {
                className: cls("ac-sidenav left", sideNav === "left" && "show", safeIdx <= 0 && "is-disabled"),
                type: "button", title: "上一张（往期）", "aria-label": "上一张（往期）",
                "data-ui": "1", "aria-disabled": safeIdx <= 0,
                onClick: function (e) { e.stopPropagation(); if (safeIdx > 0) goOlder(); },
                onDoubleClick: function (e) { e.stopPropagation(); },
              }, h(Ico, { name: "chevL", size: 27 })),
              h("button", {
                className: cls("ac-sidenav right", sideNav === "right" && "show", safeIdx >= imgs.length - 1 && "is-disabled"),
                type: "button", title: "下一张（更新）", "aria-label": "下一张（更新）",
                "data-ui": "1", "aria-disabled": safeIdx >= imgs.length - 1,
                onClick: function (e) { e.stopPropagation(); if (safeIdx < imgs.length - 1) goNewer(); },
                onDoubleClick: function (e) { e.stopPropagation(); },
              }, h(Ico, { name: "chevR", size: 27 })),
            ) : null,

            dockedActive ? h("div", {
              className: "ac-dockgrip", "data-ui": "1", title: "拖动调整停靠宽度",
              onPointerDown: onDockGripDown,
              onPointerMove: onDockGripMove,
              onPointerUp: onDockGripUp,
              onPointerCancel: onDockGripUp,
            }) : null,

            h(FrameTools, {
              show: showBL,
              live: live,
              hasJob: !!job,
              hasImage: !!img,
              regenOpen: regenOpen,
              regenText: regenText,
              onToggleRegen: function () { setSubOpen(false); setRegenOpen(function (v) { return !v; }); bumpPeek(); },
              onRegenText: setRegenText,
              onRegenSingle: function () { runRegenFor(img, "single"); },
              onRegenAll: function () { runRegenFor(img, "all"); },
              autoOn: autoOn,
              contOn: contOn,
              square: square,
              followOn: followOn,
              onToggleFollow: toggleFollow,
              pointerFollow: pointerFollow,
              onTogglePointer: togglePointerFollow,
              debug: debugOn,
              onToggleDebug: toggleDebug,
              onClearAnchors: clearAnchors,
              onToggleSquare: toggleSquare,
              menuOpen: menuOpen,
              subOpen: subOpen,
              menuClipped: menuClipped,
              subPos: subPos,
              blRef: blRef,
              menuRef: menuRef,
              moreRef: moreRef,
              onToggleMenu: function () {
                var next = !menuOpen;
                setSubOpen(false);
                setRegenOpen(false);
                setMenuOpen(next);
                // 手动把菜单关掉 = 立刻收手，不等 5 秒；开着就继续续命。
                if (!next) endPeek();
                else bumpPeek();
              },
              onToggleSub: function () { setSubPos(null); setRegenOpen(false); setSubOpen(function (v) { return !v; }); bumpPeek(); },
              onCapture: captureCurrent,
              onStop: stopJob,
              onContinuous: toggleContinuous,
              onAuto: toggleAuto,
              onDelete: recycle,
              onDownload: function () { if (img) window.open(withDownload(img.url), "_blank"); },
              onFav: toggleFav,
              onRefresh: function () {
                // 真正重拉：先丢掉当前显示的图，再强制取状态；删除过的图不会
                // 因为旧 viewImg / job.images 兜底留在框里。
                dataSig.current = "";
                fittedImgId.current = "";
                setSwitching(false);
                setViewImg(null);
                setViewSrc("");
                setViewTick(function (v) { return v + 1; });
                load(true).then(function (s) {
                  flashCounter();
                  showToast(s ? "已刷新" : "刷新失败：宿主没响应", s ? "ok" : "err");
                });
              },
              deleteDisabled: !img || !viewSynced || switching || recycleBusy,
              deleteTitle: switching ? "加载中…" : recycleBusy ? "正在删除…" : "删除",
              downloadDisabled: !img || !viewSynced || switching,
              favDisabled: !img || !viewSynced || switching,
              favorited: !!(img && img.favorited),
            }),

            h("div", { className: cls("ac-tl", showTL && "show"), "data-ui": "1" },
              h("button", {
                className: cls("ac-round ac-glass", docked && "on"), type: "button",
                title: docked ? "取消固定于左侧" : "固定于左侧（会话让位）",
                "aria-label": docked ? "取消固定于左侧" : "固定于左侧",
                onClick: function (e) { e.stopPropagation(); toggleDockLeft(); },
              }, h(Ico, { name: "sidebarL", size: 15 })),
              h("button", {
                className: cls("ac-round ac-glass", reserved && "on"), type: "button",
                title: reserved ? "取消悬浮于左侧" : "悬浮于左侧（只挪会话，不动图片框）",
                "aria-label": reserved ? "取消悬浮于左侧" : "悬浮于左侧",
                onClick: function (e) { e.stopPropagation(); toggleReserveLeft(); },
              }, h(Ico, { name: "leftrail", size: 15 })),
            ),

            h("div", { className: cls("ac-tr", showTR && "show"), "data-ui": "1" },
              h("button", {
                className: "ac-round ac-glass", type: "button", title: "右侧栏看图",
                "aria-label": "右侧栏看图",
                // 没有图片也允许先打开右侧栏；全屏里会显示空图提示。
                disabled: false,
                onClick: function (e) { e.stopPropagation(); openSidebarFull(); },
              }, h(Ico, { name: "sidebarR", size: 15 })),
            ),

            h("div", { className: cls("ac-br", showBR && "show"), "data-ui": "1" },
              h("button", {
                className: "ac-round ac-glass", type: "button", title: "收起图片框",
                onClick: function (e) { e.stopPropagation(); collapse(); },
              }, h(Ico, { name: "chevD", size: 15 })),
            ),

            toasts.length
              ? h("div", { className: "ac-frametoaststack" }, toasts.map(function (t) {
                return h("div", { key: t.id, className: "ac-frametoast" }, t.text);
              }))
              : null,
          ) : null,

          reservedActive ? h("div", {
            className: cls("ac-leftrail", (railNear || railDragging || railHint) && "show"),
            "data-ui": "1",
            title: (railNear || railDragging || railHint) ? "拖动调整悬浮宽度" : "",
            style: { left: railX, top: railTop, height: railHeight },
            onPointerDown: onRailDown,
            onPointerMove: onRailMove,
            onPointerUp: onRailUp,
            onPointerCancel: onRailUp,
            onDoubleClick: function (e) { e.stopPropagation(); },
          }, h("span", { className: "ac-railline", style: { top: railLineTop, height: railLineH } })) : null,
        );
        return noticeLayer ? h(React.Fragment, null, noticeLayer, root) : root;
      }

      /* ===================================================================
       * 会话上报（conversation.input.dock，隐形）
       * =================================================================== */
      function SessionReporter(props) {
        var sid = props && props.sessionId;
        var title = props && props.title ? props.title : "";
        useEffect(function () {
          if (!sid) return;
          var fire = function (resolvedTitle) {
            try {
              if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
                var ev;
                var detail = { sessionId: String(sid), title: String(resolvedTitle || title || "") };
                if (typeof CustomEvent === "function") ev = new CustomEvent(SESSION_EVENT, { detail: detail });
                else if (typeof document !== "undefined" && document.createEvent) {
                  ev = document.createEvent("CustomEvent");
                  ev.initCustomEvent(SESSION_EVENT, false, false, detail);
                }
                if (ev) window.dispatchEvent(ev);
              }
            } catch (e) { /* ignore */ }
          };
          fire();
          // 后端可能在 sessionId 上报时补查了标题；回填事件时用返回的标题，
          // 否则概览会一直拿着空标题显示 session-xxxx。
          api.setActive(sid, title).then(function (r) {
            if (r && r.title) {
              fire(r.title);
              return null;
            }
            // 旧 Host / 空标题时再自己查一次会话列表；至少把界面显示补上。
            return api.sessions("mode=local&limit=200").then(function (list) {
              var hit = (list.sessions || []).find(function (s) { return s.sessionId === sid; });
              var found = hit ? (hit.title || hit.displayTitle || "") : "";
              if (!found) {
                fire();
                return null;
              }
              return api.setActive(sid, found).then(function () { fire(found); });
            }).catch(function () { fire(); });
          }).catch(function () { fire(); });
        }, [sid, title]);
        return null;
      }

      /* ===================================================================
       * 主面板
       * =================================================================== */
      function BridgePanel(props) {
        // initialState 只用于离线深渲染测试；正常运行不传，靠 /api/state + SSE。
        var boot = props && props.initialState ? props.initialState : null;
        var [state, setState] = useState(boot);
        var [jobs, setJobs] = useState(boot ? boot.jobs || [] : []);
        var [images, setImages] = useState(boot ? boot.images || [] : []);
        var [logs, setLogs] = useState(boot ? boot.logs || [] : []);
        var [page, setPageState] = useState(function () {
          try {
            var saved = localStorage.getItem(LS_PAGE) || "dashboard";
            return saved === "favorites" ? "images" : saved;
          } catch (e) { return "dashboard"; }
        });
        var [toasts, setToasts] = useState([]);
        var [conn, setConn] = useState(true);
        // 自动补图是 FloatBall 在跑，这里只订阅「还有几个在补」用来显示停止条。
        var blackPending = useBlackPending();
        var [viewer, setViewer] = useState(null);
        // 切到右侧栏其它标签时 BridgePanel 会卸载；memory 让回来时还在同一张图。
        var bootSession = props && typeof props.sessionId === "string" ? props.sessionId : "";
        var restoreRight = !!(rightViewMemory.open
          && (!rightViewMemory.sessionId || !bootSession || rightViewMemory.sessionId === bootSession));
        var [fullImage, setFullImage] = useState(restoreRight);
        var [fullIdx, setFullIdx] = useState(restoreRight ? rightViewMemory.idx : 0);
        var [fullList, setFullList] = useState(restoreRight ? rightViewMemory.list : []);
        var [fullLoading, setFullLoading] = useState(false);
        var [fullSrc, setFullSrc] = useState({ key: "", src: "" });
        var [fullBroken, setFullBroken] = useState(false);
        var [fullRetry, setFullRetry] = useState(0);
        var [fullCloseNear, setFullCloseNear] = useState(false);
        var [fullBLNear, setFullBLNear] = useState(false);
        var [fullTLNear, setFullTLNear] = useState(false);
        var [fullSide, setFullSide] = useState("");
        var [fullMenuOpen, setFullMenuOpen] = useState(false);
        var [fullSubOpen, setFullSubOpen] = useState(false);
        var [regenOpen, setRegenOpen] = useState(false);
        var [regenText, setRegenText] = useState("");
        var [fullMenuClipped, setFullMenuClipped] = useState(false);
        var [fullSubPos, setFullSubPos] = useState(null);
        var [fullAutoOn, setFullAutoOn] = useState(false);
        var [fullContOn, setFullContOn] = useState(false);
        var [fullRecycleBusy, setFullRecycleBusy] = useState(false);
        var [fullListReady, setFullListReady] = useState(restoreRight ? rightViewMemory.listReady : false);
        var [fullCounterVisible, setFullCounterVisible] = useState(false);
        var [theme, setTheme] = useState(loadTheme);
        var [floatHidden, setFloatHiddenState] = useState(readFloatHidden);
        var [square, setSquare] = useState(readSquare);
        var [floatPrefs, setFloatPrefs] = useState(loadFloatPrefs);
        var floatHiddenBeforeFull = useRef(false);
        // 挂载前悬浮框已经点了「右侧栏看图」：pendingFullOpen 是这次明确的目标，
        // 必须压过 rightViewMemory 里上一次全屏的页码。
        var bootPending = pendingFullOpen && Date.now() - pendingFullOpen.at < 15000 ? pendingFullOpen : null;
        // pending 丢了也不怕：悬浮框最后显示的那张图就是这次要看的图（同会话才用）。
        var bootFrameOk = !!(lastFrameView && lastFrameView.id
          && (!lastFrameView.sessionId || !props.sessionId || String(lastFrameView.sessionId) === String(props.sessionId)));
        var bootWantedId = String((bootPending && bootPending.id)
          || (bootFrameOk ? lastFrameView.id : "")
          || (restoreRight ? rightViewMemory.imageId : "") || "");
        // 锚点 = 用户明确要看的那张图。渲染层优先认它，页码 / 列表只是缓存。
        // 约定：任何一次「换页」（打开、翻页、跟图切图、删除后移、新任务回最新）
        // 都要同步改 fullAnchorIdRef，否则页面会和页码 / 删除目标对不上。
        // fullWantId 只是在「列表还没拉回来」这段时间先顶住目标，拉完就清空。
        var fullWantId = useRef(bootWantedId);
        var fullAnchorIdRef = useRef(bootWantedId);
        var bootWantedImageRef = useRef(bootPending && bootPending.image
          ? bootPending.image
          : (bootFrameOk ? lastFrameView : null));
        var fullImagesRef = useRef([]);
        // 刚打开 / 刚恢复全屏的一小段时间内忽略悬浮框跟图回流，
        // 避免它按主会话滚动位置把页面立刻拉回最新。
        var fullOpenedAtRef = useRef(restoreRight ? Date.now() : 0);
        var fullCounterTimer = useRef(null);
        var liveJobIdSeen = useRef("");
        var fullBlRef = useRef(null);
        var fullMenuRef = useRef(null);
        var fullMoreRef = useRef(null);
        var fullRecycleGuard = useRef(false);
        var toastTimers = useRef({});
        var toastSeq = useRef(0);
        var activeIdRef = useRef("");
        var lastActiveRef = useRef("");
        var refreshSeq = useRef(0);
        var configQueue = useRef(Promise.resolve());
        var configGeneration = useRef(0);
        if (restoreRight) floatHiddenBeforeFull.current = !!rightViewMemory.hiddenBefore;

        // 从右侧栏图片切到别的会话、又回到 ComfyRP 时：不恢复旧会话的图，
        // 同时把当初藏起来的悬浮球恢复回来，避免整页没有入口。
        useEffect(function () {
          if (restoreRight || !rightViewMemory.open || !bootSession) return;
          if (!rightViewMemory.sessionId || rightViewMemory.sessionId === bootSession) return;
          var hiddenBefore = !!rightViewMemory.hiddenBefore;
          rightViewMemory.open = false;
          rightViewMemory.sessionId = "";
          rightViewMemory.imageId = "";
          rightViewMemory.idx = 0;
          rightViewMemory.list = [];
          rightViewMemory.listReady = false;
          saveRightViewMemory();
          writeFloatHidden(hiddenBefore);
          setFloatHiddenState(hiddenBefore);
        }, []);

        // 恢复右侧栏图片时，悬浮球也应当是藏着的；关闭时再按 hiddenBefore 恢复。
        useEffect(function () {
          if (!restoreRight || floatHidden) return;
          writeFloatHidden(true);
          setFloatHiddenState(true);
        }, []);

        useEffect(function () {
          if (!restoreRight) return;
          // 恢复全屏时先告诉悬浮框「停在这张」并暂停当前滚动区间，
          // 否则它那边一开全屏就跟图采样，会把页面拉回最新一张。
          var fromList = rightViewMemory.list && rightViewMemory.list[rightViewMemory.idx];
          var id = String(fullWantId.current || rightViewMemory.imageId || (fromList && fromList.id) || "");
          if (id) emitFullNav(id, true);
        }, []);

        useEffect(function () {
          var onSquare = function (ev) {
            setSquare(!!(ev && ev.detail && ev.detail.square));
          };
          try {
            if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
              window.addEventListener(SQUARE_EVENT, onSquare);
            }
          } catch (e) { /* ignore */ }
          return function () {
            try {
              if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
                window.removeEventListener(SQUARE_EVENT, onSquare);
              }
            } catch (e) { /* ignore */ }
          };
        }, []);

        var toggleSquare = function () {
          var next = !square;
          setSquare(next);
          writeSquare(next);
        };

        var showToast = function (text, tone) {
          var id = (toastSeq.current += 1);
          setToasts(function (old) {
            return old.concat([{ id: id, text: String(text), tone: tone || "" }]).slice(-4);
          });
          toastTimers.current[id] = setTimeout(function () {
            delete toastTimers.current[id];
            setToasts(function (old) { return old.filter(function (t) { return t.id !== id; }); });
          }, 2100);
        };
        useEffect(function () {
          return function () {
            Object.keys(toastTimers.current).forEach(function (id) { clearTimeout(toastTimers.current[id]); });
            toastTimers.current = {};
          };
        }, []);

        // 全屏菜单和图片框共用开关：任一处的跟随 / 光标 / 调试 / 自动 / 连图都同步。
        useEffect(function () {
          var onPrefs = function (ev) {
            var next = ev && ev.detail && ev.detail.prefs;
            if (next && typeof next === "object") setFloatPrefs(normalizeFloatPrefs(next));
          };
          var onUiConfig = function (ev) {
            var d = ev && ev.detail && typeof ev.detail === "object" ? ev.detail : {};
            if (typeof d.autoOn === "boolean") setFullAutoOn(d.autoOn);
            if (typeof d.contOn === "boolean") setFullContOn(d.contOn);
          };
          try {
            if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
              window.addEventListener(PREFS_EVENT, onPrefs);
              window.addEventListener(UI_CONFIG_EVENT, onUiConfig);
            }
          } catch (e) { /* ignore */ }
          return function () {
            try {
              if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
                window.removeEventListener(PREFS_EVENT, onPrefs);
                window.removeEventListener(UI_CONFIG_EVENT, onUiConfig);
              }
            } catch (e) { /* ignore */ }
          };
        }, []);

        var patchFloatPref = function (patch) {
          var next = Object.assign({}, loadFloatPrefs(), patch || {});
          saveFloatPrefs(next);
          setFloatPrefs(normalizeFloatPrefs(next));
          announceFloatPrefs(next);
        };
        var fullToggleFollow = function () {
          var next = !(floatPrefs.follow !== false);
          patchFloatPref({ follow: next });
          showToast("跟随滚动：" + (next ? "开" : "关"), next ? "ok" : "warn");
        };
        var fullTogglePointerFollow = function () {
          var next = floatPrefs.pointerFollow !== true;
          patchFloatPref({ pointerFollow: next });
          showToast("光标跟随：" + (next ? "开（鼠标在正文里移动时切图）" : "关"), next ? "ok" : "warn");
        };
        var fullToggleDebug = function () {
          var next = floatPrefs.debug !== true;
          patchFloatPref({ debug: next });
          showToast("跟图调试：" + (next ? "开（中线 + 区域 + 采样）" : "关"), next ? "ok" : "warn");
        };
        var fullClearAnchors = function () {
          var sid = String(activeId || "");
          if (!sid) return showToast("没有当前会话，无法清空定位", "err");
          try {
            if (typeof window !== "undefined" && typeof window.confirm === "function"
              && !window.confirm("清空当前会话所有图片的原文锚点？\n\n其它会话不受影响；清空后会按当前会话区域比例平均分配，仍会自动切图。")) return;
          } catch (e) { /* ignore */ }
          api.clearAnchors({
            sessionId: sid,
            sessionTitle: String((state && state.activeSessionTitle) || ""),
          }).then(function (r) {
            showToast("已清空当前会话 " + (Number(r && r.images) || 0) + " 张图的定位，改为按比例分配", "ok");
            return refresh();
          }).catch(function (e) {
            showToast("清空定位失败：" + (e.message || e), "err");
          });
        };

        var toggleTheme = function () {
          var next = theme === "light" ? "dark" : "light";
          setTheme(next);
          saveTheme(next);
          showToast(next === "light" ? "已切换到日间模式" : "已切换到夜间模式", "ok");
        };

        var toggleFloatBall = function () {
          var next = !floatHidden;
          writeFloatHidden(next);
          setFloatHiddenState(next);
          showToast(next ? "已隐藏悬浮球" : "已显示悬浮球", "ok");
        };

        var openFullImage = function (startId, startImage) {
          // 进入右侧栏全屏前先解除左侧停靠 / 留空，避免会话左边一直空着。
          try {
            if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
              var undock;
              if (typeof CustomEvent === "function") undock = new CustomEvent(DOCK_LEFT_EVENT, { detail: { dock: false } });
              else if (typeof document !== "undefined" && document.createEvent) {
                undock = document.createEvent("CustomEvent");
                undock.initCustomEvent(DOCK_LEFT_EVENT, false, false, { dock: false });
              }
              if (undock) window.dispatchEvent(undock);
            }
          } catch (e) { /* ignore */ }
          var wanted = startId ? String(startId) : "";
          // 明确目标优先于 later 的列表刷新；直到用户自己翻页 / 关闭 / 出新任务才解除。
          if (wanted) {
            fullAnchorIdRef.current = wanted;
            if (startImage && String(startImage.id || "") === wanted) bootWantedImageRef.current = startImage;
          } else {
            fullAnchorIdRef.current = "";
            bootWantedImageRef.current = null;
          }
          // 重复事件（悬浮球会补发几次）只调整到同一张，不重新隐藏 / 重载。
          if (fullImage && wanted) {
            for (var k = 0; k < fullList.length; k += 1) {
              if (String(fullList[k].id || "") === wanted) {
                // 完整列表还没回来时先保留目标，等真正加载完再按 id 校正，避免被重复事件清掉。
                fullWantId.current = fullListReady ? "" : wanted;
                setFullIdx(k);
                pendingFullOpen = null;
                // 打开 / 重复打开都先暂停当前滚动区间的跟图，避免刚落位又被滚到底切到最新。
                emitFullNav(wanted, true);
                return;
              }
            }
            // 当前列表里没有目标，但调用方明确给了这张图（悬浮框 / 左侧停靠点的
            // 「右侧栏看图」）：先用它顶住当前页，再异步重拉完整列表，绝不跳最新。
            // 放在 !fullListReady 之前：列表请求刚完成但 React 还没重渲染时，
            // fullListReady 仍是 false，此时不能只记目标等一个不会发生的刷新。
            var targetImg = startImage && startImage.id && String(startImage.id) === wanted ? startImage : null;
            if (targetImg) {
              fullWantId.current = wanted;
              setFullList([targetImg]);
              setFullIdx(0);
              setFullListReady(false);
              pendingFullOpen = null;
              emitFullNav(wanted, true);
              setTimeout(function () {
                reloadFullList(wanted, targetImg).catch(function () { /* 保留本地这张 */ });
              }, 0);
              return;
            }
            // 只有 id、没有图：列表还没回来就记住目标，等加载完校正。
            if (!fullListReady) {
              fullWantId.current = wanted;
              pendingFullOpen = null;
              emitFullNav(wanted, true);
              return;
            }
            // 连图都没给：保持当前页，不跳回最新。
            fullWantId.current = "";
            pendingFullOpen = null;
            return;
          }
          fullWantId.current = wanted;
          // 从悬浮球进来时先拿当前这张顶着，完整列表回来后再校正页码；
          // 这样看旧图点全屏不会先闪一下最新图。
          var seed = startImage && startImage.id && (!wanted || String(startImage.id) === wanted) ? startImage : null;
          // 已经全屏时不要用「现在已隐藏」覆盖进入前的状态，否则退出后悬浮球不回来。
          if (!fullImage) {
            floatHiddenBeforeFull.current = floatHidden;
            rightViewMemory.hiddenBefore = !!floatHidden;
            fullOpenedAtRef.current = Date.now();
            setFullListReady(false);
          }
          if (!floatHidden) {
            writeFloatHidden(true);
            setFloatHiddenState(true);
          }
          var baseList = seed ? [seed] : (images && images.length ? images : ((liveJob && liveJob.images) || []));
          var at = 0;
          if (wanted) {
            for (var i = 0; i < baseList.length; i += 1) {
              if (String(baseList[i].id || "") === wanted) { at = i; break; }
            }
          }
          setFullIdx(at);
          setFullList(baseList.slice(0, 200));
          setFullBroken(false);
          setFullLoading(true);
          setFullCloseNear(false);
          setFullBLNear(false);
          setFullTLNear(false);
          setFullSide("");
          setFullMenuOpen(false);
          setFullSubOpen(false);
          setFullImage(true);
          pendingFullOpen = null;
          emitFullNav((baseList[at] && baseList[at].id) || wanted || "", !!wanted);
        };

        var closeFullImage = function () {
          setFullImage(false);
          setFullCloseNear(false);
          setFullBLNear(false);
          setFullTLNear(false);
          setFullSide("");
          setFullMenuOpen(false);
          setFullSubOpen(false);
          setFullListReady(false);
          setFullCounterVisible(false);
          if (fullCounterTimer.current) { clearTimeout(fullCounterTimer.current); fullCounterTimer.current = null; }
          fullWantId.current = "";
          fullAnchorIdRef.current = "";
          bootWantedImageRef.current = null;
          // 用户自己关掉后，右侧栏的图片记忆也清掉；下次打开还是按当前图重新来。
          rightViewMemory.open = false;
          rightViewMemory.sessionId = "";
          rightViewMemory.imageId = "";
          rightViewMemory.idx = 0;
          rightViewMemory.list = [];
          rightViewMemory.listReady = false;
          rightViewMemory.hiddenBefore = false;
          saveRightViewMemory();
          if (!floatHiddenBeforeFull.current) {
            writeFloatHidden(false);
            setFloatHiddenState(false);
          }
        };

        var collapseFullToBall = function (e) {
          closeFullImage();
          // 右侧栏图片双击：退出全屏并收起成悬浮球（而不是回到图片框）。
          writeFloatHidden(false);
          setFloatHiddenState(false);
          try {
            if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
              var ev;
              var detail = e && Number.isFinite(e.clientX) && Number.isFinite(e.clientY)
                ? { x: e.clientX, y: e.clientY } : null;
              if (typeof CustomEvent === "function") ev = new CustomEvent(COLLAPSE_EVENT, { detail: detail });
              else if (typeof document !== "undefined" && document.createEvent) {
                ev = document.createEvent("CustomEvent");
                ev.initCustomEvent(COLLAPSE_EVENT, false, false, detail);
              }
              if (ev) window.dispatchEvent(ev);
            }
          } catch (e2) { /* ignore */ }
        };

        var dockLeftFromFull = function (item) {
          closeFullImage();
          writeFloatHidden(false);
          setFloatHiddenState(false);
          try {
            if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
              var ev;
              var detail = { imageId: item && item.id ? String(item.id) : "", image: item || null };
              if (typeof CustomEvent === "function") ev = new CustomEvent(DOCK_LEFT_EVENT, { detail: detail });
              else if (typeof document !== "undefined" && document.createEvent) {
                ev = document.createEvent("CustomEvent");
                ev.initCustomEvent(DOCK_LEFT_EVENT, false, false, detail);
              }
              if (ev) window.dispatchEvent(ev);
            }
          } catch (e) { /* ignore */ }
        };

        var refresh = function () {
          var seq = (refreshSeq.current += 1);
          return api.state().then(function (s) {
            if (seq !== refreshSeq.current) return s;
            setState(s);
            setJobs(s.jobs || []);
            setImages(s.images || []);
            setLogs(s.logs || []);
            setConn(true);
            return s;
          }).catch(function (e) {
            if (seq === refreshSeq.current) setConn(false);
            throw e;
          });
        };

        useEffect(function () {
          refresh().catch(function () { /* SSE 会重试 */ });
        }, []);

        useEffect(function () {
          var onSession = function (ev) {
            var detail = ev && ev.detail ? ev.detail : {};
            var sid = detail.sessionId ? String(detail.sessionId) : "";
            if (!sid) return;
            setState(function (old) {
              return old ? Object.assign({}, old, { activeSessionId: sid, activeSessionTitle: detail.title || "" }) : old;
            });
            refresh().catch(function () { /* ignore */ });
          };
          try {
            if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
              window.addEventListener(SESSION_EVENT, onSession);
            }
          } catch (e) { /* ignore */ }
          return function () {
            try {
              if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
                window.removeEventListener(SESSION_EVENT, onSession);
              }
            } catch (e) { /* ignore */ }
          };
        }, []);

        useEffect(function () {
          var es;
          var lost = false;
          try {
            es = new EventSource(API + "/events");
          } catch (e) {
            setConn(false);
            return undefined;
          }
          es.addEventListener("job", function (ev) {
            try {
              var job = JSON.parse(ev.data);
              var aid = activeIdRef.current;
              if (aid && job.sourceSessionId && job.targetSessionId
                && job.sourceSessionId !== aid && job.targetSessionId !== aid && job.ownerSessionId !== aid) return;
              setJobs(function (old) {
                var next = old.filter(function (j) { return j.id !== job.id; });
                next.unshift(job);
                return next.slice(0, 40);
              });
            } catch (e) { /* ignore */ }
          });
          es.addEventListener("image", function (ev) {
            try {
              var img = JSON.parse(ev.data);
              var aid = activeIdRef.current;
              if (aid && img.sessionId && img.sessionId !== aid) return;
              var imgId = String(img.id || "");
              var imgDead = !!(img.recycled || img.deletedAt);
              // 原地替换会复用同一个 id。先看它在当前全屏列表里的位置：
              // 已知的 id 只更新原位置，不能像新图一样插到最前面。
              var knownAt = -1;
              var cur = fullImagesRef.current || [];
              for (var ci = 0; ci < cur.length; ci += 1) {
                if (String(cur[ci].id || "") === imgId) { knownAt = ci; break; }
              }
              setImages(function (old) {
                var at = -1;
                for (var i = 0; i < old.length; i += 1) {
                  if (String(old[i].id || "") === imgId) { at = i; break; }
                }
                if (imgDead) return old.filter(function (x) { return String(x.id || "") !== imgId; }).slice(0, 80);
                if (at >= 0) {
                  var replaced = old.slice();
                  replaced[at] = Object.assign({}, old[at], img);
                  return replaced;
                }
                return [img].concat(old).slice(0, 80);
              });
              setFullList(function (old) {
                var at = -1;
                for (var i = 0; i < old.length; i += 1) {
                  if (String(old[i].id || "") === imgId) { at = i; break; }
                }
                if (imgDead) return old.filter(function (x) { return String(x.id || "") !== imgId; });
                if (at >= 0) {
                  var replaced = old.slice();
                  replaced[at] = Object.assign({}, old[at], img);
                  return replaced;
                }
                if (!old.length) return old;
                return [img].concat(old).slice(0, 200);
              });
              if (imgDead) {
                // 删掉 / 回收了下标前的图，当前页要跟着前移。
                if (knownAt >= 0) setFullIdx(function (i) { return Math.max(0, i > knownAt ? i - 1 : i); });
                // 锚点指着刚回收的这张时一起解除：渲染层只认锚点，
                // 不解除会继续把一张已删除的图显示出来（尤其是 lastFrameView 还指着它时）。
                if (String(fullAnchorIdRef.current || "") === imgId) {
                  fullAnchorIdRef.current = "";
                  fullWantId.current = "";
                  if (bootWantedImageRef.current && String(bootWantedImageRef.current.id || "") === imgId) {
                    bootWantedImageRef.current = null;
                  }
                }
              } else if (knownAt < 0) {
                // 真正的新图：全屏列表是「新→旧」，前面插一张时当前页 +1。
                setFullIdx(function (i) { return i > 0 ? Math.min(i + 1, 199) : 0; });
              }
            } catch (e) { /* ignore */ }
          });
          es.addEventListener("log", function (ev) {
            try {
              var l = JSON.parse(ev.data);
              setLogs(function (old) { return old.concat([l]).slice(-300); });
            } catch (e) { /* ignore */ }
          });
          es.addEventListener("state", function () { refresh().catch(function () { /* ignore */ }); });
          es.addEventListener("active-session", function (ev) {
            try {
              var a = JSON.parse(ev.data);
              setState(function (old) { return old ? Object.assign({}, old, { activeSessionId: a.sessionId, activeSessionTitle: a.title || "" }) : old; });
              refresh().catch(function () { /* ignore */ });
            } catch (e) { /* ignore */ }
          });
          es.onopen = function () { lost = false; setConn(true); };
          es.onerror = function () { lost = true; setConn(false); };
          // 事件流断了才轮询兜底；正常时没有定时请求
          var poll = setInterval(function () {
            if (lost) refresh().catch(function () { /* ignore */ });
          }, 8000);
          return function () { try { es.close(); } catch (e) { /* ignore */ } clearInterval(poll); };
        }, []);

        useEffect(function () {
          var onVisibility = function (ev) {
            setFloatHiddenState(!!(ev && ev.detail && ev.detail.hidden));
          };
          try {
            if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
              window.addEventListener(FLOAT_VIS_EVENT, onVisibility);
            }
          } catch (e) { /* ignore */ }
          return function () {
            try {
              if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
                window.removeEventListener(FLOAT_VIS_EVENT, onVisibility);
              }
            } catch (e) { /* ignore */ }
          };
        }, []);

        var setPage = function (p) {
          setPageState(p);
          try { localStorage.setItem(LS_PAGE, p); } catch (e) { /* ignore */ }
        };

        var previewParty = function (which, next) {
          setState(function (old) {
            if (!old) return old;
            var capture = Object.assign({}, old.capture || {});
            capture[which] = Object.assign({}, capture[which] || {}, next);
            return Object.assign({}, old, { capture: capture });
          });
        };

        var saveConfig = function (patch) {
          // 所有配置写入串行化：设置页连续改来源 / 会话 / 匹配方式时，
          // 回包顺序不会把新值盖回旧值；中间回包只用于排队，不闪回旧状态。
          var generation = configGeneration.current + 1;
          configGeneration.current = generation;
          var run = function () {
            return api.saveConfig(patch).then(function (r) {
              if (generation === configGeneration.current) {
                setState(function (old) {
                  if (!old) return old;
                  var pub = r.config || {};
                  var next = Object.assign({}, old, { config: pub });
                  // 概览 / 顶部状态用的是 state.capture，不能只更新 state.config。
                  if (pub.capture) {
                    var pubSource = pub.source;
                    if (pubSource && pubSource.followActive !== false) {
                      pubSource = Object.assign({}, pubSource, {
                        mode: "local",
                        sessionId: old.activeSessionId || "",
                        title: old.activeSessionTitle || "",
                      });
                    }
                    next.capture = Object.assign({}, old.capture || {}, {
                      source: pubSource,
                      target: pub.target,
                      autoForward: pub.capture.autoForward,
                      autoGenerate: pub.capture.autoGenerate,
                    });
                  }
                  return next;
                });
              }
              return r;
            });
          };
          var p = configQueue.current.then(run, run);
          configQueue.current = p.catch(function () { /* 让队列继续 */ });
          return p;
        };

        var visibleJobs = (jobs || []).filter(function (j) { return j && !j.internal; });
        var liveJob = visibleJobs.find(function (j) { return j.status === "delivering" || j.status === "parsing" || j.status === "running" || j.status === "queued"; }) || visibleJobs[0] || jobs[0] || null;
        var latestImage = (images && images[0]) || (liveJob && liveJob.images && liveJob.images[0]) || null;
        var fullImages = fullList && fullList.length ? fullList : (images && images.length ? images : ((liveJob && liveJob.images) || []));
        fullImagesRef.current = fullImages;

        // 把全屏开关同步给悬浮框跟图逻辑：即使图片框收着，全屏里也能调试 / 自动切图。
        useEffect(function () {
          try {
            if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
              var ev;
              var detail = { open: !!fullImage };
              if (typeof CustomEvent === "function") ev = new CustomEvent(FULL_STATE_EVENT, { detail: detail });
              else if (typeof document !== "undefined" && document.createEvent) {
                ev = document.createEvent("CustomEvent");
                ev.initCustomEvent(FULL_STATE_EVENT, false, false, detail);
              }
              if (ev) window.dispatchEvent(ev);
            }
          } catch (e) { /* ignore */ }
        }, [fullImage]);

        // 悬浮框的自动跟图 / 滚动切图结果，同步到右侧栏全屏当前页。
        useEffect(function () {
          var onFullFollow = function (ev) {
            if (!fullImage) return;
            // 全屏刚打开 / 刚恢复时先不动，防止悬浮框的跟图按滚动位置把页面拉回最新。
            if (Date.now() - fullOpenedAtRef.current < 800) return;
            var id = String(ev && ev.detail && ev.detail.imageId || "");
            if (!id) return;
            var list = fullImagesRef.current || [];
            for (var i = 0; i < list.length; i += 1) {
              if (String(list[i].id || "") === id) {
                fullWantId.current = "";
                // 跟图换了页，锚点必须跟着换：渲染层只认锚点，
                // 不更新就会把页面钉死在“点右侧栏看图”时那张，跟图从此失效。
                fullAnchorIdRef.current = id;
                setFullIdx(i);
                return;
              }
            }
          };
          try {
            if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
              window.addEventListener(FULL_FOLLOW_EVENT, onFullFollow);
            }
          } catch (e) { /* ignore */ }
          return function () {
            try {
              if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
                window.removeEventListener(FULL_FOLLOW_EVENT, onFullFollow);
              }
            } catch (e) { /* ignore */ }
          };
        }, [fullImage]);
        var fullSafeIdx = Math.max(0, Math.min(fullImages.length - 1, fullIdx));
        // 明确打开的那张图优先于列表 / 页码的瞬时状态：即使列表还没刷新、
        // fullIdx 被重置，也先显示目标图，不让右侧栏闪 / 停到最新一张。
        var anchorId = String(fullWantId.current || fullAnchorIdRef.current || "");
        var anchorItem = null;
        var anchorIndex = -1;
        if (anchorId) {
          for (var ai = 0; ai < fullImages.length; ai += 1) {
            if (String(fullImages[ai] && fullImages[ai].id || "") === anchorId) { anchorIndex = ai; anchorItem = fullImages[ai]; break; }
          }
          if (!anchorItem && lastFrameView && String(lastFrameView.id || "") === anchorId
            && !lastFrameView.recycled && !lastFrameView.deletedAt) {
            anchorItem = lastFrameView;
          }
          if (!anchorItem && bootWantedImageRef.current && String(bootWantedImageRef.current.id || "") === anchorId
            && !bootWantedImageRef.current.recycled && !bootWantedImageRef.current.deletedAt) {
            anchorItem = bootWantedImageRef.current;
          }
        }
        if (anchorIndex >= 0) fullSafeIdx = anchorIndex;
        var fullItem = anchorItem || fullImages[fullSafeIdx] || latestImage;
        // 原地替换会复用同一个 id，key 必须带上 URL 里的版本号，否则大图不刷新。
        var fullMediaKey = fullItem
          ? String(fullItem.id || "") + ":" + String(fullItem.url || "") + ":" + fullRetry
          : "";
        var cfg = state ? state.capture : null;
        var stateActive = state ? state.activeSessionId : "";
        // 右侧栏 / 面板绑定的是当前聊天；Host 的 activeSessionId 是全局最后上报者，
        // 多窗口时会串。面板自己的 props.sessionId 优先，手动投递才不会被别的窗口带走。
        var panelSessionId = props && typeof props.sessionId === "string" ? props.sessionId : "";
        var activeId = panelSessionId || stateActive || "";
        activeIdRef.current = activeId;
        useEffect(function () {
          var prev = lastActiveRef.current;
          lastActiveRef.current = activeId;
          if (prev && activeId && prev !== activeId && fullImage) closeFullImage();
        }, [activeId]);
        var fullLive = !!(liveJob && (liveJob.status === "delivering" || liveJob.status === "parsing" || liveJob.status === "running" || liveJob.status === "queued"));
        var fullShowBL = fullBLNear || fullMenuOpen;
        var fullCounterText = fullImages.length && fullListReady ? ((fullImages.length - fullSafeIdx) + "/" + fullImages.length) : "";
        var flashFullCounter = function () {
          if (!fullCounterText) {
            setFullCounterVisible(false);
            return;
          }
          setFullCounterVisible(true);
          if (fullCounterTimer.current) clearTimeout(fullCounterTimer.current);
          fullCounterTimer.current = setTimeout(function () {
            fullCounterTimer.current = null;
            setFullCounterVisible(false);
          }, 1800);
        };
        useEffect(function () {
          if (!fullImage) {
            setFullCounterVisible(false);
            if (fullCounterTimer.current) { clearTimeout(fullCounterTimer.current); fullCounterTimer.current = null; }
            return undefined;
          }
          flashFullCounter();
          return undefined;
        }, [fullImage, fullSafeIdx, fullImages.length, fullListReady]);
        useEffect(function () {
          return function () {
            if (fullCounterTimer.current) { clearTimeout(fullCounterTimer.current); fullCounterTimer.current = null; }
          };
        }, []);

        // 记住右侧栏当前这张。BridgePanel 因切标签卸载后，回来还能落在原图。
        useEffect(function () {
          if (!fullImage) {
            rightViewMemory.open = false;
            saveRightViewMemory();
            return;
          }
          rightViewMemory.open = true;
          rightViewMemory.sessionId = activeId || "";
          rightViewMemory.imageId = fullItem && fullItem.id ? String(fullItem.id) : "";
          rightViewMemory.idx = fullSafeIdx;
          rightViewMemory.list = Array.isArray(fullList) ? fullList.slice(0, 200) : [];
          rightViewMemory.listReady = !!fullListReady;
          saveRightViewMemory();
        }, [fullImage, fullSafeIdx, fullItem && fullItem.id, fullList, fullListReady, activeId]);

        var reloadFullList = function (keepId, keepImage) {
          var keep = keepId ? String(keepId) : "";
          var q = "page=1&size=200&check=0" + (activeId ? "&sessionId=" + encodeURIComponent(activeId) : "");
          return api.images(q).then(function (r) {
            var items = Array.isArray(r.items) ? r.items : [];
            var at = -1;
            if (keep) {
              for (var i = 0; i < items.length; i += 1) {
                if (String(items[i].id || "") === keep) { at = i; break; }
              }
            }
            // 刷新后列表里还是没有这张图：把调用方给的图补回去，别夹到最新一张。
            if (at < 0 && keepImage && String(keepImage.id || "") === keep) {
              items = [keepImage].concat(items);
              at = 0;
            }
            setFullList(items);
            setFullIdx(at >= 0 ? at : 0);
            setFullListReady(true);
            return items;
          }).catch(function (e) {
            // 拉不到完整列表时至少让菜单 / 页码恢复可用，保留当前列表。
            setFullListReady(true);
            throw e;
          });
        };

        var emitFullNav = function (id, pause) {
          if (!id) return;
          try {
            if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
              var ev;
              var detail = { imageId: String(id), pause: !!pause };
              if (typeof CustomEvent === "function") ev = new CustomEvent(FULL_NAV_EVENT, { detail: detail });
              else if (typeof document !== "undefined" && document.createEvent) {
                ev = document.createEvent("CustomEvent");
                ev.initCustomEvent(FULL_NAV_EVENT, false, false, detail);
              }
              if (ev) window.dispatchEvent(ev);
            }
          } catch (e) { /* ignore */ }
        };
        var fullGoOlder = function () {
          if (fullSafeIdx < fullImages.length - 1) {
            var next = fullSafeIdx + 1;
            var item = fullImages[next];
            fullWantId.current = "";
            fullAnchorIdRef.current = String(item && item.id || "");
            setFullIdx(next);
            emitFullNav(item && item.id, true);
          }
        };
        var fullGoNewer = function () {
          if (fullSafeIdx > 0) {
            var next = fullSafeIdx - 1;
            var item = fullImages[next];
            fullWantId.current = "";
            fullAnchorIdRef.current = String(item && item.id || "");
            setFullIdx(next);
            emitFullNav(item && item.id, true);
          }
        };
        var fullToggleMenu = function () {
          setFullMenuOpen(function (v) {
            if (v) { setFullSubOpen(false); setRegenOpen(false); }
            return !v;
          });
        };
        var fullToggleSub = function () {
          setFullSubPos(null);
          setRegenOpen(false);
          setFullSubOpen(function (v) { return !v; });
        };

        var reserveLeftFromFull = function (item) {
          closeFullImage();
          writeFloatHidden(false);
          setFloatHiddenState(false);
          try {
            if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
              var ev;
              var detail = { imageId: item && item.id ? String(item.id) : "", image: item || null };
              if (typeof CustomEvent === "function") ev = new CustomEvent(RESERVE_LEFT_EVENT, { detail: detail });
              else if (typeof document !== "undefined" && document.createEvent) {
                ev = document.createEvent("CustomEvent");
                ev.initCustomEvent(RESERVE_LEFT_EVENT, false, false, detail);
              }
              if (ev) window.dispatchEvent(ev);
            }
          } catch (e) { /* ignore */ }
        };

        var fullCapture = function () {
          var sourceCfg = (state && state.capture && state.capture.source) || (state && state.config && state.config.source) || {};
          var followActive = sourceCfg.followActive !== false;
          var sourceId = followActive ? activeId : (sourceCfg.sessionId || "");
          if (!sourceId) return showToast("先设置正文来源（设置 → 正文来源）", "err");
          // 手动「请求生成」不受自动出图开关影响：点它就是要图。
          var genNow = true;
          Promise.resolve().then(function () {
            return api.forwardSource({
              autoGenerate: genNow, continuous: fullContOn, ownerSessionId: activeId,
              sessionId: sourceId,
              sessionTitle: followActive ? ((state && state.activeSessionTitle) || "") : (sourceCfg.title || ""),
              replaceOld: genNow,
            });
          }).then(function (r) {
            showToast((genNow ? "已投递正文来源并出图（同一正文的旧图会在新图成功后进回收站）" : "已投递正文来源（只投递，不出图）") + (r.job ? "（" + shortId(r.job.id) + "）" : ""), "ok");
          }).catch(function (e) { showToast("投递失败：" + (e.message || e), "err"); });
        };
        var fullRegenerate = function (mode) {
          var fallback = mode === "all" && liveJob && liveJob.id ? liveJob : null;
          if (!fullItem && !fallback) return showToast("当前没有图片可重新生成", "warn");
          var extra = String(regenText || "").trim();
          var imageId = String(fullItem && fullItem.id || "");
          var jobId = fullItem && fullItem.jobId ? fullItem.jobId : (fallback ? fallback.id : "");
          var setId = fullItem && fullItem.setIndex !== null && fullItem.setIndex !== undefined ? fullItem.setIndex : null;
          setRegenOpen(false);
          setRegenText("");
          Promise.resolve().then(function () {
            return api.regenerate({
              imageId: imageId,
              jobId: jobId,
              setIndex: setId,
              continuous: fullContOn,
              sessionId: activeId,
              sessionTitle: (state && state.activeSessionTitle) || "",
              mode: mode === "all" ? "all" : "single",
              extra: extra,
            });
          }).then(function (r) {
            var regenMode = r && r.job && r.job.regenMode;
            showToast(
              regenMode === "continuous"
                ? "已提交：连续图整组替换（" + ((r.job.sets && r.job.sets.length) || 0) + " 张）"
                : (mode === "all" ? "已提交：本轮图片全部替换" : "已提交：仅重生成当前这张"),
              "ok",
            );
            // 右侧栏的全屏列表是分页缓存的，稍后强制重拉一次，别一直显示旧图。
            setTimeout(function () {
              if (typeof reloadFullList === "function") reloadFullList("").catch(function () { /* ignore */ });
            }, 1200);
          }).catch(function (e) { showToast("重新生成失败：" + (e.message || e), "err"); });
        };
        var fullStop = function () {
          // 全屏里的「终止」也一样：先把自动补图停掉，再中止当前任务。
          if (BLACK_UI.stop) BLACK_UI.stop();
          if (!liveJob || !liveJob.id) return;
          Promise.resolve().then(function () { return api.abort(liveJob.id); }).then(function () { showToast("已终止", "ok"); }).catch(function (e) { showToast("终止失败：" + (e.message || e), "err"); });
        };
        var fullToggleContinuous = function () {
          var next = !fullContOn;
          setFullContOn(next);
          announceUiConfig({ contOn: next });
          showToast(next ? "连续图：开" : "连续图：关", next ? "ok" : "");
          saveConfig({ generation: { continuous: { on: next } } }).catch(function (e) {
            setFullContOn(!next);
            announceUiConfig({ contOn: !next });
            showToast("切换连图失败：" + (e.message || e), "err");
          });
        };
        var fullToggleAuto = function () {
          var next = !fullAutoOn;
          setFullAutoOn(next);
          announceUiConfig({ autoOn: next });
          saveConfig({ capture: { autoForward: next, autoGenerate: next } }).catch(function (e) {
            setFullAutoOn(!next);
            announceUiConfig({ autoOn: !next });
            showToast("切换自动失败：" + (e.message || e), "err");
          });
        };
        var fullDownload = function () {
          if (fullItem) window.open(withDownload(fullItem.url), "_blank");
        };
        var fullFav = function () {
          if (!fullItem || fullLoading) return;
          var item = fullItem;
          var next = !item.favorited;
          Promise.resolve().then(function () {
            return next ? api.favorite(item.id) : api.unfavorite(item.id);
          }).then(function () {
            setFullList(function (old) {
              return old.map(function (x) { return String(x.id) === String(item.id) ? Object.assign({}, x, { favorited: next }) : x; });
            });
            setImages(function (old) {
              return old.map(function (x) { return String(x.id) === String(item.id) ? Object.assign({}, x, { favorited: next }) : x; });
            });
            showToast(next ? "已收藏" : "已取消收藏", "ok");
          }).catch(function (e) { showToast("收藏失败：" + (e.message || e), "err"); });
        };
        var fullDelete = function () {
          if (!fullItem || fullLoading || !fullListReady || fullRecycleGuard.current) return;
          var item = fullItem;
          // fullImages 是「新→旧」：下一张（更新）是 idx-1，没有才退回 idx+1（更早）。
          var target = fullImages[fullSafeIdx - 1] || fullImages[fullSafeIdx + 1] || null;
          fullRecycleGuard.current = true;
          setFullRecycleBusy(true);
          recycleImage(item.id).then(function (r) {
            var removed = !(r && (r.already || r.duplicate));
            if (removed) {
              var nextList = fullImages.filter(function (x) { return String(x.id) !== String(item.id); });
              // 完整列表还没回来前先别显示页码 / 允许再次删除，等下面 reload 完再开。
              setFullListReady(false);
              setFullList(nextList);
              var at = -1;
              if (target) {
                for (var i = 0; i < nextList.length; i += 1) {
                  if (String(nextList[i].id || "") === String(target.id || "")) { at = i; break; }
                }
              }
              setFullIdx(at >= 0 ? at : Math.max(0, Math.min(fullSafeIdx, Math.max(0, nextList.length - 1))));
              // 锚点还指着刚删掉的这张时，会把它继续显示出来；跟着挪到邻图。
              fullWantId.current = "";
              fullAnchorIdRef.current = target ? String(target.id || "") : "";
              if (bootWantedImageRef.current && String(bootWantedImageRef.current.id || "") === String(item.id)) {
                bootWantedImageRef.current = null;
              }
              setFullLoading(false);
            }
            showToast(recycleNotice(r), r && (r.already || r.duplicate) ? "warn" : "ok");
            // 本地先跳到邻图，再从宿主重取完整列表，避免只拿到 state 里的前 12 张。
            return refresh().catch(function () { /* 列表重取还会再试 */ }).then(function () {
              return reloadFullList(target ? String(target.id || "") : "").catch(function () { /* 保留本地列表 */ });
            });
          }).catch(function (e) {
            showToast("删除失败：" + (e.message || e), "err");
          }).finally(function () {
            fullRecycleGuard.current = false;
            setFullRecycleBusy(false);
          });
        };
        var fullRefresh = function () {
          var keep = fullItem && fullItem.id ? String(fullItem.id) : "";
          return refresh().then(function () {
            return reloadFullList(keep);
          }).then(function () {
            showToast("已刷新", "ok");
          }).catch(function (e) { showToast("刷新失败：" + (e.message || e), "err"); });
        };

        // 悬浮球右上角的全屏按钮：同页事件 + 挂载时补读 pending，右侧栏刚打开也能接上。
        useEffect(function () {
          var onOpen = function (ev) {
            var d = ev && ev.detail ? ev.detail : null;
            var id = d && d.imageId ? String(d.imageId) : "";
            openFullImage(id, d ? d.image : null);
          };
          try {
            if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
              window.addEventListener(FULL_OPEN_EVENT, onOpen);
            }
          } catch (e) { /* ignore */ }
          if (pendingFullOpen && Date.now() - pendingFullOpen.at < 15000) {
            var p = pendingFullOpen;
            pendingFullOpen = null;
            openFullImage(p.id, p.image);
          }
          return function () {
            try {
              if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
                window.removeEventListener(FULL_OPEN_EVENT, onOpen);
              }
            } catch (e) { /* ignore */ }
          };
        }, [images, liveJob && liveJob.id, activeId, floatHidden]);

        useEffect(function () {
          var cap = state && state.config && state.config.capture ? state.config.capture : {};
          setFullAutoOn(cap.autoForward !== false && cap.autoGenerate !== false);
          var g = state && state.config && state.config.generation && state.config.generation.continuous ? state.config.generation.continuous.on : false;
          setFullContOn(g === true);
        }, [
          state && state.config && state.config.capture && state.config.capture.autoForward,
          state && state.config && state.config.capture && state.config.capture.autoGenerate,
          state && state.config && state.config.generation && state.config.generation.continuous && state.config.generation.continuous.on,
        ]);

        useEffect(function () {
          if (!fullMenuOpen) { setFullMenuClipped(false); return undefined; }
          var el = fullMenuRef.current;
          if (!el) return undefined;
          var check = function () { setFullMenuClipped(el.scrollWidth - el.clientWidth > 2); };
          check();
          var ro = null;
          try {
            if (typeof ResizeObserver === "function") {
              ro = new ResizeObserver(check);
              ro.observe(el);
            }
          } catch (e) { /* ignore */ }
          if (typeof window !== "undefined") window.addEventListener("resize", check);
          return function () {
            try { if (ro) ro.disconnect(); } catch (e) { /* ignore */ }
            if (typeof window !== "undefined") window.removeEventListener("resize", check);
          };
        }, [fullMenuOpen, fullImages.length]);

        useEffect(function () {
          if (!fullSubOpen || !fullMenuOpen) { setFullSubPos(null); return undefined; }
          var calc = function () {
            var m = fullMoreRef.current;
            var b = fullBlRef.current;
            if (!m || !b) return;
            var mr = m.getBoundingClientRect();
            var br = b.getBoundingClientRect();
            setFullSubPos({
              left: Math.max(0, Math.round(mr.left - br.left)),
              bottom: Math.max(0, Math.round(br.bottom - mr.top + 8)),
            });
          };
          calc();
          var timer = setTimeout(calc, 0);
          if (typeof window !== "undefined") window.addEventListener("resize", calc);
          return function () {
            clearTimeout(timer);
            if (typeof window !== "undefined") window.removeEventListener("resize", calc);
          };
        }, [fullSubOpen, fullMenuOpen, fullMenuClipped, fullImages.length]);

        useEffect(function () {
          // 只有「新任务」才回到最新一张；首次挂载 / 切标签回来不重排当前页。
          var jid = liveJob && liveJob.id ? String(liveJob.id) : "";
          if (!jid) { liveJobIdSeen.current = ""; return; }
          if (!liveJobIdSeen.current) { liveJobIdSeen.current = jid; return; }
          if (liveJobIdSeen.current !== jid) {
            liveJobIdSeen.current = jid;
            // 仅此图 / 黑图补图是原地替换，停留在原页；只有新的一组图才回最新。
            var regenMode = String(liveJob.regenMode || "");
            if (fullImage && regenMode !== "single" && regenMode !== "reuse" && regenMode !== "auto" && regenMode !== "continuous") {
              // 新一组图才回最新；解除上一张的锚点，别让后续刷新又拉回去。
              fullAnchorIdRef.current = "";
              fullWantId.current = "";
              bootWantedImageRef.current = null;
              setFullIdx(0);
            }
          }
        }, [liveJob && liveJob.id]);

        useEffect(function () {
          if (!fullImage) return undefined;
          var alive = true;
          setFullListReady(false);
          var q = "page=1&size=200&check=0" + (activeId ? "&sessionId=" + encodeURIComponent(activeId) : "");
          api.images(q).then(function (r) {
            if (!alive) return;
            var items = Array.isArray(r.items) ? r.items : [];
            // fullWantId 只够撑一轮；tab 的 sessionId 晚到会再触发一次列表请求，
            // 这时用当前显示的图继续当锚点，别因为一次请求完成就回最新。
            var wanted = String(fullWantId.current || fullAnchorIdRef.current || (fullItem && fullItem.id) || "");
            if (!wanted) wanted = String(rightViewMemory.imageId || "");
            var at = -1;
            if (wanted) {
              for (var i = 0; i < items.length; i += 1) {
                if (String(items[i].id || "") === wanted) { at = i; break; }
              }
            }
            // 目标图不在刷新后的列表里（分页 / 列表抖动）时，把当前这张补回列表，
            // 不要因为切换右侧栏就跳回最新一张。
            if (wanted && at < 0) {
              var keep = (fullImagesRef.current || []).find(function (x) {
                return String(x && x.id || "") === wanted;
              });
              // 刚点「右侧栏看图」时列表可能已经换掉；用悬浮框刚给的那张 / 挂载前
              // pending 里的图兜底，不能因为没有就落回最新。
              if (!keep && lastFrameView && String(lastFrameView.id || "") === wanted) keep = lastFrameView;
              if (!keep && bootWantedImageRef.current
                && String(bootWantedImageRef.current.id || "") === wanted) keep = bootWantedImageRef.current;
              if (keep) {
                items = [keep].concat(items);
                at = 0;
              }
            }
            setFullList(items);
            if (at >= 0) setFullIdx(at);
            else setFullIdx(function (i) { return Math.max(0, Math.min(i, Math.max(0, items.length - 1))); });
            fullWantId.current = "";
            setFullListReady(true);
          }).catch(function () {
            if (alive) setFullListReady(true);
          });
          return function () { alive = false; };
        }, [fullImage, activeId]);

        useEffect(function () {
          var item = fullItem;
          var retryUrl = item
            ? item.url + (fullRetry ? ((item.url.indexOf("?") >= 0 ? "&" : "?") + "retry=" + fullRetry) : "")
            : "";
          var key = fullMediaKey;
          setFullBroken(false);
          if (!item) {
            setFullLoading(false);
            setFullSrc({ key: "", src: "" });
            return undefined;
          }
          var alive = true;
          var ready = cachedImageSrcNow(retryUrl);
          // 已经缓存过的图不再弹「载入中…」，直接换 blob。
          setFullLoading(!ready);
          setFullSrc({ key: key, src: ready || retryUrl });
          if (!ready) {
            cachedImageSrc(retryUrl).then(function (src) {
              if (alive && fullItem && String(fullItem.id) === String(item.id)) {
                setFullSrc({ key: key, src: src || retryUrl });
              }
            });
          }
          return function () { alive = false; };
        }, [fullItem && fullItem.id, fullItem && fullItem.url, fullRetry]);

        useEffect(function () {
          if (!fullImage || !fullLoading || !fullItem) return undefined;
          var timer = setTimeout(function () {
            setFullLoading(false);
            setFullBroken(true);
          }, 12000);
          return function () { clearTimeout(timer); };
        }, [fullImage, fullLoading, fullItem && fullItem.id]);

        // 全屏当前图出来后，再预取相邻两张：翻页时直接命中本地 Blob 缓存。
        useEffect(function () {
          if (!fullImage || fullLoading || !fullItem || fullImages.length < 2) return undefined;
          if (typeof navigator !== "undefined" && navigator.connection && navigator.connection.saveData) return undefined;
          var timer = setTimeout(function () {
            [fullSafeIdx - 1, fullSafeIdx + 1].forEach(function (i) {
              var item = fullImages[i];
              if (!item || !item.url) return;
              cachedImageSrc(item.url).then(function (src) {
                if (!src || typeof Image === "undefined") return;
                var pre = new Image();
                pre.decoding = "async";
                pre.src = src;
              });
            });
          }, 250);
          return function () { clearTimeout(timer); };
        }, [fullImage, fullLoading, fullItem && fullItem.id, fullItem && fullItem.url, fullSafeIdx, fullImages.length]);

        // 右侧栏全屏看图时，滚轮调右侧栏宽度（和左侧停靠的滚轮调宽对称）。
        // 只走 DSH layout 暴露的同一个 setRightbar 动作，不直接改 DOM 宽度。
        useEffect(function () {
          if (!fullImage) return undefined;
          var onWheel = function (ev) {
            var target = ev.target;
            if (!target || typeof target.closest !== "function") return;
            if (!target.closest(".ac-fullview")) return;
            if (target.closest("[data-ui]")) return;
            var panel = null;
            try {
              var rootEl = typeof target.closest === "function" ? target.closest(".ac-root") : null;
              panel = rootEl && rootEl.closest ? rootEl.closest("[data-sidebar-right-session]") : null;
              if (!panel) panel = document.querySelector("[data-sidebar-right-session]");
            } catch (e) { panel = null; }
            if (!panel || !panel.getBoundingClientRect) return;
            var rect = panel.getBoundingClientRect();
            if (!rect.width) return;
            var layout = null;
            try { layout = clientCtx && (clientCtx.layout || (clientCtx.get && clientCtx.get("layout"))); } catch (e) { layout = null; }
            var panels = layout && layout.panels;
            if (!panels || typeof panels.setRightbar !== "function") return;
            ev.preventDefault();
            var vw = (typeof window !== "undefined" && window.innerWidth) || 1600;
            var max = Math.max(300, Math.min(1200, Math.round(vw * 0.70)));
            var next = Math.max(300, Math.min(max, Math.round(rect.width + (ev.deltaY > 0 ? -28 : 28))));
            if (Math.abs(next - rect.width) < 1) return;
            try { panels.setRightbar(next); } catch (e) { /* 宿主版本不支持就保持原宽 */ }
          };
          try {
            if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
              window.addEventListener("wheel", onWheel, { passive: false });
            }
          } catch (e) { /* ignore */ }
          return function () {
            try {
              if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
                window.removeEventListener("wheel", onWheel);
              }
            } catch (e) { /* ignore */ }
          };
        }, [fullImage]);

        var title = {
          dashboard: "概览", workbench: "工作台", images: "图库",
          workflows: "工作流", lora: "LoRA", connections: "设置", logs: "日志",
        }[page] || "概览";

        var body = null;
        if (!state) {
          body = h("div", { className: "ac-empty" }, conn ? "正在读取桥的数据…" : "连不上桥的 Host 半区。确认插件已装进当前 profile 并重启过 DSH。");
        } else if (page === "workbench") {
          body = h(WorkbenchPage, { state: state, jobs: jobs, images: images, liveJob: liveJob, api: api, refresh: refresh, toast: showToast, saveConfig: saveConfig, onView: setViewer, sessionId: activeId });
        } else if (page === "images") {
          body = h(ImagesPage, { state: state, api: api, toast: showToast, onView: setViewer, mode: "images", refresh: refresh, sessionId: activeId, sessionTitle: state.activeSessionTitle || "" });
        } else if (page === "workflows") {
          body = h(WorkflowsPage, { state: state, api: api, toast: showToast, refresh: refresh, saveConfig: saveConfig });
        } else if (page === "lora") {
          body = h(LoraPage, { state: state, api: api, toast: showToast, refresh: refresh });
        } else if (page === "connections") {
          body = h(ConnectionsPage, { state: state, api: api, toast: showToast, refresh: refresh, saveConfig: saveConfig, previewParty: previewParty });
        } else if (page === "logs") {
          body = h(LogsPage, { state: state, jobs: jobs, logs: logs, api: api, toast: showToast, refresh: refresh, setSelectedJob: null });
        } else {
          body = h(DashboardPage, {
            state: state, jobs: jobs, images: images, liveJob: liveJob, api: api,
            refresh: refresh, toast: showToast, saveConfig: saveConfig, setPage: setPage, onView: setViewer, sessionId: activeId,
          });
        }

        var navItem = function (id, label) {
          return h("button", {
            key: id, className: cls("ac-segbtn", page === id && "on"), onClick: function () { setPage(id); },
          }, label);
        };

        return h("div", { className: cls("ac-root", fullImage && "fullimg", theme === "light" && "light") },
          blackPending > 0 ? h("div", { className: "ac-blackbar" },
            h("span", { className: "ac-blackbar-txt" },
              "检测到纯黑图，正在自动重新生成" + (blackPending > 1 ? "（队列 " + blackPending + " 个）" : "")),
            h(Btn, { small: true, variant: "danger", onClick: function () { if (BLACK_UI.stop) BLACK_UI.stop(); } }, "停止自动补图"),
          ) : null,
          fullImage
            ? h("div", {
              className: cls("ac-fullview", square && "square"),
              onPointerMove: function (e) {
                var r = e.currentTarget.getBoundingClientRect();
                var x = e.clientX - r.left;
                var y = e.clientY - r.top;
                setFullCloseNear(x > r.width - 96 && y < 96);
                setFullBLNear(x < 100 && y > r.height - 150);
                setFullTLNear(x < 100 && y < 100);
                setFullSide(x < 100 ? "left" : x > r.width - 100 ? "right" : "");
              },
              onPointerLeave: function () { setFullCloseNear(false); setFullBLNear(false); setFullTLNear(false); setFullSide(""); },
              onDoubleClick: function (e) {
                if (e.target && e.target.closest && e.target.closest("[data-ui]")) return;
                collapseFullToBall(e);
              },
            },
              fullBroken
                ? h("div", { className: "ac-fullbroken" },
                  "图片读取失败",
                  h("br"),
                  h(Btn, { small: true, onClick: function () { setFullRetry(fullRetry + 1); } }, "重试"),
                )
                : fullItem
                  ? h("img", {
                    key: fullMediaKey,
                    src: fullSrc.key === fullMediaKey
                      ? fullSrc.src
                      : fullItem.url + (fullRetry ? ((fullItem.url.indexOf("?") >= 0 ? "&" : "?") + "retry=" + fullRetry) : ""),
                    alt: fullItem.fileName || "图片",
                    draggable: false,
                    loading: "eager",
                    decoding: "async",
                    fetchpriority: "high",
                    onLoad: function () { setFullLoading(false); setFullBroken(false); },
                    onError: function () { setFullLoading(false); setFullBroken(true); },
                  })
                  : h("div", { className: "ac-fullhint" }, "暂无图片", h("br"), "出图后会自动换成最新一张"),
              fullCounterText
                ? h("div", { className: cls("ac-fullcounter", fullCounterVisible && "show") }, fullCounterText)
                : null,
              fullLoading && fullItem && !fullBroken
                ? h("div", { className: "ac-full-loading" }, "载入中…")
                : null,
              fullImages.length > 1 ? h(React.Fragment, null,
                h("button", {
                  className: cls("ac-sidenav left", fullSide === "left" && "show", fullSafeIdx >= fullImages.length - 1 && "is-disabled"), type: "button", title: "上一张（往期）", "aria-label": "上一张（往期）",
                  "data-ui": "1",
                  "aria-disabled": fullSafeIdx >= fullImages.length - 1,
                  onClick: function (e) { e.stopPropagation(); fullGoOlder(); },
                  onDoubleClick: function (e) { e.stopPropagation(); },
                }, h(Ico, { name: "chevL", size: 34 })),
                h("button", {
                  className: cls("ac-sidenav right", fullSide === "right" && "show", fullSafeIdx <= 0 && "is-disabled"), type: "button", title: "下一张（更新）", "aria-label": "下一张（更新）",
                  "data-ui": "1",
                  "aria-disabled": fullSafeIdx <= 0,
                  onClick: function (e) { e.stopPropagation(); fullGoNewer(); },
                  onDoubleClick: function (e) { e.stopPropagation(); },
                }, h(Ico, { name: "chevR", size: 34 })),
              ) : null,
              h(FrameTools, {
                show: fullShowBL,
                live: fullLive,
                hasJob: !!liveJob,
                hasImage: !!fullItem,
                regenOpen: regenOpen,
                regenText: regenText,
                onToggleRegen: function () { setFullSubOpen(false); setRegenOpen(function (v) { return !v; }); },
                onRegenText: setRegenText,
                onRegenSingle: function () { fullRegenerate("single"); },
                onRegenAll: function () { fullRegenerate("all"); },
                autoOn: fullAutoOn,
                contOn: fullContOn,
                followOn: floatPrefs.follow !== false,
                pointerFollow: floatPrefs.pointerFollow === true,
                debug: floatPrefs.debug === true,
                onToggleFollow: fullToggleFollow,
                onTogglePointer: fullTogglePointerFollow,
                onToggleDebug: fullToggleDebug,
                onClearAnchors: fullClearAnchors,
                square: square,
                onToggleSquare: toggleSquare,
                menuOpen: fullMenuOpen,
                subOpen: fullSubOpen,
                menuClipped: fullMenuClipped,
                subPos: fullSubPos,
                blRef: fullBlRef,
                menuRef: fullMenuRef,
                moreRef: fullMoreRef,
                onToggleMenu: fullToggleMenu,
                onToggleSub: fullToggleSub,
                onCapture: fullCapture,
                onStop: fullStop,
                onContinuous: fullToggleContinuous,
                onAuto: fullToggleAuto,
                onDelete: fullDelete,
                onDownload: fullDownload,
                onFav: fullFav,
                onRefresh: fullRefresh,
                deleteDisabled: !fullItem || fullLoading || fullRecycleBusy || !fullListReady,
                deleteTitle: !fullListReady || fullLoading ? "加载中…" : fullRecycleBusy ? "正在删除…" : "删除",
                downloadDisabled: !fullItem || fullLoading,
                favDisabled: !fullItem || fullLoading,
                favorited: !!(fullItem && fullItem.favorited),
              }),
              h("div", { className: cls("ac-tl", fullTLNear && "show"), "data-ui": "1" },
                h("button", {
                  className: "ac-round ac-glass", type: "button", title: "固定于左侧",
                  "aria-label": "固定于左侧",
                  // 没有图片也允许把空图框停靠到左侧；图片操作仍然单独禁用。
                  disabled: false,
                  onClick: function (e) { e.stopPropagation(); dockLeftFromFull(fullItem); },
                }, h(Ico, { name: "sidebarL", size: 15 })),
                h("button", {
                  className: "ac-round ac-glass", type: "button", title: "悬浮于左侧（只挪会话，不动图片框）",
                  "aria-label": "悬浮于左侧",
                  disabled: false,
                  onClick: function (e) { e.stopPropagation(); reserveLeftFromFull(fullItem); },
                }, h(Ico, { name: "leftrail", size: 15 })),
              ),
              h("button", {
                type: "button", className: cls("ac-fullclose", fullCloseNear && "show"),
                title: "退出全屏", "aria-label": "退出全屏",
                onClick: closeFullImage,
              }, h(Ico, { name: "close", size: 17 })),
            )
            : h("div", { className: "ac-top" },
              h("div", { className: "ac-navrow" },
                h("div", { className: "ac-seg" },
                  navItem("dashboard", "概览"),
                  navItem("workbench", "工作台"),
                  navItem("lora", "LoRA"),
                  navItem("workflows", "工作流"),
                  navItem("images", "图库"),
                  navItem("connections", "设置"),
                  navItem("logs", "日志"),
                ),
                h("div", { className: "ac-topacts" },
                  h("button", {
                    className: "ac-btn ghost icon",
                    title: theme === "light" ? "切换到夜间模式" : "切换到日间模式",
                    "aria-label": theme === "light" ? "切换到夜间模式" : "切换到日间模式",
                    onClick: toggleTheme,
                  }, h(Ico, { name: theme === "light" ? "moon" : "sun", size: 14 })),
                  h("button", {
                    className: "ac-btn ghost icon",
                    title: floatHidden ? "显示悬浮球" : "隐藏悬浮球",
                    "aria-label": floatHidden ? "显示悬浮球" : "隐藏悬浮球",
                    onClick: toggleFloatBall,
                  }, h(Ico, { name: "image", size: 14 })),
                  h("button", {
                    className: "ac-btn ghost icon",
                    title: "全屏看图（自动隐藏悬浮球）",
                    "aria-label": "全屏看图",
                    onClick: function () {
                      // 悬浮框最后看的那张图作为起点，别让右侧栏每次回到最新一张。
                      // 不再用 activeId 过滤：右侧栏 tab 的会话可能比悬浮框慢一拍；
                      // 目标图不在新列表里时，全屏加载会把当前图补回列表。
                      var seed = lastFrameView && lastFrameView.id ? lastFrameView : null;
                      openFullImage(seed ? String(seed.id) : "", seed);
                    },
                  }, h(Ico, { name: "expand", size: 14 })),
                ),
              ),
            ),
          fullImage ? null : h("div", { className: "ac-body" }, h(PageBoundary, null, body)),
          viewer ? withPortal(h(Lightbox, { item: viewer, api: api, toast: showToast, onClose: function () { setViewer(null); } })) : null,
          toasts.length
            ? withPortal(h("div", { className: "ac-toaststack" }, toasts.map(function (t) {
              return h("div", { key: t.id, className: cls("ac-toast", theme === "light" && "light", t.tone) }, t.text);
            })))
            : null,
        );
      }

      /* ===================================================================
       * 概览
       * =================================================================== */
      function SessionCard(props) {
        var s = props.session;
        var mode = s.mode === "remote" ? "远程" : "本进程";
        return h(Card, { title: props.title, actions: h(Btn, { small: true, variant: "ghost", onClick: props.onPick }, "选择会话") },
          h("div", { className: "ac-row", style: { marginBottom: 6 } },
            h(Pill, { tone: s.mode === "remote" ? "acc" : "ok" }, mode),
            s.baseUrl ? h(Pill, null, s.baseUrl) : null,
            s.sessionId ? h(Pill, { tone: "acc", title: s.sessionId }, shortId(s.sessionId)) : h(Pill, { tone: "warn" }, "未选择"),
          ),
          h("div", { className: "ac-mut ac-small ac-ell", title: s.title || "" }, s.title || "（还没有选会话）"),
          props.extra ? h("div", { style: { marginTop: 8 } }, props.extra) : null,
        );
      }

      function Pipeline(props) {
        var job = props.job;
        var status = job ? job.status : "";
        var steps = [
          ["捕获", ["queued", "delivering", "parsing", "running", "done", "error", "cancelled"].indexOf(status) >= 0],
          ["投递", ["delivering", "parsing", "running", "done"].indexOf(status) >= 0],
          ["解析", ["parsing", "running", "done", "prompt_ready"].indexOf(status) >= 0],
          ["出图", ["running", "done"].indexOf(status) >= 0],
        ];
        return h("div", { className: "ac-steps" },
          steps.map(function (s, i) {
            var on = s[1];
            var done = on && (status === "done" || (i < steps.length - 1 && steps[i + 1][1]));
            return h("span", { key: s[0], className: cls("ac-step", on && "on", done && "done") }, (done ? "✓ " : "") + s[0]);
          }),
        );
      }

      function JobImages(props) {
        var job = props.job;
        var imgs = job && job.images ? job.images : [];
        if (!imgs.length) return null;
        return h("div", { className: "ac-thumbs", style: { marginTop: 8 } },
          imgs.map(function (im) {
            return h("div", {
              key: im.id, className: "ac-thumb",
              title: im.title || im.fileName || "",
              onClick: function () { props.onView(im); },
            },
              h("img", { src: im.url, alt: "", loading: "lazy" }),
              h("div", { className: "ac-tacts" },
                h("div", { className: "ac-mini", title: im.favorited ? "取消收藏" : "收藏", onClick: function (e) { e.stopPropagation(); props.api[im.favorited ? "unfavorite" : "favorite"](im.id).then(function () { props.toast(im.favorited ? "已取消收藏" : "已收藏", "ok"); props.refresh(); }).catch(function (er) { props.toast(er.message, "err"); }); } }, im.favorited ? "★" : "☆"),
                h("div", { className: "ac-mini", title: "放进回收站", onClick: function (e) { e.stopPropagation(); recycleImage(im.id).then(function (r) { props.toast(recycleNotice(r), r && (r.already || r.duplicate) ? "warn" : "ok"); props.refresh(); }).catch(function (er) { props.toast(er.message, "err"); }); } }, "🗑"),
              ),
            );
          }),
        );
      }

      function DashboardPage(props) {
        var state = props.state;
        var [comfy, setComfy] = useState(undefined);
        var [busy, setBusy] = useState(false);
        var captureCfg = state.config.capture || {};
        var [autoForward, setAutoForward] = useState(!!captureCfg.autoForward);
        var [autoGenerate, setAutoGenerate] = useState(!!captureCfg.autoGenerate);
        var [extraDraft, setExtraDraft] = useState(String(captureCfg.extraMessage || ""));
        var [extraPos, setExtraPos] = useState(captureCfg.extraPosition === "bottom" ? "bottom" : "top");
        var [clearAfterSend, setClearAfterSend] = useState(captureCfg.clearAfterSend !== false);
        var extraTimer = useRef(null);
        var extraNow = useRef({ text: String(captureCfg.extraMessage || ""), pos: captureCfg.extraPosition === "bottom" ? "bottom" : "top" });
        extraNow.current = { text: extraDraft, pos: extraPos };
        var extraFocused = useRef(false);
        var extraDirty = useRef(false);
        var extraSaving = useRef(0);
        // 投递区正文框：默认留空，不跟随正文来源自动填入。
        // 只有点「投递最新正文」「重新读取」或打开「自动投递正文」时才读取；
        // 手动投递成功后，把实际投出去的那段正文显示出来。
        var sourceCfg = (state.capture && state.capture.source) || {};
        // 面板自己的 sessionId 优先；Host 的 activeSessionId 是全局最后上报者，
        // 多窗口时会串会话。只有状态里的 active 和面板一致时才用它的标题。
        var panelId = String(props.sessionId || state.activeSessionId || "");
        var panelTitle = panelId && state.activeSessionId === panelId ? (state.activeSessionTitle || "") : "";
        // 勾了「本会话」时，正文来源就是当前面板会话；不能等 state.capture.source
        // 先跟着全局 active-session 刷新，否则正文框会误判“没有来源”。
        var effectiveSource = sourceCfg.followActive !== false
          ? Object.assign({}, sourceCfg, {
            sessionId: panelId || sourceCfg.sessionId || "",
            title: panelTitle || (panelId && panelId === sourceCfg.sessionId ? sourceCfg.title : "") || "",
          })
          : sourceCfg;
        var [bodyDraft, setBodyDraft] = useState("");
        var [bodyMeta, setBodyMeta] = useState({ loading: false, error: "", sessionId: "", title: "", turn: null, chars: 0, empty: true, opening: false });
        var bodyFocused = useRef(false);
        var bodyDirty = useRef(false);
        var bodyEditSeq = useRef(0);
        var bodySeq = useRef(0);
        var sourceKey = [
          effectiveSource.followActive !== false ? "1" : "0",
          effectiveSource.mode || "local",
          effectiveSource.sessionId || "",
        ].join("|");
        var sourceSessionRef = useRef("");
        sourceSessionRef.current = effectiveSource.sessionId || "";
        var autoBodyMountedAt = useRef(Date.now());
        var sourceSinceRef = useRef(Date.now());
        var autoBodySeen = useRef("");
        var jobsKey = (props.jobs || []).map(function (j) {
          return j && j.id ? String(j.id) : "";
        }).join("|");

        var clearBody = function () {
          bodySeq.current += 1;
          bodyEditSeq.current += 1;
          setBodyDraft("");
          bodyDirty.current = false;
          setBodyMeta({ loading: false, error: "", sessionId: "", title: "", turn: null, chars: 0, empty: true, opening: false });
        };

        /** 明确操作（投递 / 重新读取 / 打开自动投递）才读取正文；加载与切换不调用。 */
        var loadBody = function () {
          var source = effectiveSource;
          var editSeq = bodyEditSeq.current;
          if (!source.sessionId) {
            bodySeq.current += 1;
            setBodyMeta({ loading: false, error: "", sessionId: "", title: "", turn: null, chars: 0, empty: true });
            return Promise.resolve();
          }
          var seq = bodySeq.current + 1;
          bodySeq.current = seq;
          setBodyMeta({
            loading: true, error: "",
            sessionId: source.sessionId, title: source.title || "",
            turn: null, chars: 0, empty: true, opening: false,
          });
          return api.bodyPreview({ sessionId: source.sessionId, title: source.title || "" }).then(function (r) {
            if (bodySeq.current !== seq) return;
            // 读取期间用户已经开始改字：不覆盖他刚输入的内容，只收起加载态。
            if (bodyEditSeq.current !== editSeq) {
              setBodyMeta(function (old) { return Object.assign({}, old, { loading: false }); });
              return;
            }
            var text = String((r && r.text) || "");
            setBodyDraft(text);
            bodyDirty.current = false;
            setBodyMeta({
              loading: false, error: "",
              sessionId: (r && r.sessionId) || source.sessionId || "",
              title: (r && r.title) || source.title || "",
              turn: r && r.turn !== null && r.turn !== undefined ? r.turn : null,
              chars: text.length,
              empty: !text.trim(),
              // 只有人物卡开场的会话：投出去的不是最新正文，这里先提示。
              opening: !!(r && r.opening),
            });
          }).catch(function (e) {
            if (bodySeq.current !== seq) return;
            setBodyMeta({
              loading: false,
              error: e && e.message ? e.message : String(e),
              sessionId: source.sessionId || "",
              title: source.title || "",
              turn: null, chars: 0, empty: true, opening: false,
            });
          });
        };

        useEffect(function () {
          // 加载 / 切换 / 当前会话更新：清空文本框，不自动读取正文。
          clearBody();
          // 切换之后才发生的自动投递才显示，切换前的旧任务不补进文本框。
          sourceSinceRef.current = Date.now();
          return function () { bodySeq.current += 1; };
        }, [sourceKey]);

        useEffect(function () {
          // 「自动投递」真的发生了一次：把这次自动投出去的正文显示出来。
          // 页面打开前就存在的旧任务不算，避免一加载就填满。
          var list = props.jobs || [];
          var cap = null;
          for (var i = 0; i < list.length; i += 1) {
            if (list[i] && list[i].source === "capture") { cap = list[i]; break; }
          }
          if (!cap || !cap.id) return;
          var id = String(cap.id);
          if (id === autoBodySeen.current) return;
          autoBodySeen.current = id;
          var at = cap.createdAt ? Date.parse(cap.createdAt) : NaN;
          if (!Number.isFinite(at) || at <= Math.max(autoBodyMountedAt.current, sourceSinceRef.current)) return;
          if (!autoForward || bodyFocused.current || bodyDirty.current) return;
          if (!cap.sourceSessionId || String(cap.sourceSessionId) !== String(sourceSessionRef.current || "")) return;
          api.job(id).then(function (r) {
            var j = r && r.job;
            if (!j || !j.text) return;
            if (!autoForward || bodyFocused.current || bodyDirty.current) return;
            if (String(j.sourceSessionId || "") !== String(sourceSessionRef.current || "")) return;
            var text = String(j.text);
            // 自动投递的正文比之前的读取更新，取消还在飞的旧读取。
            bodySeq.current += 1;
            bodyEditSeq.current += 1;
            setBodyDraft(text);
            bodyDirty.current = false;
            setBodyMeta({
              loading: false, error: "",
              sessionId: j.sourceSessionId || "",
              title: j.sourceSessionTitle || "",
              turn: j.sourceTurn === null || j.sourceTurn === undefined ? null : Number(j.sourceTurn),
              chars: text.length,
              empty: !text.trim(),
            });
          }).catch(function () { /* 详情取不到就保持原样 */ });
        }, [jobsKey, autoForward, sourceKey]);

        useEffect(function () {
          if (extraFocused.current || extraTimer.current || extraSaving.current > 0 || extraDirty.current) return;
          var nextText = String((state.config.capture && state.config.capture.extraMessage) || "");
          var nextPos = state.config.capture && state.config.capture.extraPosition === "bottom" ? "bottom" : "top";
          if (nextText !== extraNow.current.text) setExtraDraft(nextText);
          if (nextPos !== extraNow.current.pos) setExtraPos(nextPos);
          setClearAfterSend(!(state.config.capture && state.config.capture.clearAfterSend === false));
        }, [
          state.config.capture && state.config.capture.extraMessage,
          state.config.capture && state.config.capture.extraPosition,
          state.config.capture && state.config.capture.clearAfterSend,
        ]);

        useEffect(function () {
          var alive = true;
          api.comfyStatus().then(function (r) { if (alive) setComfy(r.status || null); }).catch(function () { if (alive) setComfy(null); });
          return function () { alive = false; };
        }, []);

        useEffect(function () {
          setAutoForward(!!(state.config.capture && state.config.capture.autoForward));
          setAutoGenerate(!!(state.config.capture && state.config.capture.autoGenerate));
        }, [
          state.config.capture && state.config.capture.autoForward,
          state.config.capture && state.config.capture.autoGenerate,
        ]);

        useEffect(function () {
          return function () {
            if (extraTimer.current) {
              clearTimeout(extraTimer.current);
              extraTimer.current = null;
              var now = extraNow.current;
              props.saveConfig({ capture: { extraMessage: String(now.text || ""), extraPosition: now.pos === "bottom" ? "bottom" : "top" } }).catch(function () { /* 页面已离开 */ });
            }
          };
        }, []);

        var persistExtra = function (text, pos) {
          var shown = { text: String(text || ""), pos: pos === "bottom" ? "bottom" : "top" };
          extraSaving.current += 1;
          return props.saveConfig({ capture: { extraMessage: shown.text, extraPosition: shown.pos } }).then(function (r) {
            if (extraNow.current.text === shown.text && extraNow.current.pos === shown.pos) extraDirty.current = false;
            return r;
          }).finally(function () {
            extraSaving.current = Math.max(0, extraSaving.current - 1);
          });
        };
        var scheduleExtra = function (text, pos) {
          setExtraDraft(text);
          setExtraPos(pos);
          extraDirty.current = true;
          if (extraTimer.current) clearTimeout(extraTimer.current);
          extraTimer.current = setTimeout(function () {
            extraTimer.current = null;
            var now = extraNow.current;
            persistExtra(now.text, now.pos).catch(function (e) { props.toast(e.message || String(e), "err"); });
          }, 350);
        };
        var flushExtra = function () {
          if (extraTimer.current) {
            clearTimeout(extraTimer.current);
            extraTimer.current = null;
          }
          var now = extraNow.current;
          return persistExtra(now.text, now.pos);
        };

        var deliverSource = function () {
          var src = effectiveSource || {};
          if (!src.sessionId) return props.toast("还没选正文来源，先去设置里选一个会话", "err");
          var manualText = bodyDirty.current ? String(bodyDraft || "") : "";
          var usedManual = !!manualText.trim();
          var editSeq = bodyEditSeq.current;
          setBusy(true);
          flushExtra().then(function () {
            return api.forwardSource({
              autoGenerate: autoGenerate,
              ownerSessionId: props.sessionId || state.activeSessionId || "",
              sessionId: src.sessionId || "",
              sessionTitle: src.title || "",
              text: manualText,
              sourceTurn: usedManual ? (bodyMeta.turn === undefined ? null : bodyMeta.turn) : null,
            });
          }).then(function (r) {
            var used = r && r.text !== undefined ? String(r.text || "") : "";
            if (used && bodyEditSeq.current === editSeq) {
              setBodyDraft(used);
              bodyDirty.current = usedManual;
              setBodyMeta({
                loading: false, error: "",
                sessionId: src.sessionId || "",
                title: src.title || "",
                turn: r && r.turn !== null && r.turn !== undefined ? r.turn : (bodyMeta.turn === undefined ? null : bodyMeta.turn),
                chars: used.length,
                empty: !used.trim(),
              });
            }
            props.toast((usedManual ? "已投递手写正文" : "已投递正文来源的最新回复") + (r.job ? "（" + shortId(r.job.id) + "）" : ""), "ok");
            return props.refresh();
          }).catch(function (e) { props.toast(e.message || String(e), "err"); }).finally(function () { setBusy(false); });
        };

        var toggle = function (field, value, setter) {
          setter(value);
          var patch = { capture: {} };
          patch.capture[field] = value;
          props.toast((field === "autoForward" ? "自动投递正文：" : "自动出图：") + (value ? "开" : "关"), "ok");
          props.saveConfig(patch).then(function () { return props.refresh(); }).then(function () {
            // 打开「自动投递正文」是一次明确操作：把最新正文读出来给用户看。
            // 只开自动出图、关闭自动投递都不读取；用户已经手写过也不覆盖。
            if (field === "autoForward" && value && !bodyDirty.current) {
              loadBody().catch(function () { /* 正文框下方会显示错误 */ });
            }
          }).catch(function (e) {
            setter(!value);
            props.toast(e.message || String(e), "err");
          });
        };

        var toggleClearAfterSend = function (next) {
          setClearAfterSend(next);
          props.saveConfig({ capture: { clearAfterSend: next } }).then(function () {
            props.toast("投递后自动留空：" + (next ? "开" : "关"), "ok");
          }).catch(function (e) {
            setClearAfterSend(!next);
            props.toast(e.message || String(e), "err");
          });
        };

        var cfg = state.capture || {};
        var activeTitle = state.activeSessionTitle || "";
        var activeShort = state.activeSessionId ? shortId(state.activeSessionId) : "";
        // 概览只显示会话名；没有标题时才退回短 id，不再把 session-xxxx 挂到名字后面。
        var activeLine = activeTitle || activeShort || "未选择";
        var sourceTitle = effectiveSource ? (effectiveSource.title || (effectiveSource.sessionId ? shortId(effectiveSource.sessionId) : "未选择")) : "未选择";
        var targetTitle = cfg.target ? (cfg.target.title || (cfg.target.sessionId ? shortId(cfg.target.sessionId) : "未设置")) : "未设置";
        targetTitle += " · " + (cfg.target && cfg.target.mode === "remote" ? "远程" : "本进程");
        var workflowTitle = state.activeWorkflow && state.activeWorkflow.name ? state.activeWorkflow.name : "未选择";
        var comfyUrl = (state.config.comfy && state.config.comfy.baseUrl) || "";
        var comfyPort = (comfyUrl.match(/:(\d+)(?:\/|$)/) || [])[1] || "8188";
        var comfyOk = !!(comfy && comfy.ok !== false && comfy.system);
        var comfyState = comfy === undefined ? "检测中…" : comfyOk ? "已连接" : "未连接";
        var bodyHasText = !!String(bodyDraft || "").trim();
        var bodySourceLabel = bodyMeta.title || sourceTitle || "未选择";
        var bodyChars = String(bodyDraft || "").length;
        var bodyMetaBits = [];
        if (bodyMeta.turn !== null && bodyMeta.turn !== undefined) bodyMetaBits.push("第 " + bodyMeta.turn + " 轮");
        bodyMetaBits.push(bodyChars + " 字");
        var bodyHint = bodyMeta.loading
          ? "正在读取正文来源…"
          : bodyMeta.error
            ? "读取失败：" + bodyMeta.error
            : !(effectiveSource && effectiveSource.sessionId)
              ? "还没选正文来源，先去设置里选一个会话"
              : bodyDirty.current && bodyHasText
                ? "已手动修改：只有「投递最新正文」会优先发送这段文本；自动投递仍读正文来源。"
                : !bodyHasText
                  ? "文本框为空：点「投递最新正文」会读取正文来源的最新回复。"
                  : bodyMeta.opening
                    ? "⚠ 这个会话里只有人物卡开场（最新一条助手消息就是会话第一条），还没写正文；确认正文来源选的是正在写的那个会话。"
                    : "正文来源：" + bodySourceLabel + " · " + bodyMetaBits.join(" · ") + " · 自动投递仍读会话。";

        var detectComfy = function () {
          var sid = String(props.sessionId || (state && state.activeSessionId) || "");
          var comfyP = api.comfyStatus()
            .then(function (r) { return { status: r && r.status }; })
            .catch(function (e) { return { error: e }; });
          // 检测也顺手刷新可用会话和会话名：新开的对话可能还没进列表 / 标题还是旧的。
          var sessP = api.refreshSessions({ sessionId: sid }).catch(function (e) { return { error: e }; });
          Promise.all([comfyP, sessP]).then(function (rows) {
            var c = rows[0] || {};
            var s = rows[1] || {};
            var st = c.status || null;
            setComfy(st);
            var comfyOk = !!(st && st.ok !== false && st.system);
            var bits = [
              c.error
                ? "ComfyUI 检测失败：" + (c.error.message || c.error)
                : "ComfyUI " + (comfyOk ? "已连接" : "未连接") + "，端口：" + comfyPort,
            ];
            if (s.error) {
              bits.push("会话刷新失败：" + (s.error.message || s.error));
            } else {
              var n = Array.isArray(s.sessions) ? s.sessions.length : 0;
              bits.push("可用会话 " + n + " 个");
              if (s.active && s.active.title) bits.push("当前：" + s.active.title);
            }
            props.toast(bits.join(" · "), (comfyOk && !s.error) ? "ok" : "warn");
            if (props.refresh) props.refresh().catch(function () { /* SSE 会继续更新 */ });
          });
        };

        var basicRow = function (key, label, value, hint, page) {
          return h("button", {
            key: key, type: "button", className: "ac-basicrow", title: hint,
            onClick: function () { props.setPage(page); },
          },
            h("span", { className: "ac-basick" }, label),
            h("span", { className: "ac-basicv", title: value === null || value === undefined ? "" : String(value) }, value),
            h("span", { className: "ac-basicgo" }, hint),
            h("span", { className: "ac-basicarrow" }, "›"),
          );
        };

        return h("div", { className: "ac-stack" },
          h("div", { className: "ac-overviewhead" },
            h("div", { className: "ac-logo" }, h(PaletteGlyph, { size: 20 })),
            h("div", { className: "ac-brandtext" },
              h("div", { className: "ac-title" }, BRAND_NAME),
              h("div", { className: "ac-sub" }, BRAND_SUB),
            ),
          ),

          h(Card, { title: "基础信息", actions: h(Btn, { small: true, variant: "ghost", onClick: detectComfy }, "检测") },
            h("div", { className: "ac-basiclist" },
              basicRow("session", "当前会话", activeLine, "打开工作台", "workbench"),
              basicRow("source", "正文来源", sourceTitle + " · " + (effectiveSource && effectiveSource.mode === "remote" ? "远程" : "本进程"), "打开设置", "connections"),
              basicRow("target", "提示词来源", targetTitle, "打开设置", "connections"),
              basicRow("workflow", "工作流", workflowTitle, "打开工作流", "workflows"),
              basicRow("comfy", "ComfyUI 状态", comfyState + "，端口：" + comfyPort, "打开设置", "connections"),
            ),
          ),

          h(Card, { title: "投递" },
            h(Field, {
              className: "ac-deliverybody",
              label: h("span", { className: "ac-bodylabel" },
                h("span", null, "正文（可编辑）"),
                h("button", {
                  type: "button",
                  className: "ac-linkbtn",
                  disabled: bodyMeta.loading || !(effectiveSource && effectiveSource.sessionId),
                  title: "重新读取正文来源的最新助手回复",
                  onClick: function (e) { e.preventDefault(); loadBody().catch(function () { /* 已提示 */ }); },
                }, bodyMeta.loading ? "读取中…" : "重新读取"),
              ),
            },
              h(TextArea, {
                rows: 6, value: bodyDraft,
                placeholder: "留空时不读取正文；点「投递最新正文」会读取来源的最新回复，也可以直接手写",
                onChange: function (e) { bodyDirty.current = true; bodyEditSeq.current += 1; setBodyDraft(e.target.value); },
                onFocus: function () { bodyFocused.current = true; },
                onBlur: function () { bodyFocused.current = false; },
                spellCheck: false,
              }),
              h("div", { className: "ac-bodyhint", title: bodyHint }, bodyHint),
            ),
            h("div", { className: "ac-deliverygrid" },
              h(Field, { label: "附加消息（留空不启用）" },
                h(TextArea, {
                  rows: 3, value: extraDraft,
                  placeholder: "留空不启用。这是侧边栏附加消息，会随正文一起投递；按原样放在正文前 / 后，不自动包裹。",
                  onChange: function (e) { scheduleExtra(e.target.value, extraPos); },
                  onFocus: function () { extraFocused.current = true; },
                  onBlur: function () { extraFocused.current = false; flushExtra().catch(function () { /* 已提示 */ }); },
                }),
              ),
              h(Field, { label: "位置" },
                h(Select, {
                  value: extraPos,
                  onChange: function (e) { scheduleExtra(extraDraft, e.target.value); },
                },
                  h("option", { value: "top" }, "正文最上面"),
                  h("option", { value: "bottom" }, "正文最下面"),
                ),
                h("div", { style: { marginTop: 7 } },
                  h(Switch, {
                    checked: clearAfterSend,
                    onChange: function (e) { toggleClearAfterSend(e.target.checked); },
                    title: "投递成功后自动清空上面的附加消息；位置设置保留",
                  }, "投递后自动留空"),
                ),
              ),
            ),
            h("div", { className: "ac-deliveryacts" },
              h(Btn, {
                variant: "primary", className: "ac-genbtn",
                disabled: busy || !(effectiveSource && effectiveSource.sessionId),
                onClick: deliverSource,
              }, busy ? "投递中…" : "投递最新正文"),
              h("div", { className: "ac-deliverytoggles" },
                h(Switch, { checked: autoForward, onChange: function (e) { toggle("autoForward", e.target.checked, setAutoForward); } }, "自动投递正文"),
                h(Switch, { checked: autoGenerate, onChange: function (e) { toggle("autoGenerate", e.target.checked, setAutoGenerate); } }, "自动出图"),
              ),
            ),
          ),
        );
      }

      /* ===================================================================
       * 工作台
       * =================================================================== */
      function WorkbenchPage(props) {
        var state = props.state;
        var job = props.liveJob;
        var bootRef = useRef(null);
        var bootLoaded = useRef(false);
        if (!bootLoaded.current) {
          bootLoaded.current = true;
          bootRef.current = readWorkbenchDraft();
        }
        var draft = bootRef.current;
        var genCfg = state.config.generation || {};
        var contCfg = genCfg.continuous || {};
        var wf = state.activeWorkflow || null;
        var draftAt = draft && draft.savedAt ? draft.savedAt : 0;
        var jobAt = job && job.createdAt ? (Date.parse(job.createdAt) || 0) : 0;
        // 工作台打开时，若最近一次任务比本地草稿新，就用任务里的提示词。
        // 以前无条件让草稿优先，自动流程跑完再打开工作台会一直看到旧提示词。
        var preferJob = !!(job && job.sets && job.sets.length && (!draft || jobAt > draftAt));
        var jobSeedSets = job && job.sets && job.sets.length
          ? job.sets.map(function (s) { return { title: s.title || "", anchor: s.anchor || "", size: s.size || null, positive: s.positive || "", negative: s.negative || "" }; })
          : [];
        // 旧草稿里没有 anchor（甚至标题为空）：用同一序号的最近任务补空，
        // 只补空字段，不覆盖用户自己改过的正面 / 负面提示词。
        var seedSets = preferJob && jobSeedSets.length
          ? jobSeedSets
          : draft && draft.sets && draft.sets.length
            ? draft.sets.map(function (s, i) {
              var j = jobSeedSets[i] || null;
              return {
                title: (s && s.title) || (j && j.title) || "",
                anchor: (s && s.anchor) || (j && j.anchor) || "",
                size: (s && s.size) || (j && j.size) || null,
                positive: (s && s.positive) || "",
                negative: (s && s.negative) || "",
              };
            })
            : [blankPromptSet()];
        var [sets, setSets] = useState(seedSets);
        var [busy, setBusy] = useState(false);
        var [extracting, setExtracting] = useState("");
        var [loraStacks, setLoraStacks] = useState([]);
        var lastJobId = useRef(preferJob ? job.id : "");
        var draftAtRef = useRef(draftAt);
        // 「提取」时顺手记下这段正文属于哪个会话 / 第几轮；出图时写给图片，
        // 后续滚动跟随时用 turn 做百分比回退。
        var draftSrc = {
          sessionId: draft ? String(draft.sourceSessionId || "") : "",
          title: draft ? String(draft.sourceSessionTitle || "") : "",
          turn: draft && draft.sourceTurn !== null && draft.sourceTurn !== undefined ? Number(draft.sourceTurn) : null,
        };
        // 旧草稿没存来源时，若最近任务就属于当前会话，借用它的会话 / turn。
        if (!draftSrc.sessionId && !draftSrc.turn && job
          && (!props.sessionId || String(job.sourceSessionId || "") === String(props.sessionId)
            || String(job.ownerSessionId || "") === String(props.sessionId))) {
          draftSrc = {
            sessionId: job.sourceSessionId || "", title: job.sourceSessionTitle || "", turn: job.sourceTurn ?? null,
          };
        }
        var promptSrcRef = useRef(preferJob && job
          ? { sessionId: job.sourceSessionId || "", title: job.sourceSessionTitle || "", turn: job.sourceTurn ?? null }
          : draftSrc);
        var [sizeMode, setSizeMode] = useState(draft ? draft.sizeMode : (wf ? (wf.sizeMode || "manual") : "manual"));
        var [sizeDraft, setSizeDraft] = useState(draft && draft.sizeDraft ? draft.sizeDraft : (wf && wf.size ? wf.size : { w: 1024, h: 1024 }));
        // 连续图参数以服务端配置为准（悬浮球也能改它），不放在本地页草稿里，避免旧草稿把新配置盖回去。
        var [contOn, setContOn] = useState(!!contCfg.on);
        var [contLora, setContLora] = useState(contCfg.lora || "");
        var initialStrengths = (function () {
          var raw = Array.isArray(contCfg.strengths) ? contCfg.strengths : [];
          var nums = raw.map(function (v) { return typeof v === "number" && isFinite(v) ? v : null; });
          var filled = nums.filter(function (v) { return v !== null; });
          return {
            count: Math.max(1, Math.min(3, filled.length || 1)),
            values: [nums[0] === null || nums[0] === undefined ? 0.8 : nums[0], nums[1] === null || nums[1] === undefined ? 1.0 : nums[1], nums[2] === null || nums[2] === undefined ? 1.2 : nums[2]],
          };
        })();
        var [contCount, setContCount] = useState(initialStrengths.count);
        var [contStrengths, setContStrengths] = useState(initialStrengths.values);
        // 连续图档位的输入原文：允许先打「-」「-.5」，离开输入框才兜底。
        var [contText, setContText] = useState({});
        var cfgTimer = useRef(null);
        var wfSkip = useRef(!!draft);

        useEffect(function () {
          if (!job || !job.sets || !job.sets.length) return;
          if (lastJobId.current === job.id) return;
          var at = job.createdAt ? (Date.parse(job.createdAt) || 0) : 0;
          // 比本地草稿旧的任务不覆盖用户刚改过的提示词。
          if (at && at <= draftAtRef.current) {
            lastJobId.current = job.id;
            return;
          }
          lastJobId.current = job.id;
          promptSrcRef.current = {
            sessionId: job.sourceSessionId || "",
            title: job.sourceSessionTitle || "",
            turn: job.sourceTurn ?? null,
          };
          setSets(job.sets.map(function (s) {
            return { title: s.title || "", anchor: s.anchor || "", size: s.size || null, positive: s.positive || "", negative: s.negative || "" };
          }));
        }, [job && job.id]);

        useEffect(function () {
          if (!wf || !wf.id) { setLoraStacks([]); return; }
          api.loras({ workflowId: wf.id }).then(function (r) { setLoraStacks(r.stacks || []); }).catch(function () { setLoraStacks([]); });
        }, [wf && wf.id]);

        useEffect(function () {
          if (!wf || !wf.id) return;
          if (wfSkip.current) { wfSkip.current = false; return; }
          setSizeMode(wf.sizeMode === "dsh" ? "dsh" : "manual");
          if (wf.size) setSizeDraft(wf.size);
        }, [wf && wf.id, wf && wf.sizeMode, wf && wf.size && wf.size.w, wf && wf.size && wf.size.h]);

        // 整页自动保存：每次改动直接写 localStorage，不再弹「已保存」。
        useEffect(function () {
          var saved = writeWorkbenchDraft({
            sets: sets,
            sizeMode: sizeMode,
            sizeDraft: sizeDraft,
            sourceSessionId: (promptSrcRef.current && promptSrcRef.current.sessionId) || "",
            sourceSessionTitle: (promptSrcRef.current && promptSrcRef.current.title) || "",
            sourceTurn: promptSrcRef.current ? promptSrcRef.current.turn : null,
            // 只有用户真的改过（draftAtRef 被 updateSet / 提取更新）才推进时间；
            // 纯展示 / 自动同步任务提示词时不改，避免把新任务永远挡在草稿后面。
            savedAt: draftAtRef.current,
          });
          if (!saved) props.toast("自动保存失败：浏览器本地存储不可用", "err");
        }, [sets, sizeMode, sizeDraft, contOn, contLora, contCount, contStrengths]);

        var baseSet = sets[0] || null;
        // 手动模式只认手动宽高；提取提示词带来的 size 只在「听从会话 size」勾选时上屏。
        var sessionSize = baseSet && baseSet.size && Number(baseSet.size.w) > 0 && Number(baseSet.size.h) > 0
          ? { w: Number(baseSet.size.w), h: Number(baseSet.size.h) } : null;
        var size = sizeMode === "dsh"
          ? (sessionSize || sizeDraft || { w: 1024, h: 1024 })
          : (sizeDraft || { w: 1024, h: 1024 });
        var sizeLocked = sizeMode === "dsh";

        // 宽高输入框：输入过程中保留用户打的原文（允许 1、12、121 这种中间态），
        // 只有离开输入框 / 回车时才夹到 64–4096 并落库。
        // 以前是每次按键都 clamp(64)，打 832 会被立刻改成 64，根本没法改。
        // 没在编辑时直接显示 size，所以切换会话 / 工作流、勾选「听从会话 size」都会立刻反映。
        var [sizeText, setSizeText] = useState({ w: "", h: "" });
        var [sizeEditingKey, setSizeEditingKey] = useState("");
        var sizeFieldValue = function (key) {
          return sizeEditingKey === key ? sizeText[key] : String((key === "w" ? size.w : size.h) || 1024);
        };

        var updateSet = function (idx, patch) {
          draftAtRef.current = Date.now();
          setSets(function (old) {
            var next = old.slice();
            next[idx] = Object.assign({}, next[idx] || {}, patch);
            return next;
          });
        };
        var updateSize = function (n) {
          draftAtRef.current = Date.now();
          setSizeDraft(n);
        };
        var act = function (fn, okText) {
          setBusy(true);
          Promise.resolve().then(fn).then(function () {
            if (okText) props.toast(okText, "ok");
            return props.refresh();
          }).catch(function (e) { props.toast(e.message || String(e), "err"); }).finally(function () { setBusy(false); });
        };
        var generate = function () {
          if (!sets.length) return props.toast("还没有提示词；先投递一次正文", "err");
          if (!sets.some(function (s) { return s.positive; })) return props.toast("正面提示词是空的", "err");
          act(function () {
            // 出图前把「当前可见的分辨率模式 / 手填值」落库：
            // 本地草稿和旧工作流可能不同步，不能只靠 400ms 的输入去抖。
            var sync = wf ? api.updateWorkflow(wf.id, { size: sizeDraft, sizeMode: sizeMode }) : Promise.resolve();
            var src = promptSrcRef.current || {};
            return sync.then(function () {
              return api.generate({
                sets: sets,
                continuous: contOn,
                sessionId: props.sessionId || "",
                sessionTitle: state.activeSessionTitle || "",
                sourceSessionId: src.sessionId || "",
                sourceSessionTitle: src.title || "",
                sourceTurn: src.turn,
              });
            });
          }, "已开始出图");
        };
        var clearAllPrompts = function () {
          draftAtRef.current = Date.now();
          promptSrcRef.current = { sessionId: "", title: "", turn: null };
          setSets([blankPromptSet()]);
          props.toast("提示词已全部清空，保留一组空白", "ok");
        };
        var extractFrom = function (which) {
          if (which === "current" && !props.sessionId) return props.toast("还没有当前会话", "err");
          setExtracting(which);
          var read = which === "source"
            ? api.promptSourceText()
            : api.capture({ sessionId: props.sessionId, preview: true });
          read.then(function (r) {
            var text = String((r && r.text) || "").trim();
            if (!text) throw new Error(which === "source" ? "提示词来源还没有可提取的助手正文" : "当前会话还没有可提取的助手正文");
            promptSrcRef.current = {
              sessionId: String((r && r.sessionId) || (which === "current" ? props.sessionId : "") || ""),
              title: String((r && r.title) || (which === "current" ? state.activeSessionTitle : "") || ""),
              turn: r && r.turn !== undefined && r.turn !== null ? Number(r.turn) : null,
            };
            return api.rulePreview({
              ruleId: state.config.capture.matchRule,
              text: text,
              customTags: state.config.capture.customTags,
            }).then(function (p) {
              var found = Array.isArray(p.sets) ? p.sets : [];
              if (!found.length) {
                var why = p.nonDelivery
                  ? (state.config.capture.matchRule === "custom_tags" ? "没有匹配到标题闭合标签" : "这段正文不是可用的交付消息")
                  : ((p.issues || [])[0] || "没有识别到提示词");
                throw new Error(why);
              }
              found = found.slice(0, Math.max(1, Math.min(3, Number(state.config.capture.maxSets) || 3)));
              draftAtRef.current = Date.now();
              setSets(found.map(function (s) {
                return { title: s.title || "", anchor: s.anchor || "", size: s.size || null, positive: s.positive || "", negative: s.negative || "" };
              }));
              props.toast((which === "source" ? "已从提示词来源提取 " : "已从当前会话提取 ") + found.length + " 套提示词", "ok");
            });
          }).catch(function (e) {
            props.toast("提取失败：" + (e.message || e), "err");
          }).finally(function () { setExtracting(""); });
        };
        var sizeTimer = useRef(null);
        var saveSize = function (nextSize, nextMode, delay) {
          if (!wf) return Promise.resolve();
          if (sizeTimer.current) clearTimeout(sizeTimer.current);
          sizeTimer.current = setTimeout(function () {
            api.updateWorkflow(wf.id, { size: nextSize, sizeMode: nextMode }).then(function () { return props.refresh(); }).catch(function () { /* ignore */ });
          }, delay === undefined ? 400 : delay);
          return Promise.resolve();
        };
        // 离开输入框才兜底：空值恢复原值，否则夹到 64–4096 再写回。
        var commitSizeField = function (key, raw) {
          setSizeEditingKey("");
          if (String(raw === undefined || raw === null ? "" : raw).trim() === "") return;
          var n = clamp(raw, 64, 4096);
          var next = { w: key === "h" ? size.w : n, h: key === "h" ? n : size.h };
          updateSize(next);
          saveSize(next, sizeMode);
        };
        var beginSizeEdit = function (key) {
          if (sizeLocked) return;
          setSizeText({ w: String(size.w || 1024), h: String(size.h || 1024) });
          setSizeEditingKey(key);
        };
        var editSizeField = function (key, raw) {
          if (sizeLocked) return;
          setSizeEditingKey(key);
          setSizeText(function (old) {
            var next = { w: old.w, h: old.h };
            next[key] = String(raw);
            return next;
          });
          // 已经在合法区间就顺手同步给草稿，生成 / 干跑读到的是最新值；
          // 中间态（比如只打了「8」）先只留在文本框里，等失焦再兜底。
          var n = Number(raw);
          if (String(raw).trim() !== "" && isFinite(n) && n >= 64 && n <= 4096) {
            var next = { w: size.w, h: size.h };
            next[key] = Math.round(n);
            updateSize(next);
          }
        };
        useEffect(function () {
          return function () {
            if (sizeTimer.current) clearTimeout(sizeTimer.current);
            if (cfgTimer.current) clearTimeout(cfgTimer.current);
          };
        }, []);

        var saveContinuous = function (patch, immediate) {
          setBusy(false);
          var next = {
            on: patch.on !== undefined ? patch.on : contOn,
            lora: patch.lora !== undefined ? patch.lora : contLora,
            strengths: (patch.strengths || contStrengths).slice(0, patch.count || contCount),
          };
          if (cfgTimer.current) clearTimeout(cfgTimer.current);
          var send = function () {
            props.saveConfig({ generation: { continuous: next } }).catch(function (e) { props.toast(e.message, "err"); });
          };
          if (immediate) send(); else cfgTimer.current = setTimeout(send, 300);
        };
        var toggleContinuous = function (on) {
          setContOn(on);
          saveContinuous({ on: on }, true);
        };
        var pickLora = function (value) {
          setContLora(value);
          saveContinuous({ lora: value }, true);
        };
        var pickCount = function (n) {
          setContCount(n);
          saveContinuous({ count: n, strengths: contStrengths }, true);
        };
        // 档位允许负数（反相 LoRA）：输入期间保留原文（「-」「-.5」这种中间态），
        // 失焦 / 回车才夹到 -5..5 并落库。夹取范围和 lib/config.js 的服务端归一化一致。
        var setStrength = function (i, value) {
          var next = contStrengths.slice();
          next[i] = Math.round(clamp(value, -5, 5) * 100) / 100;
          setContStrengths(next);
          saveContinuous({ strengths: next }, false);
        };
        var editContStrength = function (i, raw) {
          setContText(function (old) {
            var n = Object.assign({}, old);
            n[i] = String(raw);
            return n;
          });
          var v = Number(raw);
          if (String(raw).trim() !== "" && isFinite(v)) {
            var next = contStrengths.slice();
            next[i] = v;
            setContStrengths(next);
            saveContinuous({ strengths: next }, false);
          }
        };
        var commitContStrength = function (i, raw) {
          setContText(function (old) {
            var n = Object.assign({}, old);
            delete n[i];
            return n;
          });
          if (String(raw === undefined || raw === null ? "" : raw).trim() === "") return;
          setStrength(i, raw);
        };

        var loraOptions = [];
        (loraStacks || []).forEach(function (st) {
          (st.entries || []).forEach(function (e) {
            loraOptions.push({ value: st.nodeId + "::" + e.name, label: "#" + st.nodeId + " · " + (e.label || e.name) });
          });
        });
        var latestImgs = (job && job.images) || [];
        var jobStatusLabel = job ? ({
          queued: "排队中", delivering: "投递中", parsing: "解析中", running: "出图中",
          prompt_ready: "等待出图", done: "完成", error: "失败", cancelled: "已取消",
        }[job.status] || job.status) : "空闲";
        if (!latestImgs.length && !(job && job.cancellable)) jobStatusLabel = "空闲";
        // 只有这张提示词的锚点已经出现在最近一次出图的记录里，才显示一条小字；
        // 默认不再把“插入点：全文”重复塞进标题 / 输入框下面。
        var matchedAnchors = {};
        latestImgs.forEach(function (im) {
          if (im && im.anchor && !im.recycled) matchedAnchors[String(im.anchor)] = true;
        });

        return h("div", { className: "ac-stack" },
          h("div", { className: "ac-wfbar" },
            h("span", { className: "ac-wfname", title: wf ? wf.name : "未选择" }, "工作流：" + (wf ? wf.name : "未选择")),
            h("span", { style: { flex: 1 } }),
            job && job.cancellable ? h(Btn, { small: true, variant: "danger", onClick: function () { if (BLACK_UI.stop) BLACK_UI.stop(); api.abort(job.id).then(function () { props.toast("已终止", "ok"); }).catch(function (e) { props.toast("终止失败：" + (e.message || e), "err"); }); } }, "终止") : null,
            h(Btn, {
              variant: "primary", className: "ac-genbtn",
              disabled: busy || !sets.length || !sets.some(function (s) { return s.positive; }) || !!(job && job.cancellable),
              onClick: generate,
            }, busy ? "生成中…" : "生成图片"),
          ),

          h(Card, {
            title: h("span", { className: "ac-h2row" },
              h("span", null, sets.length > 1 ? "提示词（" + sets.length + " 套）" : "提示词"),
              h("button", {
                type: "button", className: "ac-linkbtn",
                disabled: !!extracting, onClick: function () { extractFrom("source"); },
                title: "读取设置里提示词来源的最新助手正文，并用当前匹配方式切分",
              }, extracting === "source" ? "提取中…" : "提取"),
              h("button", {
                type: "button", className: "ac-linkbtn",
                disabled: !!extracting, onClick: function () { extractFrom("current"); },
                title: "读取当前会话最新助手正文，并用当前匹配方式切分",
              }, extracting === "current" ? "提取中…" : "从当前会话提取"),
              h("button", {
                type: "button", className: "ac-linkbtn",
                disabled: !!extracting, onClick: clearAllPrompts,
                title: "清空标题、正面、负面，只留一组空白提示词",
              }, "全部清空"),
            ),
          },
            sets.length ? sets.map(function (s, i) {
              return h("div", { key: i, className: "ac-promptset" },
                h("div", { className: "ac-promptsethead" },
                  h("span", { className: "ac-promptsetname" }, s.title || "第 " + (i + 1) + " 套"),
                  s.size && s.size.w ? h("span", { className: "ac-hint" }, s.size.w + "×" + s.size.h) : null,
                  i === sets.length - 1 && contOn ? h(Pill, { tone: "acc" }, "最后一套 · 连续图") : null,
                ),
                h("div", { className: "ac-anchorbox" },
                  h("span", { className: "ac-anchorlabel" }, "原文锚点"),
                  h(TextInput, {
                    value: s.anchor || "",
                    placeholder: "这一场的最后一句原文；留空或匹配不到时按本套序号百分比回退",
                    onChange: function (e) { updateSet(i, { anchor: e.target.value }); },
                  }),
                ),
                s.anchor && matchedAnchors[String(s.anchor)]
                  ? h("div", { className: "ac-anchorstate", title: s.anchor }, "✓ 插入点已匹配当前图")
                  : null,
                h("div", { className: "ac-prompts" },
                  h("div", { className: "ac-promptcol" },
                    h("div", { className: "ac-prompthead" }, "正面"),
                    h(TextArea, { rows: 6, value: s.positive || "", onChange: function (e) { updateSet(i, { positive: e.target.value }); } }),
                    h("div", { className: "ac-row", style: { marginTop: 6 } },
                      h(Btn, { small: true, variant: "ghost", onClick: function () { copyText(s.positive || "").then(function () { props.toast("已复制", "ok"); }); } }, "复制"),
                      h(Btn, { small: true, variant: "ghost", onClick: function () { updateSet(i, { positive: "" }); props.toast("已清空正面提示词", "ok"); } }, "清空"),
                      h("span", { style: { flex: 1 } }),
                      h("span", { className: "ac-hint" }, String((s.positive || "").length) + " 字"),
                    ),
                  ),
                  h("div", { className: "ac-promptcol" },
                    h("div", { className: "ac-prompthead" }, "负面"),
                    h(TextArea, { rows: 6, value: s.negative || "", onChange: function (e) { updateSet(i, { negative: e.target.value }); } }),
                    h("div", { className: "ac-row", style: { marginTop: 6 } },
                      h(Btn, { small: true, variant: "ghost", onClick: function () { copyText(s.negative || "").then(function () { props.toast("已复制", "ok"); }); } }, "复制"),
                      h(Btn, { small: true, variant: "ghost", onClick: function () { updateSet(i, { negative: "" }); props.toast("已清空负面提示词", "ok"); } }, "清空"),
                    ),
                  ),
                ),
              );
            }) : h(Empty, null, "还没有提示词。先投递一次正文。"),
          ),

          h(Card, { title: "分辨率" },
            h("div", { className: "ac-sizerow" },
              h(Field, { label: "宽" }, h(NumInput, {
                value: sizeFieldValue("w"), disabled: sizeLocked,
                onFocus: function () { beginSizeEdit("w"); },
                onChange: function (e) { editSizeField("w", e.target.value); },
                onBlur: function (e) { commitSizeField("w", e.target.value); },
                onKeyDown: function (e) { if (e.key === "Enter") e.currentTarget.blur(); },
              })),
              h(Field, { label: "高" }, h(NumInput, {
                value: sizeFieldValue("h"), disabled: sizeLocked,
                onFocus: function () { beginSizeEdit("h"); },
                onChange: function (e) { editSizeField("h", e.target.value); },
                onBlur: function (e) { commitSizeField("h", e.target.value); },
                onKeyDown: function (e) { if (e.key === "Enter") e.currentTarget.blur(); },
              })),
              h(Btn, {
                small: true, disabled: sizeLocked,
                onClick: function () {
                  if (sizeLocked) return;
                  var n = { w: size.h, h: size.w };
                  updateSize(n); saveSize(n, sizeMode); props.toast("已交换宽高", "ok");
                },
              }, "⇄"),
            ),
            h("div", { className: "ac-sizeswitchrow" },
              h(Switch, {
                checked: sizeMode === "dsh",
                onChange: function (e) {
                  var next = e.target.checked ? "dsh" : "manual";
                  setSizeMode(next);
                  saveSize(sizeDraft, next);
                  props.toast(next === "dsh" ? "分辨率：跟随会话 size，宽高已锁定" : "分辨率：手填宽高", "ok");
                },
              }, "听从会话 size"),
              h("span", { className: "ac-inlinehint" }, " · " + (sizeMode === "dsh" ? "已锁定；会话 size 缺失时用锁定前宽高" : "手填宽高；提取提示词不会自动改")),
            ),
          ),

          h(Card, { title: "连续图", actions: h(Switch, { checked: contOn, onChange: function (e) { toggleContinuous(e.target.checked); } }, "启用") },
            h("div", { className: "ac-form" },
              h(Field, { label: "LoRA" }, h(Select, { value: contLora, onChange: function (e) { pickLora(e.target.value); } },
                h("option", { value: "" }, "— 选一条 LoRA —"),
                loraOptions.map(function (o) { return h("option", { key: o.value, value: o.value }, o.label); }),
              )),
              h("div", { className: "ac-row" },
                h(Field, { label: "张数" }, h(Select, { value: String(contCount), onChange: function (e) { pickCount(Number(e.target.value)); } },
                  [1, 2, 3].map(function (n) { return h("option", { key: n, value: String(n) }, String(n)); }),
                )),
              ),
              h("div", { className: "ac-strengthrow" },
                contStrengths.slice(0, contCount).map(function (v, i) {
                  return h(Field, { key: i, label: "档位" + (i + 1) }, h(NumInput, {
                    step: "0.05", min: "-5", max: "5",
                    value: contText[i] !== undefined ? contText[i] : String(v),
                    onChange: function (e) { editContStrength(i, e.target.value); },
                    onBlur: function (e) { commitContStrength(i, e.target.value); },
                    onKeyDown: function (e) { if (e.key === "Enter") e.currentTarget.blur(); },
                  }));
                }),
              ),
              h("div", { className: "ac-hint" }, "支持 LoRA 堆、单 LoRA、Power / Stacker / Tag 节点；仅影响最后一组提示词，按设置张数用不同强度连续生图。强度可以填负数（反相），范围 -5 ~ 5。"),
            ),
          ),

          h(Card, { title: "本次出图", actions: h(Btn, { small: true, variant: "ghost", onClick: function () { props.refresh().then(function () { props.toast("已刷新", "ok"); }).catch(function (e) { props.toast("刷新失败：" + (e.message || e), "err"); }); } }, "刷新") },
            latestImgs.length
              ? h("div", { className: "ac-thumbs" }, latestImgs.map(function (im) {
                var deleted = !!im.recycled;
                return h("div", {
                  key: im.id,
                  className: cls("ac-thumb", deleted && "deleted"),
                  style: { aspectRatio: "1" },
                  title: deleted ? "已删除（在回收站）" : (im.title || im.fileName || ""),
                  onClick: function () { if (!deleted) props.onView(im); },
                },
                  h("img", { src: im.url, alt: "", loading: "lazy" }),
                  deleted ? h("div", { className: "ac-thumbdeleted" },
                    h(Ico, { name: "trash", size: 17 }),
                    h("span", null, "已删除"),
                  ) : null,
                  im.title ? h("div", { style: { position: "absolute", left: 0, right: 0, bottom: 0, padding: "3px 5px", background: "rgba(0,0,0,.58)", color: "#d7dae0", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, im.title) : null,
                );
              }))
              : h(Empty, null, "还没有出图"),
            job ? h("div", { className: "ac-hint", style: { marginTop: 7 } },
              "状态：" + jobStatusLabel + (latestImgs.length && job.comfyMs ? " · 出图 " + (job.comfyMs / 1000).toFixed(1) + "s" : "") + (latestImgs.length && job.warn ? " · " + job.warn : ""),
            ) : h("div", { className: "ac-hint", style: { marginTop: 7 } }, "状态：空闲"),
          ),
        );
      }

      /* ===================================================================
       * 图库 / 收藏夹
       * =================================================================== */
      function ImagesPage(props) {
        var [fav, setFav] = useState(props.mode === "favorites");
        // 图库默认打开「当前会话」；收藏夹入口仍然保留在页签里。
        var [sessionOnly, setSessionOnly] = useState(props.mode !== "favorites");
        // initialData 只用于离线深渲染测试；正常运行靠 /api/images。
        var [data, setData] = useState(props.initialData || null);
        var [page, setPage] = useState(1);
        var [busy, setBusy] = useState(false);
        var imgRetry = useRef({});
        var [pendingDelete, setPendingDelete] = useState({});
        var size = 9;

        var load = function (p, notice) {
          if (sessionOnly && !props.sessionId) {
            setData({ items: [], total: 0, page: 1, size: size, ghost: 0 });
            setPage(1);
            setBusy(false);
            if (notice) props.toast("还没有当前会话", "err");
            return;
          }
          setBusy(true);
          imgRetry.current = {};
          var q = "page=" + p + "&size=" + size + (sessionOnly ? "&sessionId=" + encodeURIComponent(props.sessionId) : "") + "&_t=" + Date.now();
          (fav ? api.favorites("page=" + p + "&size=" + size) : api.images(q))
            .then(function (r) {
              setData(r);
              setPage(p);
              if (notice) props.toast(notice === true ? "已刷新" : notice, "ok");
            })
            .catch(function (e) { props.toast(e.message, "err"); })
            .finally(function () { setBusy(false); });
        };
        useEffect(function () {
          // 每次打开图库都重新拉一次，避免显示上一轮的残留 / 裂图。
          setData(null);
          load(1);
          if (props.refresh) {
            try {
              var rp = props.refresh();
              if (rp && typeof rp.catch === "function") rp.catch(function () { /* ignore */ });
            } catch (e) { /* ignore */ }
          }
        }, [fav, sessionOnly, props.sessionId]);

        var total = data ? data.total : 0;
        var maxPage = Math.max(1, Math.ceil(total / size));
        var items = data ? data.items : [];
        var shownItems = items.filter(function (it) { return it && !pendingDelete[String(it.id)]; });

        var act = function (fn, text) {
          Promise.resolve().then(fn).then(function () { props.toast(text, "ok"); load(page); if (props.refresh) props.refresh(); }).catch(function (e) { props.toast(e.message, "err"); });
        };
        var deleteBusy = useRef({});
        var deleteImage = function (it) {
          if (!it || !it.id) return;
          if (deleteBusy.current[it.id]) {
            props.toast("这张图正在删除，请稍候", "warn");
            return;
          }
          var id = String(it.id);
          var lastOnPage = shownItems.length === 1 && page > 1;
          deleteBusy.current[it.id] = true;
          // 点击后先从界面拿掉，避免文件已经进回收站、列表还没回来时留下一张黑图。
          setPendingDelete(function (old) { return Object.assign({}, old, { [id]: true }); });
          recycleImage(it.id).then(function (r) {
            setData(function (old) {
              if (!old) return old;
              var rows = (old.items || []).filter(function (x) { return String(x.id || "") !== id; });
              var found = rows.length !== (old.items || []).length;
              return Object.assign({}, old, {
                items: rows,
                total: found ? Math.max(0, Number(old.total || 0) - 1) : old.total,
              });
            });
            setPendingDelete(function (old) {
              var next = Object.assign({}, old);
              delete next[id];
              return next;
            });
            props.toast(recycleNotice(r), r && (r.already || r.duplicate) ? "warn" : "ok");
            load(lastOnPage ? page - 1 : page);
            if (props.refresh) props.refresh();
          }).catch(function (e) {
            setPendingDelete(function (old) {
              var next = Object.assign({}, old);
              delete next[id];
              return next;
            });
            props.toast("删除失败：" + (e.message || e), "err");
          }).finally(function () {
            delete deleteBusy.current[it.id];
          });
        };
        var switchFav = function (next) {
          if (next === fav && !sessionOnly) return;
          setFav(next);
          setSessionOnly(false);
          setData(null);
        };
        var switchSession = function () {
          if (sessionOnly) return;
          setFav(false);
          setSessionOnly(true);
          setData(null);
        };
        var openLocation = function () {
          var body;
          if (fav) body = { scope: "favorites" };
          else if (sessionOnly) {
            if (!props.sessionId) return props.toast("还没有当前会话", "err");
            body = { scope: "session", sessionId: props.sessionId, sessionTitle: props.sessionTitle || "" };
          } else body = { scope: "all" };
          api.openFolder(body).then(function (r) {
            if (r && r.noImages) {
              props.toast("生成图片后自动创建文件夹", "warn");
              return;
            }
            props.toast("已打开：" + (r.path || "图片目录"), "ok");
          }).catch(function (e) { props.toast("打开位置失败：" + (e.message || e), "err"); });
        };
        var openRecycle = function () {
          api.openFolder({ scope: "recycle" }).then(function (r) {
            props.toast("已打开回收站：" + (r.path || "回收站"), "ok");
          }).catch(function (e) { props.toast("打开回收站失败：" + (e.message || e), "err"); });
        };
        var syncGallery = function () {
          var isFav = fav;
          if (!window.confirm(isFav
            ? "同步收藏夹会检查每条收藏记录在磁盘上的副本是否还在。\n\n只清理「记录还在、收藏文件已经不在」的失效收藏，不会删除任何图片文件本身。要开始吗？"
            : "同步图库会检查每条图片记录在磁盘上是否还有文件。\n\n只清理「记录还在、图片文件已经不在」的幽灵记录（images.json 和任务里的引用），不会删除任何图片文件本身。要开始吗？")) return;
          setBusy(true);
          var task = isFav ? api.syncFavorites(true) : api.syncImages(true);
          task.then(function (r) {
            if (isFav) {
              var removed = (r && r.favorites && r.favorites.removed) || 0;
              props.toast(removed
                ? "收藏同步完成：清理 " + removed + " 条失效收藏记录，图片文件没动。"
                : "收藏同步完成：没有失效收藏，图片文件没动。", "ok");
            } else {
              var n = (r && r.images && r.images.removed) || 0;
              var pruned = (r && r.jobs && r.jobs.pruned) || 0;
              props.toast(n
                ? "同步完成：清理 " + n + " 条幽灵记录，任务里去掉 " + pruned + " 条引用；图片文件没动。"
                : "同步完成：没有发现幽灵记录，图片文件没动。", "ok");
            }
            load(page);
            if (props.refresh) props.refresh();
          }).catch(function (e) {
            props.toast("同步失败：" + (e.message || e), "err");
          }).finally(function () { setBusy(false); });
        };
        var tabName = fav ? "收藏夹" : sessionOnly ? "当前会话" : "全部";

        return h("div", { className: "ac-stack" },
          h("div", { className: "ac-subtabs" },
            h("button", { className: cls("ac-subtab", sessionOnly && "on"), onClick: switchSession }, "当前会话"),
            h("button", { className: cls("ac-subtab", !fav && !sessionOnly && "on"), onClick: function () { switchFav(false); } }, "全部"),
            h("button", { className: cls("ac-subtab", fav && "on"), onClick: function () { switchFav(true); } }, "收藏夹"),
          ),
          h("div", { className: "ac-gallerybar" },
            h("span", { className: "ac-hint" }, tabName + "：" + total + " 张" + (sessionOnly && props.sessionTitle ? " · " + props.sessionTitle : "") + (data && data.ghost ? " · 隐藏 " + data.ghost + " 条幽灵记录" : "")),
            h("div", { className: "ac-galleryacts" },
              h(Btn, { small: true, variant: "ghost", onClick: openLocation }, h(Ico, { name: "folder", size: 13 }), "打开位置"),
              h(Btn, { small: true, variant: "ghost", onClick: openRecycle, title: "打开回收站位置" }, h(Ico, { name: "trash", size: 13 }), "回收站"),
              h(Btn, { small: true, disabled: busy, onClick: syncGallery }, "同步"),
              h(Btn, { small: true, variant: "ghost", onClick: function () { load(page, true); } }, "刷新"),
            ),
          ),
          h("div", { className: "ac-pager ac-pager-top" },
            h(Btn, { small: true, disabled: busy || page <= 1, onClick: function () { load(page - 1, "第 " + (page - 1) + " 页"); } }, "‹ 上一页"),
            h("span", null, page + " / " + maxPage),
            h(Btn, { small: true, disabled: busy || page >= maxPage, onClick: function () { load(page + 1, "第 " + (page + 1) + " 页"); } }, "下一页 ›"),
          ),
          !shownItems.length ? h(Empty, null, (busy || Object.keys(pendingDelete).length) ? "正在读取…" : fav ? "还没有收藏。点图片右上角的星。" : sessionOnly ? (props.sessionId ? "当前会话还没有图片。" : "还没有当前会话。") : "还没有图片。")
            : h("div", { className: "ac-gallery" }, shownItems.map(function (it, i) {
              return h("div", { key: it.id, className: "ac-cell" },
                h("div", { className: "ac-imgbox" },
                  h("img", {
                    src: it.url, alt: "", loading: "eager", decoding: "async", fetchpriority: i < 3 ? "high" : "auto",
                    onClick: function () { props.onView(it); }, style: { cursor: "zoom-in" },
                    onLoad: function (e) {
                      imgRetry.current[it.id] = 0;
                      e.currentTarget.style.visibility = "";
                    },
                    onError: function (e) {
                      var tries = imgRetry.current[it.id] || 0;
                      if (tries < 2) {
                        imgRetry.current[it.id] = tries + 1;
                        e.currentTarget.src = it.url + "?r=" + (tries + 1) + "-" + Date.now();
                        return;
                      }
                      e.currentTarget.style.visibility = "hidden";
                    },
                  }),
                  h("div", { className: "ac-tacts", style: { position: "absolute", right: 4, top: 4, display: "flex", gap: 3, opacity: 1 } },
                    h("div", { className: "ac-mini", title: it.favorited ? "取消收藏" : "收藏", onClick: function (e) { e.stopPropagation(); act(function () { return it.favorited ? api.unfavorite(it.id) : api.favorite(it.id); }, it.favorited ? "已取消收藏" : "已收藏"); } }, it.favorited ? "★" : "☆"),
                    fav ? null : h("div", { className: "ac-mini", title: "放进回收站", onClick: function (e) { e.stopPropagation(); deleteImage(it); } }, "🗑"),
                  ),
                ),
                h("div", { className: "ac-meta" },
                  h("div", { className: "ac-t", title: it.title || it.fileName }, it.title || it.fileName || ""),
                  h("div", { className: "ac-small ac-dim" }, (it.seed !== null && it.seed !== undefined ? "seed " + it.seed : "seed 未记录") + " · " + fmtTime(it.createdAt)),
                ),
              );
            })),
        );
      }

      function Lightbox(props) {
        var item = props.item;
        var [rec, setRec] = useState(null);
        var [deleting, setDeleting] = useState(false);
        var deleteGuard = useRef(false);
        useEffect(function () {
          var alive = true;
          api.image(item.id).then(function (r) { if (alive) setRec(r.image || null); }).catch(function () { /* 列表里已经带了大部分字段 */ });
          return function () { alive = false; };
        }, [item.id]);
        var cur = rec || item;
        var act = function (fn, text) {
          Promise.resolve().then(fn).then(function () { props.toast(text, "ok"); }).catch(function (e) { props.toast(e.message, "err"); });
        };
        var remove = function () {
          if (deleteGuard.current) {
            props.toast("这张图正在删除，请稍候", "warn");
            return;
          }
          deleteGuard.current = true;
          setDeleting(true);
          recycleImage(cur.id).then(function (r) {
            props.toast(recycleNotice(r), r && (r.already || r.duplicate) ? "warn" : "ok");
            // 删除成功后文件已经进回收站，继续停留只会看到黑图；直接关掉查看器。
            props.onClose();
          }).catch(function (e) {
            props.toast("删除失败：" + (e.message || e), "err");
          }).finally(function () {
            deleteGuard.current = false;
            setDeleting(false);
          });
        };
        return h("div", { className: "ac-overlay", onClick: function (e) { if (e.target === e.currentTarget) props.onClose(); } },
          h("div", { className: "ac-viewer", onClick: function (e) { e.stopPropagation(); } },
            h("div", { className: "pic" }, h("img", { src: cur.url, alt: "" })),
            h("div", { className: "side" },
              h("div", { className: "ac-row" }, h("b", null, cur.title || cur.fileName || "图片"), h("span", { style: { flex: 1 } }), h(Btn, { small: true, variant: "ghost", onClick: props.onClose }, "关闭")),
              h(KV, { rows: [
                ["文件", cur.fileName || ""],
                ["大小", fmtBytes(cur.bytes)],
                ["时间", fmtTime(cur.createdAt)],
                ["种子", cur.seed !== null && cur.seed !== undefined ? String(cur.seed) : "未记录"],
                ["会话", cur.sessionId || ""],
                ["路径", cur.absPath || ""],
              ] }),
              h("div", { className: "ac-small ac-dim" }, "正面提示词"),
              h("div", { className: "ac-code" }, cur.positive || ""),
              cur.negative ? h("div", null, h("div", { className: "ac-small ac-dim" }, "负面提示词"), h("div", { className: "ac-code" }, cur.negative)) : null,
              h("div", { className: "ac-row" },
                h(Btn, { small: true, onClick: function () { copyText(cur.positive || "").then(function () { props.toast("已复制提示词", "ok"); }); } }, "复制提示词"),
                h(Btn, { small: true, onClick: function () { act(function () { return cur.favorited ? api.unfavorite(cur.id) : api.favorite(cur.id); }, cur.favorited ? "已取消收藏" : "已收藏"); } }, cur.favorited ? "★ 取消收藏" : "☆ 收藏"),
                h(Btn, { small: true, onClick: function () { window.open(withDownload(cur.url), "_blank"); props.toast("已开始下载", "ok"); } }, "下载"),
                h(Btn, { small: true, variant: "danger", disabled: deleting, onClick: remove }, deleting ? "删除中…" : "删除"),
              ),
            ),
          ),
        );
      }

      /* ===================================================================
       * 工作流
       * =================================================================== */
      function scanOutputIds(result) {
        return result && Array.isArray(result.outputs)
          ? result.outputs.map(function (o) { return String(o.id); }).filter(Boolean)
          : [];
      }
      function defaultScanOutputIds(result) {
        if (result && Array.isArray(result.defaultOutputIds) && result.defaultOutputIds.length) {
          return result.defaultOutputIds.map(String).filter(Boolean);
        }
        var outs = result && Array.isArray(result.outputs) ? result.outputs : [];
        var pick = null;
        for (var i = 0; i < outs.length; i += 1) {
          if (/^saveimage$/i.test(String(outs[i].classType || ''))) { pick = outs[i]; break; }
        }
        if (!pick) {
          for (var j = 0; j < outs.length; j += 1) {
            if (!outs[j].isPreview) { pick = outs[j]; break; }
          }
        }
        if (!pick && outs.length) pick = outs[0];
        return pick ? [String(pick.id)] : [];
      }
      /**
       * 扫描结果回来后补两件事：
       *   1. 有「建议映射」的节点自动选上（已经手动改过的映射不覆盖，标记过就不再重填）；
       *   2. 输出节点默认只勾一个 SaveImage，已有有效勾选则保留。
       */
      function applyScanDefaults(wf, result) {
        if (!wf) return wf;
        var next = wf;
        var nodes = result && Array.isArray(result.nodes) ? result.nodes : [];
        // 自动给默认映射；界面下拉仍可纠正。mappingVersion < 2 时把旧的
        // 负面自动映射迁移成“保留原内容”，但迁移一次后用户手动选回负面不会被再清掉。
        var mappingVersion = Number(next.mappingVersion) || 0;
        var map = Object.assign({}, next.mapping || {});
        var mapChanged = false;
        nodes.forEach(function (n) {
          if (!n || !n.id) return;
          var role = n.suggestRole || (n.kind === "negative" ? "negative" : "");
          if (!role) return;
          var has = Object.prototype.hasOwnProperty.call(map, n.id);
          if (role === "negative") {
            // 负面提示词默认保留原内容，保留工作流自己的负面；用户仍可在下拉里手动选回来。
            if (!has || (mappingVersion < 2 && map[n.id] === "negative")) {
              map[n.id] = "";
              mapChanged = true;
            }
          } else if (!has) {
            map[n.id] = role;
            mapChanged = true;
          }
        });
        if (mapChanged || !next.mappingSeeded || mappingVersion < 2) {
          next = Object.assign({}, next, {
            mapping: map,
            mappingSeeded: true,
            mappingVersion: Math.max(mappingVersion, 2),
          });
        }
        var detected = scanOutputIds(result);
        if (!detected.length) return next;
        var alive = {};
        detected.forEach(function (id) { alive[id] = true; });
        var current = Array.isArray(next.outputNodes) ? next.outputNodes.map(String).filter(function (id) { return alive[id]; }) : [];
        if (!current.length) current = defaultScanOutputIds(result);
        if (!current.length) current = [detected[0]];
        var same = Array.isArray(next.outputNodes)
          && next.outputNodes.length === current.length
          && next.outputNodes.every(function (id, i) { return String(id) === current[i]; });
        if (!same) next = Object.assign({}, next, { outputNodes: current, outputSelectionVersion: 2 });
        return next;
      }
      function WorkflowsPage(props) {
        var state = props.state;
        var list = state.workflows || [];
        // initial* 只用于离线深渲染测试；正常运行不传。
        var bootWf = props.initialWorkflow || null;
        var [id, setId] = useState(bootWf ? bootWf.id : (state.activeWorkflowId || (list[0] && list[0].id) || ""));
        var [wf, setWf] = useState(bootWf ? applyScanDefaults(bootWf, props.initialScan) : bootWf);
        var [scan, setScan] = useState(props.initialScan || null);
        var [jsonText, setJsonText] = useState(bootWf ? JSON.stringify(bootWf.json || {}, null, 2) : "");
        var [busy, setBusy] = useState(false);
        var [dry, setDry] = useState(props.initialDry || null);
        var [jsonOpen, setJsonOpen] = useState(props.initialJsonOpen === true);
        var fileRef = useRef(null);
        // 「固定种子」文本框：null = 不在编辑（显示自动 / 已保存的值），字符串 = 正在输入的原文。
        var [seedDraft, setSeedDraft] = useState(null);
        var seedTimer = useRef(null);
        useEffect(function () {
          return function () { if (seedTimer.current) clearTimeout(seedTimer.current); };
        }, []);
        // 种子这类开关不走「保存」按钮也会立刻落库，否则改完忘了保存，出图还是老种子。
        var persistWf = function (p) {
          patch(p);
          if (!wf || !wf.id) return;
          if (seedTimer.current) clearTimeout(seedTimer.current);
          seedTimer.current = setTimeout(function () {
            api.updateWorkflow(wf.id, p).catch(function () { /* 落库失败不阻塞界面 */ });
          }, 400);
        };

        var loadWf = function (wid) {
          if (!wid) { setWf(null); setScan(null); setJsonText(""); return Promise.resolve(null); }
          return api.workflow(wid).then(function (r) {
            setWf(r.workflow);
            setJsonText(JSON.stringify(r.workflow.json || {}, null, 2));
            setScan(null);
            setDry(null);
            if (r.workflow.json && Object.keys(r.workflow.json).length) {
              api.scan({ workflowId: wid }).then(function (s) {
                setScan(s);
                setWf(function (old) { return applyScanDefaults(old, s); });
              }).catch(function () { /* 扫描失败不影响保存 */ });
            }
            return r.workflow;
          }).catch(function (e) { props.toast(e.message, "err"); throw e; });
        };
        useEffect(function () {
          // 新建但还没保存（id 为空）时不要回读，否则刚点「新建」就被清掉。
          if (!id && wf && !wf.id) return;
          loadWf(id).catch(function () { /* 已提示 */ });
        }, [id]);

        var reload = function () {
          if (!wf || !wf.id) return;
          loadWf(wf.id).then(function () {
            props.toast("已重新读取", "ok");
            return props.refresh();
          }).catch(function () { /* 已提示 */ });
        };
        var parseJsonOrToast = function () {
          try { return JSON.parse(jsonText || "{}"); } catch (e) { props.toast("JSON 不合法：" + e.message, "err"); return null; }
        };
        var askName = function (suggested) {
          var name = window.prompt("给这份工作流起个名字", suggested || "新工作流");
          if (name === null) return null;
          name = String(name).trim();
          return name || null;
        };
        var doSave = function (targetId, name) {
          var parsed = parseJsonOrToast();
          if (!parsed) return;
          if (typeof parsed !== "object" || Array.isArray(parsed) || !Object.keys(parsed).length) {
            return props.toast("工作流 JSON 是空的，先导入或粘贴 API JSON", "warn");
          }
          var saveOutputs = wf && Array.isArray(wf.outputNodes) && wf.outputNodes.length
            ? wf.outputNodes.map(String)
            : defaultScanOutputIds(scan);
          setBusy(true);
          var body = {
            id: targetId || undefined,
            name: name || "新工作流",
            json: parsed,
            mapping: wf ? wf.mapping : {},
            mappingSeeded: wf ? wf.mappingSeeded === true : false,
            mappingVersion: wf ? (Number(wf.mappingVersion) || 0) : 0,
            outputNodes: saveOutputs,
            outputSelectionVersion: 2,
            tokenEmpty: "blank",
            size: wf ? wf.size : null,
            sizeMode: wf ? wf.sizeMode : "manual",
            randomSeed: wf ? wf.randomSeed : true,
            seed: wf && wf.seed !== undefined && wf.seed !== null && Number.isFinite(Number(wf.seed)) ? Math.round(Number(wf.seed)) : null,
            pruneOutputs: wf ? wf.pruneOutputs : true,
            onlyFirst: true,
          };
          api.saveWorkflow(body).then(function (r) {
            setWf(r.workflow);
            setId(r.workflow.id);
            return api.activateWorkflow(r.workflow.id).then(function () {
              props.toast("已保存并启用这份预设", "ok");
              return props.refresh();
            });
          }).catch(function (e) { props.toast(e.message, "err"); }).finally(function () { setBusy(false); });
        };
        var save = function () {
          if (!wf) return;
          var asNew = !wf.id;
          var name = wf.name || "新工作流";
          if (asNew) {
            // 新建 / 刚导入的草稿第一次保存时先命名，避免又出现一堆「新工作流」。
            name = askName(name);
            if (name === null) return;
          }
          doSave(asNew ? undefined : wf.id, name);
        };
        var saveAsNew = function () {
          if (!wf) return props.toast("先新建或导入一份工作流", "warn");
          var name = askName(wf.name && wf.name !== "新工作流" ? wf.name : "新工作流");
          if (name === null) return;
          doSave(undefined, name);
        };
        var create = function () {
          setWf({ id: "", name: "新工作流", json: {}, mapping: {}, mappingSeeded: false, mappingVersion: 0, outputNodes: [], outputSelectionVersion: 2, size: null, sizeMode: "manual", randomSeed: true, seed: null, lastSeed: null, pruneOutputs: true, onlyFirst: false, loraState: null });
          setId("");
          setJsonText("{}");
          setScan(null);
          setDry(null);
          setJsonOpen(true);
          props.toast("已新建草稿；填好 JSON 后点「保存」或「新建并保存」", "ok");
        };
        var rename = function () {
          if (!wf) return;
          var name = window.prompt("工作流名称", wf.name || "");
          if (name === null) return;
          name = String(name).trim();
          if (!name) return;
          setWf(Object.assign({}, wf, { name: name }));
          if (wf.id) {
            api.updateWorkflow(wf.id, { name: name }).then(function () { props.toast("已重命名", "ok"); props.refresh(); }).catch(function (e) { props.toast(e.message, "err"); });
          } else {
            props.toast("已重命名（还没保存）", "ok");
          }
        };
        var patch = function (p) {
          setWf(function (old) { return old ? Object.assign({}, old, p) : old; });
        };
        // 固定种子：自动模式只读，显示上一轮实际用的种子；取消自动后可以手填，
        // 填的数字会随保存写进工作流，出图时覆盖每一处字面量 seed。
        var seedAuto = !wf || wf.randomSeed !== false;
        var seedDisplay = seedAuto
          ? (wf && wf.lastSeed !== null && wf.lastSeed !== undefined ? String(wf.lastSeed) : "")
          : (wf && wf.seed !== null && wf.seed !== undefined ? String(wf.seed) : "");
        var editSeed = function (value) {
          setSeedDraft(value);
          var n = Number(value);
          if (String(value).trim() !== "" && isFinite(n) && n >= 0) patch({ seed: Math.round(n) });
        };
        var commitSeed = function (value) {
          setSeedDraft(null);
          var raw = String(value === undefined || value === null ? "" : value).trim();
          if (raw === "") { persistWf({ seed: null }); return; }
          var n = Number(raw);
          if (!isFinite(n)) { persistWf({ seed: null }); return; }
          persistWf({ seed: Math.max(0, Math.min(9007199254740991, Math.round(n))) });
        };
        var toggleRandomSeed = function (on) {
          if (on) { persistWf({ randomSeed: true }); return; }
          // 取消自动时顺手把「上一轮用的种子」带过来，省得再手敲一遍。
          var carry = wf.seed !== null && wf.seed !== undefined ? wf.seed
            : (wf.lastSeed !== null && wf.lastSeed !== undefined ? wf.lastSeed : null);
          persistWf({ randomSeed: false, seed: carry });
        };
        var mapping = (wf && wf.mapping) || {};
        var setMapping = function (nodeId, role) {
          var next = Object.assign({}, mapping);
          // 空字符串是“明确保留原内容”，不能删除键，否则扫描默认值会把它重新选回来。
          next[nodeId] = role || "";
          patch({ mapping: next, mappingSeeded: true });
        };
        var outputNodes = ((wf && Array.isArray(wf.outputNodes) && wf.outputNodes.length)
          ? wf.outputNodes
          : defaultScanOutputIds(scan)).map(String);
        var toggleOutput = function (nid) {
          var set = new Set(outputNodes);
          if (set.has(nid)) set.delete(nid); else set.add(nid);
          if (!set.size) return props.toast("至少要勾选一个图片输出节点", "warn");
          patch({ outputNodes: Array.from(set), outputSelectionVersion: 2 });
        };
        var nodes = scan ? scan.nodes || [] : [];
        var detectedRoleOf = function (n) {
          if (!n) return "";
          if (n.suggestRole === "positive" || n.suggestRole === "negative" || n.suggestRole === "size") return n.suggestRole;
          if (n.kind === "positive") return "positive";
          if (n.kind === "negative") return "negative";
          if (n.kind === "size" || n.mode === "size") return "size";
          if (n.kind === "token" && n.tokenName === "%negative_prompt%") return "negative";
          if (n.kind === "token") return "positive";
          // LoRA 堆 / 单 LoRA 也作为独立条目展示，方便以后接散装节点；
          // 它们不参与正负面 / 分辨率映射。
          if (n.kind === "loraStack" || n.kind === "lora" || n.mode === "lora") return "lora";
          return "";
        };
        var roleOf = function (n) {
          if (!n) return "";
          var hasMapped = Object.prototype.hasOwnProperty.call(mapping, n.id);
          if (hasMapped) {
            var mapped = mapping[n.id];
            if (mapped === "positive" || mapped === "negative" || mapped === "size") return mapped;
            // 明确选了“保留原内容”就不要回退到 suggestRole。
            if (!mapped) return "";
          }
          return detectedRoleOf(n);
        };
        var roleLabel = { positive: "正面提示词", negative: "负面提示词", size: "分辨率" };
        // 固定三行：分辨率 / 正面提示词 / 负面提示词。即使没检测到也保留，
        // 显示「未检测到」，不再因为节点缺失而整行消失。
        // LoRA 节点不在这里展示。
        var roleTone = { size: "acc", positive: "ok", negative: "warn" };
        var roleScore = function (n) {
          // 同一个角色可能有多个候选（前缀文本 / 上游正文）：占位符最可信，其次看正文长度。
          var score = Number(n.valueLength) || 0;
          if (n.kind === "token" || n.hasPositiveToken || n.hasNegativeToken) score += 100000;
          if (n.kind === "positive" || n.kind === "negative" || n.kind === "size") score += 1000;
          return score;
        };
        var relevantNodes = ["size", "positive", "negative"].map(function (role) {
          var found = null;
          var foundScore = -1;
          for (var i = 0; i < nodes.length; i += 1) {
            var n = nodes[i];
            if (!n || !n.id) continue;
            if (detectedRoleOf(n) !== role) continue;
            var score = roleScore(n);
            if (score <= foundScore) continue;
            found = n;
            foundScore = score;
          }
          return {
            roleKey: role,
            n: found,
            role: found ? roleOf(found) : "",
            label: found ? (found.label || roleLabel[role]) : roleLabel[role],
            tone: roleTone[role],
            missing: !found,
          };
        });
        var tokenCounts = (scan && scan.tokens) || {};
        var tokenDefs = [
          { key: "positive", token: "%prompt%", label: "正面" },
          { key: "negative", token: "%negative_prompt%", label: "负面" },
          { key: "width", token: "%width%", label: "宽" },
          { key: "height", token: "%height%", label: "高" },
        ].map(function (t) {
          return { token: t.token, label: t.label, count: Number(tokenCounts[t.key]) || 0 };
        });
        var dryReport = dry && dry.report ? dry.report : dry;
        var loraDetected = dry && dry.loraDetected ? dry.loraDetected : null;
        var loraDetectedStacks = loraDetected ? Number(loraDetected.stacks) || 0 : 0;
        var loraDetectedEntries = loraDetected ? Number(loraDetected.entries) || 0 : 0;
        var loraManaged = dryReport && dryReport.lora && dryReport.lora.applied
          ? (dryReport.lora.stacks || []).length : 0;
        var loraManagedEntries = dryReport && dryReport.lora && dryReport.lora.applied
          ? (dryReport.lora.stacks || []).reduce(function (n, st) { return n + ((st.entries || []).length); }, 0) : 0;
        if (!loraDetectedEntries && loraManagedEntries) loraDetectedEntries = loraManagedEntries;
        var loraLine;
        if (loraManaged) {
          loraLine = "检测到 " + Math.max(loraDetectedStacks, loraManaged) + " 个 LoRA 节点 / " + loraDetectedEntries + " 个条目；已接管 " + loraManaged + " 个";
        } else if (loraDetectedStacks) {
          loraLine = "检测到 " + loraDetectedStacks + " 个 LoRA 节点 / " + loraDetectedEntries + " 个条目；当前按工作流原样（LoRA 页还没有开关覆盖）";
        } else {
          loraLine = "未检测到 LoRA 节点";
        }

        return h("div", { className: "ac-stack" },
          h(Card, {
            title: "选择工作流预设", actions: h("div", { className: "ac-actions" },
              h(Btn, {
                small: true, variant: "primary", disabled: !wf || busy, onClick: saveAsNew,
                title: "把当前 JSON 保存成一份新的工作流，会先弹出命名框",
              }, "新建并保存"),
              h(Btn, { small: true, onClick: save, disabled: !wf || busy }, busy ? "保存中…" : "保存"),
              h(Btn, { small: true, disabled: !wf, onClick: rename }, "重命名"),
              h(Btn, { small: true, disabled: !wf || !wf.id, onClick: reload }, "重新读取"),
              h(Btn, {
                small: true, variant: "danger", disabled: !wf || !wf.id, onClick: function () {
                  if (!window.confirm("删除这份工作流？（图片不会删）")) return;
                  api.delWorkflow(wf.id).then(function () { setId(""); setWf(null); props.toast("已删除", "ok"); return props.refresh(); }).catch(function (e) { props.toast(e.message, "err"); });
                },
              }, "删除"),
            ),
          },
            h(Select, {
              value: id || "", onChange: function (e) {
                var v = e.target.value;
                if (!v) {
                  create();
                  return;
                }
                setId(v);
                api.activateWorkflow(v).then(function () {
                  return props.refresh();
                }).catch(function (e) { props.toast(e.message, "err"); });
              },
            },
              h("option", { value: "" }, "＋ 新建工作流"),
              list.map(function (w) {
                return h("option", { key: w.id, value: w.id }, w.name + (w.active ? " · 当前" : ""));
              }),
            ),
            h("div", { className: "ac-hint", style: { marginTop: 6 } },
              "导入 JSON 后点「保存为新工作流」；该界面修改完记得点保存，不涉及 lora 相关",
            ),
          ),

          !wf ? h(Empty, null, "还没有选择工作流。")
            : h("div", { className: "ac-stack" },
              h(Card, { title: "工作流 JSON", actions: h(Btn, { small: true, variant: "ghost", onClick: function () { setJsonOpen(function (v) { return !v; }); } }, jsonOpen ? "收起" : "展开") },
                !jsonOpen ? h("div", { className: "ac-hint" }, "在这里导入和测试工作流文件")
                  : h("div", null,
                    h(TextArea, { rows: 10, className: "ac-json", value: jsonText, onChange: function (e) { setJsonText(e.target.value); } }),
                    h("div", { className: "ac-actions ac-jsonacts" },
                      h(Btn, { small: true, className: "ac-filepick", onClick: function () { props.toast("请选择 ComfyUI API JSON 文件", "ok"); if (fileRef.current) fileRef.current.click(); } }, "导入JSON"),
                      h(Btn, { small: true, onClick: function () {
                        var parsed;
                        try { parsed = JSON.parse(jsonText || "{}"); } catch (e) { return props.toast("JSON 不合法：" + e.message, "err"); }
                        api.scan({ json: parsed }).then(function (r) {
                          setScan(r);
                          setWf(function (old) { return applyScanDefaults(old, r); });
                          props.toast("解析：" + r.nodeCount + " 个节点" + (r.outputs && r.outputs.length ? " · " + r.outputs.length + " 个输出节点" : ""), "ok");
                        }).catch(function (e) { props.toast(e.message, "err"); });
                      } }, "解析预览"),
                      h(Btn, { small: true, onClick: function () {
                        var parsed;
                        try { parsed = JSON.parse(jsonText || "{}"); } catch (e) { return props.toast("JSON 不合法：" + e.message, "err"); }
                        api.dryRun({ workflowId: wf.id, json: parsed, mapping: wf.mapping, positive: "test, 1girl, solo", negative: "bad", size: wf.size, sizeMode: wf.sizeMode }).then(function (r) {
                          setDry({
                            report: r.report,
                            loraDetected: r.loraDetected,
                          });
                          var sz = r.report.size || {};
                          var req = sz.requested ? sz.requested.w + "×" + sz.requested.h : "";
                          var sizeMsg = sz.writes && sz.writes.length
                            ? "分辨率 已写 " + sz.writes.length + " 处" + (req ? "（" + req + "）" : "")
                            : sz.matched
                              ? "分辨率已是 " + (req || "目标值") + "，无需改动"
                              : "分辨率没有可用值";
                          props.toast(r.report.positiveApplied ? "正面已注入；" + sizeMsg : "没有任何提示词被注入", r.report.positiveApplied ? "ok" : "err");
                        }).catch(function (e) { props.toast(e.message, "err"); });
                      } }, "干跑"),
                      h(Btn, {
                        small: true, variant: "primary", disabled: !wf || busy, onClick: saveAsNew,
                        title: "把当前 JSON 存成新工作流；会先弹出命名框",
                      }, "保存为新工作流"),
                      h("span", { className: "ac-hint" }, "导入 JSON 后点「保存为新工作流」；新建保存会先命名"),
                      h("input", {
                        ref: fileRef, type: "file", accept: ".json,application/json", style: { display: "none" },
                        onChange: function (e) {
                          var f = e.target.files && e.target.files[0];
                          if (!f) return;
                          var rd = new FileReader();
                          rd.onload = function () {
                            var text = String(rd.result || "{}");
                            var parsed;
                            try { parsed = JSON.parse(text); } catch (e) { return props.toast("JSON 不合法：" + e.message, "err"); }
                            var baseName = String(f.name || "").replace(/\.json$/i, "").trim() || "新工作流";
                            setJsonText(text);
                            // 导入一律作为新草稿：不覆盖当前已有工作流，保存时会先命名。
                            setWf({
                              id: "", name: baseName, json: {},
                              mapping: {}, mappingSeeded: false, mappingVersion: 0,
                              outputNodes: [], outputSelectionVersion: 2,
                              size: null, sizeMode: "manual",
                              randomSeed: true, pruneOutputs: true, onlyFirst: false, loraState: null,
                            });
                            setId("");
                            setScan(null);
                            setDry(null);
                            props.toast("已导入为草稿；点「保存为新工作流」命名并保存", "ok");
                            // 顺手解析一次，让可映射节点 / 输出节点直接出来，不用再点解析预览。
                            api.scan({ json: parsed }).then(function (r) {
                              setScan(r);
                              setWf(function (old) { return applyScanDefaults(old, r); });
                            }).catch(function (e) {
                              props.toast("已导入草稿，但这不是可用的 API 工作流：" + e.message, "err");
                            });
                          };
                          rd.readAsText(f, "utf-8");
                          e.target.value = "";
                        },
                      }),
                    ),
                    h("div", { className: "ac-hint", style: { marginTop: 5 } }, "必须是 ComfyUI「工作流 → 导出 (API)」的 JSON；不是普通 workflow.json。"),
                  ),
              ),

              dry ? h(Card, { title: "干跑报告" },
                h(KV, { rows: [
                  ["正面", dryReport.positiveApplied ? "已注入" : "未注入"],
                  ["负面", dryReport.negativeApplied ? "已注入" : "未注入"],
                  ["分辨率", !dryReport.size ? "没有可用分辨率"
                    : dryReport.size.writes && dryReport.size.writes.length
                      ? "已写 " + JSON.stringify(dryReport.size.writes)
                      : dryReport.size.matched
                        ? "已是 " + (dryReport.size.requested ? dryReport.size.requested.w + "×" + dryReport.size.requested.h : "目标值") + "（" + dryReport.size.matched + " 处已对齐，不用改）"
                        : "没有可用分辨率（没映射分辨率节点，也没有 %width%/%height%）"],
                  ["种子", dryReport.seeds && dryReport.seeds.length ? "重摇 " + dryReport.seeds.length + " 个" : "没动"],
                  ["LoRA", loraLine],
                ] }),
              ) : null,

              h(Card, {
                title: "可映射节点",
                actions: h("span", { className: "ac-hint" }, "固定 3 项"),
              },
                  h("div", { className: "ac-maprows" }, relevantNodes.map(function (item) {
                    var n = item.n;
                    return h("div", { key: item.roleKey, className: cls("ac-maprow", item.missing && "missing") },
                      h("div", { className: "ac-mapnode", title: n ? "#" + n.id + " · " + (n.classType || "") + (n.title ? " · " + n.title : "") : "未检测到" },
                        n ? ("#" + n.id + " · " + (n.classType || "") + (n.title ? " · " + n.title : "")) : "未检测到"),
                      h("div", { className: "ac-mapmeta" },
                        h("span", { className: "ac-maprole" },
                          h(Pill, { tone: item.missing ? null : item.tone, title: item.label }, item.label),
                        ),
                        n
                          ? h(Select, {
                            className: "ac-mapselect",
                            value: item.role || "",
                            onChange: function (e) { setMapping(n.id, e.target.value); },
                          },
                            h("option", { value: "" }, "保留原内容"),
                            h("option", { value: "size" }, "分辨率"),
                            h("option", { value: "positive" }, "正面提示词"),
                            h("option", { value: "negative" }, "负面提示词"),
                          )
                          : h(Select, {
                            className: "ac-mapselect",
                            value: "",
                            disabled: true,
                            title: "没有检测到这类节点",
                          }, h("option", { value: "" }, "未检测到")),
                      ),
                    );
                  })),
                  h("div", { className: "ac-tokenlist" },
                    tokenDefs.map(function (t) {
                      return h("span", { key: t.token, className: cls("ac-tokenitem", t.count ? "" : "muted") },
                        h("span", { className: "ac-tokenlabel" }, t.label),
                        h("code", {
                          className: "ac-tokenlink", title: "点击复制 " + t.token + "（全局替换）",
                          onClick: function () {
                            copyText(t.token).then(function () { props.toast("已复制 " + t.token, "ok"); }).catch(function (e) { props.toast("复制失败：" + (e.message || e), "err"); });
                          },
                        }, t.token),
                        h("span", { className: "ac-tokencount" }, "×" + t.count),
                      );
                    }),
                  ),
                h("div", { className: "ac-hint", style: { marginTop: 6 } }, "点击占位符复制；宽高占位符也参与全局替换。"),
              ),

              h(Card, { title: "图片输出相关" },
                h("div", { className: "ac-subtitle" }, "输出节点"),
                scan && scan.outputs && scan.outputs.length
                  ? h("div", null,
                    h("div", { className: "ac-monolist", style: { maxHeight: 170 } },
                      scan.outputs.map(function (o) {
                        return h("label", { key: o.id, className: "ac-inline", style: { display: "flex", padding: "4px 3px" } },
                          h("input", { type: "checkbox", checked: outputNodes.indexOf(String(o.id)) >= 0, onChange: function () { toggleOutput(String(o.id)); } }),
                          h("span", { className: "ac-ell", style: { minWidth: 0 } }, "#" + o.id + " " + o.classType + " " + (o.title || "")),
                          h("span", { className: "ac-dim ac-small", style: { flex: "none" } }, o.isPreview ? "预览" : "保存"),
                        );
                      }),
                    ),
                    h("div", { className: "ac-hint", style: { marginTop: 6 } }, "默认只勾一个 SaveImage 节点；需要保留其它输出可以自己再勾，至少保留一个。"),
                  )
                  : h("div", { className: "ac-hint" },
                    scan ? "没有识别到图片输出节点。工作流里需要有 SaveImage / PreviewImage 节点。" : "正在读取节点…"),
                h("div", { className: "ac-subtitle", style: { marginTop: 12 } }, "额外设置"),
                h("div", { className: "ac-form" },
                  h("div", { className: "ac-row" },
                    h(Switch, { checked: wf.randomSeed !== false, onChange: function (e) { toggleRandomSeed(e.target.checked); } }, "每次换随机种子"),
                  ),
                  h("div", { className: "ac-row" },
                    h(Field, { label: "固定种子" }, h(TextInput, {
                      value: seedDraft !== null ? seedDraft : seedDisplay,
                      disabled: seedAuto,
                      placeholder: seedAuto ? "自动（显示上一轮用的种子）" : "填一个整数，每轮都用它",
                      title: seedAuto
                        ? "自动换种子时只读：显示上一轮实际用的种子；取消上面勾选即可编辑"
                        : "取消自动后，这里填的数字会写进工作流，每轮都用它",
                      onChange: function (e) { editSeed(e.target.value); },
                      onBlur: function (e) { commitSeed(e.target.value); },
                      onKeyDown: function (e) { if (e.key === "Enter") e.currentTarget.blur(); },
                    })),
                    h("span", { className: "ac-hint" }, seedAuto ? "自动：每轮随机" : "固定：每轮都用这个种子"),
                  ),
                  h("div", { className: "ac-row" },
                    h(Switch, { checked: wf.pruneOutputs !== false, onChange: function (e) { patch({ pruneOutputs: e.target.checked }); } }, "提交前裁剪输出节点（只提交上面勾选的）"),
                  ),
                  h("div", { className: "ac-row" },
                    h(Switch, { checked: wf.blackRetry !== false, onChange: function (e) { persistWf({ blackRetry: e.target.checked }); } }, "黑图自动替换"),
                    h("span", { className: "ac-hint" }, wf.blackRetry !== false
                      ? "出图后检测到纯黑图就自动换种子重生成；进行中可在图片框菜单点「终止」"
                      : "已关闭：纯黑图不再自动替换"),
                  ),
                ),
              ),
            ),
        );
      }

      /* ===================================================================
       * LoRA（独立菜单；默认接管，实时生效）
       * =================================================================== */
      function LoraPage(props) {
        var state = props.state;
        var list = state.workflows || [];
        var [workflowId, setWorkflowId] = useState(props.initialWorkflowId || state.activeWorkflowId || (list[0] && list[0].id) || "");
        var [data, setData] = useState(props.initialData || null);
        var [busy, setBusy] = useState(false);
        var [openWords, setOpenWords] = useState({});
        var [collapsedStacks, setCollapsedStacks] = useState({});
        var [dragFrom, setDragFrom] = useState(null);
        var [dropTo, setDropTo] = useState(null);
        var dropRef = useRef(null);
        // 点 LoRA 名字就地改名：输入期间只改本地草稿，回车 / 失焦才写进 loraState。
        var [nameEdit, setNameEdit] = useState(null);
        // 强度输入：输入期间只改文本框（允许「-」「-.5」这种中间态），失焦 / 回车才夹到 -5..5 写回。
        // 以前每按一次键就 Number()，"-" 会变成 NaN 被弹回去，负数根本打不进去。
        var [numText, setNumText] = useState({});
        var nameEditRef = useRef(null);
        var applyTimer = useRef(null);
        // 所有临时覆盖串行发送：保存到工作流时先等已发出的覆盖落地，
        // 再写记录 / 清运行时，避免旧请求晚到把徽标又改回「临时覆盖」。
        var applyChain = useRef(Promise.resolve());

        var load = function (refresh) {
          if (!workflowId) { setData(null); return Promise.resolve(null); }
          setBusy(true);
          return api.loras({ workflowId: workflowId, refresh: !!refresh })
            .then(function (r) { setData(r); return r; })
            .catch(function (e) { props.toast(e.message, "err"); throw e; })
            .finally(function () { setBusy(false); });
        };
        useEffect(function () {
          // 换工作流时节点 id 可能重复，折叠状态不能跨工作流继承。
          setCollapsedStacks({});
          // 正在改名的输入也属于旧工作流，换工作流时直接取消，别提交到同名节点上。
          nameEditRef.current = null;
          setNameEdit(null);
          load(false).catch(function () { /* 已提示 */ });
        }, [workflowId]);
        useEffect(function () {
          // 工作流页切换预设后，LoRA 页始终跟随当前工作流；不再单独选。
          if (state.activeWorkflowId && state.activeWorkflowId !== workflowId) setWorkflowId(state.activeWorkflowId);
        }, [state.activeWorkflowId]);
        useEffect(function () {
          return function () { if (applyTimer.current) clearTimeout(applyTimer.current); };
        }, []);

        var buildState = function (next) {
          var stacks = {};
          (next.stacks || []).forEach(function (st) {
            stacks[st.nodeId] = st.entries.map(function (e) {
              var row = {
                name: e.name, on: e.active, strength: e.strength, clip: e.clipStrength,
                words: e.words || [], wordsOff: e.wordsOff || [],
              };
              // 自定义显示名跟着工作流记录走；没改就留空，重置 / 换工作流会回到默认名。
              var label = e.labelCustom && String(e.label || "").trim() ? String(e.label).trim() : "";
              if (label) row.label = label;
              return row;
            });
          });
          return { stacks: stacks, switches: {} };
        };
        var queueApply = function (payload) {
          var run = applyChain.current.catch(function () { /* 上一条失败也继续 */ }).then(function () {
            return api.lorasApply({ workflowId: workflowId, loraState: payload });
          });
          applyChain.current = run.catch(function () { /* 保持队列可继续 */ });
          return run;
        };
        var scheduleApply = function (next, immediate) {
          // 改动一发生就先把徽标切成「临时覆盖」，不要等后端回包 / 保存。
          next.state = Object.assign({}, next.state || {}, {
            effectiveSource: "temporary",
            temporary: true,
          });
          setData(next);
          var payload = buildState(next);
          if (applyTimer.current) clearTimeout(applyTimer.current);
          var send = function () {
            queueApply(payload).catch(function (e) { props.toast(e.message, "err"); });
          };
          if (immediate) send(); else applyTimer.current = setTimeout(send, 260);
        };
        var numKey = function (stackId, idx) { return stackId + ":" + idx; };
        // 强度：输入时先别夹、也别丢原文；失焦 / 回车才落到 -5..5。
        var editStrength = function (stackId, idx, raw) {
          setNumText(function (old) {
            var n = Object.assign({}, old);
            n[numKey(stackId, idx)] = String(raw);
            return n;
          });
          var v = Number(raw);
          if (String(raw).trim() !== "" && isFinite(v)) {
            updateEntry(stackId, idx, { strength: v, clipStrength: v });
          }
        };
        var commitStrength = function (stackId, idx, raw) {
          setNumText(function (old) {
            var n = Object.assign({}, old);
            delete n[numKey(stackId, idx)];
            return n;
          });
          if (String(raw === undefined || raw === null ? "" : raw).trim() === "") return;
          var v = Math.round(clamp(raw, -5, 5) * 100) / 100;
          updateEntry(stackId, idx, { strength: v, clipStrength: v });
        };
        var updateEntry = function (stackId, idx, patch, immediate) {
          if (!data) return;
          var next = JSON.parse(JSON.stringify(data));
          var st = next.stacks.find(function (x) { return x.nodeId === stackId; });
          if (!st) return;
          Object.assign(st.entries[idx], patch);
          scheduleApply(next, immediate);
        };
        var setEditingName = function (next) {
          nameEditRef.current = next;
          setNameEdit(next);
        };
        var beginNameEdit = function (stackId, idx, value) {
          setEditingName({ stackId: stackId, index: idx, value: String(value || "") });
        };
        var cancelNameEdit = function () {
          setEditingName(null);
        };
        var updateNameDraft = function (value) {
          var cur = nameEditRef.current;
          if (!cur) return;
          setEditingName(Object.assign({}, cur, { value: String(value || "") }));
        };
        var commitNameEdit = function () {
          var cur = nameEditRef.current;
          if (!cur) return;
          setEditingName(null);
          if (!data) return;
          var st = (data.stacks || []).find(function (x) { return x.nodeId === cur.stackId; });
          var e = st && st.entries ? st.entries[cur.index] : null;
          if (!e) return;
          var value = String(cur.value || "").trim();
          var def = String(e.labelDefault || e.name || "").trim();
          var isCustom = !!value && value !== def;
          var nextLabel = isCustom ? value : def;
          if (nextLabel === String(e.label || "") && isCustom === !!e.labelCustom) return;
          updateEntry(cur.stackId, cur.index, { label: nextLabel, labelCustom: isCustom }, true);
        };
        var moveEntry = function (stackId, from, targetIndex, after) {
          if (!data || from === targetIndex) return;
          var next = JSON.parse(JSON.stringify(data));
          var st = next.stacks.find(function (x) { return x.nodeId === stackId; });
          if (!st || !st.entries[from] || !st.entries[targetIndex]) return;
          var at = targetIndex + (after ? 1 : 0);
          var row = st.entries.splice(from, 1)[0];
          if (from < at) at -= 1;
          st.entries.splice(Math.max(0, Math.min(st.entries.length, at)), 0, row);
          scheduleApply(next, true);
        };

        // 用 pointer 事件排序，彻底避开浏览器原生的「拖起一个元素」幽灵图 / 选中文字。
        useEffect(function () {
          if (!dragFrom) return undefined;
          var prevSelect = "";
          try {
            prevSelect = document.body.style.userSelect || "";
            document.body.style.userSelect = "none";
          } catch (e) { /* ignore */ }
          var onMove = function (ev) {
            var row = null;
            try {
              var el = document.elementFromPoint ? document.elementFromPoint(ev.clientX, ev.clientY) : null;
              row = el && el.closest ? el.closest("[data-lora-row]") : null;
            } catch (e) { row = null; }
            if (!row) {
              dropRef.current = null;
              setDropTo(null);
              return;
            }
            var sid = row.getAttribute("data-lora-stack") || "";
            var idx = Number(row.getAttribute("data-lora-index"));
            if (sid !== dragFrom.stackId || !Number.isFinite(idx)) {
              dropRef.current = null;
              setDropTo(null);
              return;
            }
            var r = row.getBoundingClientRect();
            var after = ev.clientY > r.top + r.height / 2;
            var next = { stackId: sid, index: idx, after: after };
            dropRef.current = next;
            setDropTo(function (old) {
              if (old && old.stackId === next.stackId && old.index === next.index && old.after === next.after) return old;
              return next;
            });
          };
          var onUp = function () {
            var target = dropRef.current;
            if (target && target.stackId === dragFrom.stackId) {
              moveEntry(dragFrom.stackId, dragFrom.index, target.index, target.after);
            }
            dropRef.current = null;
            setDragFrom(null);
            setDropTo(null);
          };
          try {
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
            window.addEventListener("pointercancel", onUp);
          } catch (e) { /* ignore */ }
          return function () {
            try {
              window.removeEventListener("pointermove", onMove);
              window.removeEventListener("pointerup", onUp);
              window.removeEventListener("pointercancel", onUp);
              document.body.style.userSelect = prevSelect;
            } catch (e) { /* ignore */ }
          };
        }, [dragFrom]);
        var saveToWorkflow = function () {
          if (!data) return;
          // 先把还没发出去的 260ms 临时覆盖取消，否则保存后它可能又把
          // 运行时覆盖写回来，徽标会再次变回「临时覆盖」。
          if (applyTimer.current) { clearTimeout(applyTimer.current); applyTimer.current = null; }
          var savedState = buildState(data);
          applyChain.current.catch(function () { /* 继续保存 */ })
            .then(function () { return api.updateWorkflow(workflowId, { loraState: savedState }); })
            // 保存到工作流记录后清掉运行时临时覆盖：徽标回到「按工作流原样」，
            // 之后出图直接读工作流记录。这里不需要再去工作流页点保存。
            .then(function () { return api.lorasApply({ workflowId: workflowId }); })
            .then(function () {
              props.toast("已保存到工作流（无需再去工作流页保存）", "ok");
              return load(false);
            })
            .then(function () { props.refresh(); })
            .catch(function (e) { props.toast(e.message, "err"); });
        };
        var reset = function () {
          api.lorasReset({ workflowId: workflowId })
            .then(function () { props.toast("已重置", "ok"); load(true).catch(function () { /* 已提示 */ }); props.refresh(); })
            .catch(function (e) { props.toast(e.message, "err"); });
        };

        var loraSource = data && data.state ? data.state.effectiveSource : "none";
        var loraTemporary = loraSource === "temporary";
        // 两个状态气泡放进 Card 的 subtitle：直接在「LoRA」标题底下、标题区横线之上。
        var loraBadges = h(React.Fragment, null,
          h(Pill, {
            tone: loraTemporary ? "warn" : null,
            title: loraTemporary
              ? "刚刚改过，只是运行时临时覆盖；重启 DSH 会丢失，点「保存到工作流」才会写进记录"
              : loraSource === "record"
                ? "已保存到工作流记录，当前按这份记录出图；不需要再去工作流页点保存"
                : "没有覆盖记录；按工作流 JSON 里的 LoRA 原样",
          }, loraTemporary ? "临时覆盖（未保存）" : "按工作流原样"),
          data && data.catalog ? h(Pill, {
            title: "这是 ComfyUI / LoraManager 里可选的 LoRA 总数，不是当前工作流的堆数" + (data.catalog.error ? "\n" + data.catalog.error : ""),
          }, "LoRA 目录 " + data.catalog.count + " 个 · " + data.catalog.source) : null,
        );

        var allStacks = (data && data.stacks) || [];
        // 分类：kind=manager 是真正的「LoRA 堆」，可折叠、可拖动排序；
        // 其它（单 LoraLoader / Power / Stacker / Tag）是「普通 LoRA 节点」，
        // 按工作流顺序列出，只改强度或开关。
        var groupOf = function (st) {
          if (!st) return "loose";
          if (st.group === "stack" || st.group === "loose") return st.group;
          return !st.kind || st.kind === "manager" || st.kind === "loraStack" ? "stack" : "loose";
        };
        var stackItems = allStacks.filter(function (st) { return groupOf(st) === "stack"; });
        var looseItems = allStacks.filter(function (st) { return groupOf(st) === "loose"; }).slice()
          .sort(function (a, b) {
            var ao = Number(a.order);
            var bo = Number(b.order);
            if (Number.isFinite(ao) && Number.isFinite(bo) && ao !== bo) return ao - bo;
            return 0;
          });
        // 连续图设置会按档位改写选中那条 LoRA 的强度（并强制打开）：
        // 对应的行只作展示，开关 / 强度 / 触发词 / 名字都置灰，但排序仍可拖动。
        var contCfg = (state.config.generation && state.config.generation.continuous) || {};
        var contOn = contCfg.on === true;
        // 和 Host 的 continuousTarget 保持一致：一档合法强度都没有时不会接管，
        // 这时 LoRA 页的开关 / 强度仍然有效，不能误灰。
        var contStrengths = Array.isArray(contCfg.strengths) ? contCfg.strengths : [];
        var contHasStrength = contStrengths.some(function (v) {
          return typeof v === "number" && Number.isFinite(v);
        });
        var contRaw = String(contCfg.lora || "");
        var contSplit = contRaw.indexOf("::");
        var contNodeId = contSplit > 0 ? String(contRaw.slice(0, contSplit)).trim() : "";
        var contName = contSplit > 0 ? String(contRaw.slice(contSplit + 2)) : "";
        var looseLora = function (name) {
          var s = String(name || "").trim().replace(/\\/g, "/");
          var i = s.lastIndexOf("/");
          if (i >= 0) s = s.slice(i + 1);
          s = s.replace(/\.(safetensors|ckpt|pt|bin)$/i, "");
          return s.toLowerCase().replace(/[\s_\-.]/g, "");
        };
        var contNameKey = contName ? looseLora(contName) : "";
        var isContTaken = function (st, e) {
          if (!contOn || !contHasStrength || !contNodeId || !contNameKey) return false;
          if (String(st.nodeId) !== contNodeId) return false;
          return looseLora(e.name) === contNameKey;
        };
        var toggleStack = function (id) {
          setCollapsedStacks(function (o) {
            var n = Object.assign({}, o);
            n[id] = !n[id];
            return n;
          });
        };
        var toggleTitleOf = function (st) {
          if (st.kind === "single") return "关闭会把模型 / CLIP 强度写 0（不删节点，连线不变）";
          if (st.kind === "power") return "关闭会把 on 写成 false";
          if (st.kind === "stacker") return "关闭会把强度写 0";
          if (st.kind === "tags") return "关闭会从文本里移除这个 <lora:...> 标签";
          return "关闭这一条 LoRA";
        };
        var renderEntryRow = function (st, e, i, canSort) {
          var open = !!openWords[st.nodeId + ":" + i];
          var dragging = canSort && dragFrom && dragFrom.stackId === st.nodeId && dragFrom.index === i;
          var dropHere = canSort && dropTo && dropTo.stackId === st.nodeId && dropTo.index === i;
          var taken = isContTaken(st, e);
          var editing = !!(nameEdit && nameEdit.stackId === st.nodeId && nameEdit.index === i);
          var rowProps = {
            key: e.name + ":" + i,
            className: cls(
              "ac-lorarow",
              !canSort && "loose",
              taken && "cont",
              dragging && "dragging",
              dropHere && (dropTo.after ? "drop-after" : "drop-before"),
            ),
            title: taken ? "连续图已接管这条 LoRA：强度按连续图档位，开关 / 强度 / 触发词 / 名字不生效；排序仍可拖动" : undefined,
          };
          if (canSort) {
            rowProps["data-lora-row"] = "1";
            rowProps["data-lora-stack"] = st.nodeId;
            rowProps["data-lora-index"] = i;
          }
          var row = h("div", rowProps,
            h("input", {
              type: "checkbox", checked: e.active, disabled: taken,
              title: taken ? "连续图接管中：开关不生效" : toggleTitleOf(st),
              onChange: function (ev) { updateEntry(st.nodeId, i, { active: ev.target.checked }, true); },
            }),
            editing
              ? h("input", {
                className: "nm ac-loraname",
                value: nameEdit.value,
                autoFocus: true,
                title: "输入显示名；回车保存，Esc 取消",
                onChange: function (ev) { updateNameDraft(ev.target.value); },
                onBlur: commitNameEdit,
                onKeyDown: function (ev) {
                  if (ev.key === "Enter") { ev.preventDefault(); ev.currentTarget.blur(); }
                  else if (ev.key === "Escape") { ev.preventDefault(); cancelNameEdit(); }
                },
              })
              : h("button", {
                type: "button",
                className: "nm ac-loraname" + (taken ? " taken" : ""),
                disabled: taken,
                title: taken ? "连续图已接管，名称暂不可改" : "点击修改显示名（只改插件里看到的名称，不改文件）",
                onClick: function () { if (!taken) beginNameEdit(st.nodeId, i, e.label || e.name); },
              }, e.label || e.name),
            h("input", {
              type: "number", step: "0.05", min: "-5", max: "5",
              value: numText[numKey(st.nodeId, i)] !== undefined ? numText[numKey(st.nodeId, i)] : e.strength,
              disabled: taken,
              title: taken ? "连续图接管中：强度按连续图档位，这里不生效" : "强度，可用负数；范围 -5 ~ 5",
              onChange: function (ev) { editStrength(st.nodeId, i, ev.target.value); },
              onBlur: function (ev) { commitStrength(st.nodeId, i, ev.target.value); },
              onKeyDown: function (ev) { if (ev.key === "Enter") ev.currentTarget.blur(); },
            }),
            canSort ? h("button", {
              className: "ac-btn sm", disabled: taken,
              title: taken ? "连续图接管中：触发词不生效" : "触发词",
              onClick: function () {
                setOpenWords(function (o) {
                  var n = Object.assign({}, o);
                  n[st.nodeId + ":" + i] = !open;
                  return n;
                });
              },
            }, "词 " + (e.words ? e.words.length - (e.wordsOff ? e.wordsOff.length : 0) : 0) + "/" + (e.words ? e.words.length : 0)) : null,
            canSort ? h("div", {
              className: "ac-drag",
              title: taken ? "按住拖动修改顺序（连续图接管仍可排序）" : "按住拖动修改顺序",
              onPointerDown: function (ev) {
                if (ev.button !== undefined && ev.button !== 0) return;
                ev.preventDefault();
                ev.stopPropagation();
                try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (x) { /* ignore */ }
                dropRef.current = null;
                setDropTo(null);
                setDragFrom({ stackId: st.nodeId, index: i });
              },
            }, h(Ico, { name: "list", size: 14 })) : null,
          );
          var extra = [];
          if (canSort && open && taken) {
            extra.push(h("div", { key: "words" + i, className: "ac-words ac-dim" }, "连续图接管中：触发词开关暂不可改"));
          } else if (canSort && open && e.words && e.words.length) {
            extra.push(h("div", { key: "words" + i, className: "ac-words" },
              e.words.map(function (w) {
                var off = (e.wordsOff || []).indexOf(w) >= 0;
                return h("span", {
                  key: w, className: cls("ac-word", off ? "off" : "on"),
                  onClick: function () {
                    var nextOff = (e.wordsOff || []).slice();
                    if (nextOff.indexOf(w) >= 0) nextOff = nextOff.filter(function (x) { return x !== w; });
                    else nextOff.push(w);
                    updateEntry(st.nodeId, i, { wordsOff: nextOff }, true);
                  },
                }, w);
              }),
            ));
          } else if (canSort && open) {
            extra.push(h("div", { key: "words" + i, className: "ac-words ac-dim" }, "这个 LoRA 没有触发词元数据"));
          }
          return extra.length ? h(React.Fragment, { key: "row" + i }, row, extra) : row;
        };
        var renderNodeCard = function (st) {
          var isStack = groupOf(st) === "stack";
          var collapsed = isStack && !!collapsedStacks[st.nodeId];
          var rows = [];
          if (!collapsed) {
            (st.entries || []).forEach(function (e, i) { rows.push(renderEntryRow(st, e, i, isStack)); });
          }
          var actions = [];
          if (isStack) {
            actions.push(st.active ? h(Pill, { tone: "ok" }, "生效堆") : h(Pill, { tone: "warn" }, "不生效"));
            actions.push(h(Btn, {
              small: true, variant: "ghost",
              title: collapsed ? "展开这一堆的 LoRA 条目" : "收起这一堆的 LoRA 条目",
              onClick: function () { toggleStack(st.nodeId); },
            }, collapsed ? "展开" : "收起"));
          } else {
            actions.push(h(Pill, { title: "按工作流顺序列出；不参与拖动排序，只改强度或开关" }, "普通节点"));
          }
          if ((st.entries || []).some(function (e) { return isContTaken(st, e); })) {
            actions.push(h(Pill, {
              tone: "warn",
              title: "连续图设置会接管这条 LoRA 的强度；灰色条目的开关 / 强度 / 触发词 / 名字不生效，排序仍可拖动",
            }, "连续图接管"));
          }
          return h(Card, {
            key: st.nodeId,
            title: "#" + st.nodeId + " " + (st.title || st.classType),
            actions: h("div", { className: "ac-actions" }, actions),
          }, collapsed ? null : rows);
        };
        var body = !data
          ? h(Empty, null, busy ? "正在读取 LoRA…" : "还没有选择工作流。")
          : (!allStacks.length
            ? h(Empty, null, "没有识别到 LoRA 节点（LoraManager 堆 / LoraLoader / Power Lora Loader / Lora Stacker 等）。")
            : h("div", { className: "ac-stack" },
              h("div", { className: "ac-hint" },
                "点击 LoRA 名称可改显示名（只改插件里看到的名称，不改文件）；改完点「保存到工作流」生效，重置会恢复默认名。连续图选中的那条会灰显：强度和开关由连续图接管，但仍可拖动排序。"),
              stackItems.length ? h(React.Fragment, null,
                h("div", { className: "ac-lorahead" },
                  h("b", null, "LoRA 堆"),
                  h("span", { className: "ac-dim" }, "可折叠 · 可拖动排序"),
                ),
                stackItems.map(renderNodeCard),
              ) : null,
              looseItems.length ? h(React.Fragment, null,
                h("div", { className: "ac-lorahead" },
                  h("b", null, "普通 LoRA 节点"),
                  h("span", { className: "ac-dim" }, "按工作流顺序 · 只改强度 / 开关"),
                ),
                looseItems.map(renderNodeCard),
              ) : null,
            ));
        return h("div", { className: "ac-stack" },
          h(Card, {
            title: "LoRA",
            subtitle: data ? loraBadges : null,
            actions: h("div", { className: "ac-actions" },
              h(Btn, { small: true, disabled: busy, onClick: function () { load(true).then(function () { props.toast("已刷新 LoRA", "ok"); }).catch(function () { /* 已提示 */ }); } }, busy ? "读取中…" : "刷新"),
              h(Btn, {
                small: true, disabled: !data, onClick: saveToWorkflow,
                title: "把当前 LoRA 开关 / 强度 / 排序写进工作流记录；保存后即生效，不需要再回工作流页点保存",
              }, "保存到工作流"),
              h(Btn, { small: true, variant: "danger", disabled: !data, onClick: reset }, "重置"),
            ),
          }),
          body,
        );
      }

      /* ===================================================================
       * 连接与设置
       * =================================================================== */
      function ConnectionsPage(props) {
        var state = props.state;
        var cfg = state.config;
        // 设置页用本地草稿渲染：下拉 / 会话选择立即变，不等 PUT 回包，也不会被下一次 render 弹回去。
        var [srcDraft, setSrcDraft] = useState(function () { return Object.assign({}, cfg.source || {}); });
        var [tgtDraft, setTgtDraft] = useState(function () { return Object.assign({}, cfg.target || {}); });
        var latestParties = useRef({ source: srcDraft, target: tgtDraft });
        latestParties.current = { source: srcDraft, target: tgtDraft };
        var partyTimers = useRef({ source: null, target: null });
        var [localSessions, setLocalSessions] = useState([]);
        var [remoteSessions, setRemoteSessions] = useState([]);
        var [busy, setBusy] = useState(false);
        var [formatHelp, setFormatHelp] = useState(false);
        var defaultTags = { title: "</标题>", anchor: "</原文>", size: "</尺寸>", positive: "</正面>", negative: "</负面>" };
        var [tagDraft, setTagDraft] = useState(Object.assign({}, defaultTags, cfg.capture.customTags || {}));
        var tagTimer = useRef(null);
        var tagLatest = useRef(tagDraft);
        tagLatest.current = tagDraft;

        var updateTag = function (key, value) {
          var next = Object.assign({}, tagDraft, { [key]: value });
          setTagDraft(next);
          if (tagTimer.current) clearTimeout(tagTimer.current);
          tagTimer.current = setTimeout(function () {
            tagTimer.current = null;
            props.saveConfig({ capture: { customTags: next } }).catch(function (e) { props.toast(e.message, "err"); });
          }, 300);
        };
        useEffect(function () {
          return function () {
            if (tagTimer.current) {
              clearTimeout(tagTimer.current);
              tagTimer.current = null;
              props.saveConfig({ capture: { customTags: tagLatest.current } }).catch(function () { /* 页面已离开 */ });
            }
          };
        }, []);

        var sendParty = function (which, next, msg) {
          var patch = {};
          patch[which] = next;
          props.saveConfig(patch).then(function () { if (msg) props.toast(msg, "ok"); }).catch(function (e) {
            props.toast(e.message, "err");
            if (props.refresh) props.refresh().catch(function () { /* ignore */ });
          });
        };
        var saveParty = function (which, next, msg, delay) {
          if (partyTimers.current[which]) clearTimeout(partyTimers.current[which]);
          partyTimers.current[which] = null;
          if (delay === 0) {
            sendParty(which, next, msg);
            return;
          }
          partyTimers.current[which] = setTimeout(function () {
            partyTimers.current[which] = null;
            sendParty(which, next, msg);
          }, delay === undefined ? 350 : delay);
        };
        var updateParty = function (which, patch, msg, delay) {
          var current = which === "source" ? srcDraft : tgtDraft;
          var next = Object.assign({}, current, patch);
          if (which === "source") setSrcDraft(next);
          else setTgtDraft(next);
          if (props.previewParty && (patch.mode !== undefined || patch.sessionId !== undefined)) {
            props.previewParty(which, next);
          }
          saveParty(which, next, msg, delay);
          return next;
        };
        useEffect(function () {
          return function () {
            ["source", "target"].forEach(function (which) {
              if (partyTimers.current[which]) {
                clearTimeout(partyTimers.current[which]);
                partyTimers.current[which] = null;
                sendParty(which, latestParties.current[which]);
              }
            });
          };
        }, []);

        var loadLocal = function () {
          return api.sessions("mode=local&limit=100")
            .then(function (r) {
              setLocalSessions((r.sessions || []).filter(function (s) { return s && !s.archived && !s.archivedAt; }));
              return r;
            })
            .catch(function (e) { props.toast(e.message, "err"); throw e; });
        };
        useEffect(function () {
          var alive = true;
          var reload = function (toastErr) {
            return api.sessions("mode=local&limit=100").then(function (r) {
              if (!alive) return r;
              setLocalSessions((r.sessions || []).filter(function (s) { return s && !s.archived && !s.archivedAt; }));
              return r;
            }).catch(function (e) {
              if (toastErr) props.toast(e.message, "err");
              throw e;
            });
          };
          reload(true).catch(function () { /* 已提示 */ });
          // 新开 / 切换对话时自动刷新下拉列表，不用等手动点「刷新」。
          var onSession = function () {
            reload(false).catch(function () { /* 后台刷新失败不打扰 */ });
          };
          try {
            if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
              window.addEventListener(SESSION_EVENT, onSession);
            }
          } catch (e) { /* ignore */ }
          return function () {
            alive = false;
            try {
              if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
                window.removeEventListener(SESSION_EVENT, onSession);
              }
            } catch (e) { /* ignore */ }
          };
        }, []);

        var saveTimer = useRef(null);
        var pendingPatch = useRef({});
        var mergePatch = function (base, patch) {
          var out = Object.assign({}, base || {});
          Object.keys(patch || {}).forEach(function (key) {
            var value = patch[key];
            if (value && typeof value === "object" && !Array.isArray(value)
              && out[key] && typeof out[key] === "object" && !Array.isArray(out[key])) {
              out[key] = mergePatch(out[key], value);
            } else {
              out[key] = value;
            }
          });
          return out;
        };
        var flushSave = function (msg) {
          if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
          var patch = pendingPatch.current;
          pendingPatch.current = {};
          if (!patch || !Object.keys(patch).length) return;
          props.saveConfig(patch).then(function () { if (msg) props.toast(msg, "ok"); }).catch(function (e) { props.toast(e.message, "err"); });
        };
        useEffect(function () {
          return function () {
            if (saveTimer.current) {
              clearTimeout(saveTimer.current);
              saveTimer.current = null;
              if (Object.keys(pendingPatch.current).length) {
                props.saveConfig(pendingPatch.current).catch(function () { /* 页面已离开 */ });
              }
            }
          };
        }, []);
        var save = function (patch, msg, delay) {
          pendingPatch.current = mergePatch(pendingPatch.current, patch);
          if (saveTimer.current) clearTimeout(saveTimer.current);
          if (delay === 0) {
            flushSave(msg);
            return Promise.resolve();
          }
          saveTimer.current = setTimeout(function () { flushSave(msg); }, delay === undefined ? 350 : delay);
          return Promise.resolve();
        };

        var refreshSessions = function (mode, conf) {
          setBusy(true);
          if (mode === "remote") {
            return api.remoteProbe({ baseUrl: conf.baseUrl, routePath: conf.routePath, token: conf.token })
              .then(function (r) {
                var rows = (r.sessions || []).filter(function (s) { return s && !s.archived && !s.archivedAt; });
                setRemoteSessions(rows);
                r.sessions = rows;
                return r;
              })
              .finally(function () { setBusy(false); });
          }
          // 旧 Host 没有 sessions/refresh 时退回普通列表，避免按钮直接报错。
          if (typeof api.refreshSessions !== "function") {
            return loadLocal().finally(function () { setBusy(false); });
          }
          // 真正刷新：Host 逐个会话重新读 projection、排除归档，并回写来源 / 提示词来源名称。
          return api.refreshSessions({}).then(function (r) {
            var rows = (r.sessions || []).filter(function (s) { return s && !s.archived && !s.archivedAt; });
            setLocalSessions(rows);
            var byId = new Map(rows.map(function (s) {
              return [String(s.sessionId), String(s.title || s.displayTitle || "")];
            }));
            var applyDraftTitle = function (old) {
              var t = byId.get(String(old.sessionId || ""));
              return t && t !== old.title ? Object.assign({}, old, { title: t }) : old;
            };
            setSrcDraft(applyDraftTitle);
            setTgtDraft(applyDraftTitle);
            r.sessions = rows;
            return r;
          }).finally(function () { setBusy(false); });
        };
        var testSession = function (which) {
          var conf = which === "source" ? srcDraft : tgtDraft;
          if (!conf.sessionId) return props.toast(which === "source" ? "先选正文来源" : "先选提示词来源", "err");
          if (conf.mode === "remote") {
            setBusy(true);
            return api.remoteProbe({ baseUrl: conf.baseUrl, routePath: conf.routePath, token: conf.token })
              .then(function (r) {
                var hit = (r.sessions || []).some(function (s) { return s.sessionId === conf.sessionId; });
                props.toast(hit ? "远程会话可读：" + (conf.title || conf.sessionId) : "远程连上了，但列表里没有这个会话", hit ? "ok" : "warn");
              })
              .catch(function (e) { props.toast("远程测试失败：" + (e.message || e), "err"); })
              .finally(function () { setBusy(false); });
          }
          setBusy(true);
          return api.capture({ sessionId: conf.sessionId, preview: true }).then(function (r) {
            var text = String(r.text || "").trim();
            if (!text) {
              props.toast("会话能读，但当前没有可用的助手正文", "warn");
              return null;
            }
            return api.rulePreview({ ruleId: cfg.capture.matchRule, text: text, customTags: tagDraft }).then(function (p) {
              var n = (p.sets || []).length;
              var issues = (p.issues || []).length;
              props.toast("测试通过：读到 " + text.length + " 字，按当前匹配方式切出 " + n + " 套" + (issues ? "（" + issues + " 条提醒）" : ""), n ? "ok" : "warn");
            });
          }).catch(function (e) {
            props.toast("测试失败：" + (e.message || e), "err");
          }).finally(function () { setBusy(false); });
        };

        var sessionPicker = function (which, disabled) {
          var conf = which === "source" ? srcDraft : tgtDraft;
          var mode = conf.mode;
          var list = mode === "remote" ? remoteSessions : localSessions;
          // 会话列表是异步加载的，刷新后还可能暂时没有这条会话。
          // 先把已保存的会话补进选项，界面不能一刷新就显示成「未选择」。
          var options = list.slice();
          if (conf.sessionId && !options.some(function (s) { return s.sessionId === conf.sessionId; })) {
            options.unshift({
              sessionId: conf.sessionId,
              title: conf.title || conf.sessionId,
              displayTitle: conf.title || conf.sessionId,
              savedOnly: true,
            });
          }
          // Tavern 这类宿主把人物卡名当目录：同一角色的会话标题完全一样。
          // 同名时补「首条用户消息 + 条数」，下拉里才分得清哪个是正在写的那个。
          var titleCount = {};
          options.forEach(function (s) {
            var t = s.displayTitle || s.title || "";
            if (t) titleCount[t] = (titleCount[t] || 0) + 1;
          });
          var optionTitle = function (s) {
            var bits = [];
            if (s.sessionId) bits.push(String(s.sessionId));
            var first = String(s.firstText || "").replace(/\s+/g, " ").trim();
            if (first) bits.push("首条：" + first);
            if (Number(s.userCount) > 0) bits.push(Number(s.userCount) + " 条用户消息");
            return bits.join("\n");
          };
          return h("div", { className: "ac-form" },
            h("div", { className: "ac-row" },
              h(Field, { label: "会话" }, h(Select, {
                value: conf.sessionId || "",
                disabled: !!disabled,
                onChange: function (e) {
                  var sid = e.target.value;
                  if (!sid || sid === conf.sessionId) return;
                  var hit = list.find(function (s) { return s.sessionId === sid; });
                  updateParty(which, { sessionId: sid, title: hit ? (hit.displayTitle || hit.title || "") : "" }, (which === "source" ? "正文来源" : "提示词来源") + "已保存", 0);
                },
              },
                h("option", { value: "" }, "— 选一个会话 —"),
                options.map(function (s) {
                  return h("option", { key: s.sessionId, value: s.sessionId, title: optionTitle(s) }, sessionOptionLabel(s, titleCount) + (s.savedOnly ? " · 已保存" : "") + (s.running ? " · 运行中" : ""));
                }),
              )),
              h(Btn, {
                small: true, disabled: busy,
                onClick: function () {
                  refreshSessions(mode, conf).then(function (r) {
                    var n = r && Array.isArray(r.sessions) ? r.sessions.length : 0;
                    var cur = r && r.active && r.active.title ? " · 当前：" + r.active.title : "";
                    props.toast("已刷新未归档会话 " + n + " 个" + cur, "ok");
                    if (props.refresh) props.refresh().catch(function () { /* SSE 会继续更新 */ });
                  }).catch(function (e) { props.toast("刷新失败：" + (e.message || e), "err"); });
                },
              }, busy ? "读取中…" : "刷新"),
              h(Btn, { small: true, disabled: busy || !!disabled, onClick: function () { testSession(which); } }, "测试"),
            ),
            which === "source" ? null : h("div", { className: "ac-hint" },
              "暂不提供生图提示词预设，建议选择具有提示词产出能力的会话"),
          );
        };

        var openSavePath = function (scope, label) {
          api.openFolder({ scope: scope }).then(function (r) {
            props.toast("已打开" + label + "：" + (r.path || ""), "ok");
          }).catch(function (e) {
            props.toast("打开" + label + "失败：" + (e.message || e), "err");
          });
        };

        var remoteFields = function (which, disabled) {
          var conf = which === "source" ? srcDraft : tgtDraft;
          if (conf.mode !== "remote") return null;
          return h("div", { className: "ac-form" },
            h(Field, { label: "远程地址" }, h(TextInput, { value: conf.baseUrl, disabled: !!disabled, placeholder: "http://127.0.0.1:43120", onChange: function (e) { updateParty(which, { baseUrl: e.target.value }); } })),
            h(Field, { label: "路由" }, h(TextInput, { value: conf.routePath || ROUTE, disabled: !!disabled, onChange: function (e) { updateParty(which, { routePath: e.target.value }); } })),
            // 远程口令输入暂时隐藏（配置里的 token 与后端校验保留）。
            // 以后恢复时把下面这一行放回来即可：
            // h(Field, { label: "口令" }, h(TextInput, { type: "password", disabled: !!disabled, placeholder: conf.hasToken ? "已有口令；留空 = 不修改" : "可选", onChange: function (e) { updateParty(which, { token: e.target.value, hasToken: true }); } })),
            h("div", { className: "ac-actions" },
              h(Btn, {
                small: true, disabled: busy || !!disabled || !conf.baseUrl, onClick: function () {
                  setBusy(true);
                  api.remoteProbe({ baseUrl: conf.baseUrl, routePath: conf.routePath, token: conf.token })
                    .then(function (r) {
                      var rows = (r.sessions || []).filter(function (s) { return s && !s.archived && !s.archivedAt; });
                      setRemoteSessions(rows);
                      props.toast("远程连通，拿到 " + rows.length + " 个未归档会话", "ok");
                    })
                    .catch(function (e) { props.toast(e.message, "err"); })
                    .finally(function () { setBusy(false); });
                },
              }, "测试远程"),
            ),
          );
        };

        var srcFollow = srcDraft.followActive !== false;
        return h("div", { className: "ac-stack" },
          h(Card, { title: "正文来源" },
            h("div", { className: "ac-form" },
              h("div", { className: "ac-row" },
                h(Switch, {
                  checked: srcFollow,
                  onChange: function (e) { updateParty("source", { followActive: e.target.checked }, "正文来源已保存", 0); },
                }, "本会话"),
              ),
              h(Field, { label: "模式" }, h(Select, {
                value: srcDraft.mode || "local",
                disabled: srcFollow,
                onChange: function (e) { updateParty("source", { mode: e.target.value }, "正文来源已保存", 0); },
              },
                h("option", { value: "local" }, "本进程"),
                h("option", { value: "remote" }, "远程 DSH（指定端口）"),
              )),
              remoteFields("source", srcFollow),
              sessionPicker("source", srcFollow),
            ),
          ),

          h(Card, { title: "提示词来源" },
            h("div", { className: "ac-form" },
              h(Field, { label: "模式" }, h(Select, {
                value: tgtDraft.mode || "local",
                onChange: function (e) { updateParty("target", { mode: e.target.value }, "提示词来源已保存", 0); },
              },
                h("option", { value: "local" }, "本进程"),
                h("option", { value: "remote" }, "远程 DSH（指定端口）"),
              )),
              remoteFields("target"),
              sessionPicker("target"),
            ),
          ),

          h(Card, { title: "捕获与投递" },
            h("div", { className: "ac-row" },
              h(Switch, { checked: cfg.capture.autoForward, onChange: function (e) { save({ capture: { autoForward: e.target.checked } }); } }, "自动投递正文"),
              h(Switch, { checked: cfg.capture.autoGenerate, onChange: function (e) { save({ capture: { autoGenerate: e.target.checked } }); } }, "自动出图"),
            ),
            h("div", { className: "ac-sizerow", style: { marginTop: 7 } },
              h(Field, { label: "等待上限(秒)" }, h(NumInput, { value: Math.round(cfg.capture.timeoutMs / 1000), onChange: function (e) { save({ capture: { timeoutMs: clamp(e.target.value, 5, 1800) * 1000 } }); } })),
              h(Field, { label: "最多匹配几套提示词" }, h(NumInput, { value: cfg.capture.maxSets, onChange: function (e) { save({ capture: { maxSets: clamp(e.target.value, 1, 3) } }); } })),
            ),
            h("div", { className: "ac-hint", style: { marginTop: 5 } },
              "最多匹配几套提示词 = 只取前几套；连续图只把第 N 套（最后一套）替换成多张，前面的套数照常出图。",
            ),
          ),

          h(Card, { title: "提示词格式" },
            h(Field, { label: "匹配方式" }, h(Select, {
              value: cfg.capture.matchRule,
              onChange: function (e) {
                var value = e.target.value;
                save({ capture: { matchRule: value } }, "匹配方式已保存", 0);
              },
            },
              h("option", { value: "contract_v2" }, "内置"),
              h("option", { value: "all_text" }, "全部匹配"),
              h("option", { value: "custom_tags" }, "自定义"),
            )),
            cfg.capture.matchRule === "contract_v2"
              ? h("div", { className: "ac-help" },
                h("span", null, "支持自动识别标题、size和正面提示词。"),
              )
              : cfg.capture.matchRule === "all_text"
                ? h("div", { className: "ac-help" },
                  h("span", null, "不解析标题、尺寸或代码块。抓到的整条助手回复会原样作为正面提示词，负面留空，只出 1 套。适合你想自己控制提示词内容的时候。"),
                )
                : h("div", { className: "ac-option" },
                  h("div", { className: "ac-help" },
                    h("span", null, "主字段按「标题 → 尺寸 → 正面 → 负面」顺序读取，最多 3 套；原文锚点单独扫描，写在尺寸前或后都能认。闭合标签写成 </标题> / [/title] / 【/尺寸】 这类成对形式时，开标签会自动按同名推出；只写 `---`、`标题结束` 等字面标记时，字段开头仍认「标题：/原文：/尺寸：/正面：/负面：」。"),
                  ),
                  h("div", { className: "ac-tagrid" },
                    h(Field, { label: "标题闭合标签" }, h(TextInput, { value: tagDraft.title, placeholder: "</标题>", onChange: function (e) { updateTag("title", e.target.value); } })),
                    h(Field, { label: "原文闭合标签" }, h(TextInput, { value: tagDraft.anchor || "", placeholder: "</原文>", onChange: function (e) { updateTag("anchor", e.target.value); } })),
                    h(Field, { label: "尺寸闭合标签" }, h(TextInput, { value: tagDraft.size, placeholder: "</尺寸>", onChange: function (e) { updateTag("size", e.target.value); } })),
                    h(Field, { label: "正面闭合标签" }, h(TextInput, { value: tagDraft.positive, placeholder: "</正面>", onChange: function (e) { updateTag("positive", e.target.value); } })),
                    h(Field, { label: "负面闭合标签" }, h(TextInput, { value: tagDraft.negative, placeholder: "</负面>", onChange: function (e) { updateTag("negative", e.target.value); } })),
                  ),
                ),
            h("div", { className: "ac-actions", style: { marginTop: 8 } },
              h(Btn, {
                small: true, variant: "ghost", title: "内置匹配方式说明",
                onClick: function () { setFormatHelp(true); },
              }, "？"),
            ),
            h("div", { className: "ac-hint", style: { marginTop: 6 } },
              "仅格式要求，建议放到目标会话所在工作区让agent遵守。",
            ),
          ),

          h(Card, { title: "ComfyUI" },
            h("div", { className: "ac-form" },
              h(Field, { label: "地址" }, h(TextInput, { value: cfg.comfy.baseUrl, onChange: function (e) { save({ comfy: { baseUrl: e.target.value } }); } })),
              h("div", { className: "ac-sizerow" },
                h(Field, { label: "出图上限(秒)" }, h(NumInput, { value: Math.round(cfg.comfy.timeoutMs / 1000), onChange: function (e) { save({ comfy: { timeoutMs: clamp(e.target.value, 30, 1800) * 1000 } }); } })),
                h(Field, { label: "轮询(毫秒)" }, h(NumInput, { value: cfg.comfy.pollIntervalMs, onChange: function (e) { save({ comfy: { pollIntervalMs: clamp(e.target.value, 300, 10000) } }); } })),
              ),
              h("div", { className: "ac-actions" },
                h(Btn, {
                  small: true, onClick: function () {
                    api.comfyStatus().then(function (r) { props.toast(r.status && r.status.system ? "ComfyUI 连通" : "连不上 ComfyUI", r.status && r.status.system ? "ok" : "err"); }).catch(function (e) { props.toast(e.message, "err"); });
                  },
                }, "测试连接"),
              ),
            ),
          ),

          h(Card, { title: "图片保存" },
            h("div", { className: "ac-hint" },
              "新出的图片按「出图时所在的当前聊天」归档到该会话自己的目录，和设置里的正文来源没有关系；切换正文来源不会改变图片所属的聊天。",
            ),
            h("div", { className: "ac-savepaths" },
              h("div", { className: "ac-savepath" },
                h("b", null, "归档规则"),
                h("span", null, "会话名 / 图片文件（不再按日期分目录）"),
              ),
              h("div", { className: "ac-savepath" },
                h("b", null, "输出目录"),
                h("button", {
                  type: "button", className: "ac-pathlink",
                  title: "点击用文件资源管理器打开输出目录",
                  onClick: function () { openSavePath("all", "输出目录"); },
                }, state.runtime.outputDir || "（未提供）"),
              ),
              h("div", { className: "ac-savepath" },
                h("b", null, "回收站"),
                h("button", {
                  type: "button", className: "ac-pathlink",
                  title: "点击用文件资源管理器打开回收站",
                  onClick: function () { openSavePath("recycle", "回收站"); },
                }, state.runtime.recycleDir || "（未提供）"),
              ),
            ),
          ),

          h(Card, { title: "关于" },
            h(KV, { rows: [
              ["插件", "ComfyRP Bridge v" + state.version],
              ["包名", "dsh-comfyui-rp（兼容旧安装）"],
              ["路由", state.routePath],
              ["标签", TAB_KIND],
            ] }),
            h("div", { className: "ac-hint", style: { marginTop: 6 } },
              "悬浮球在窗口内任意拖动；「置顶」只保证盖在 DSH 界面之上，不是系统级窗口。",
            ),
          ),

          formatHelp ? withPortal(h("div", {
            className: "ac-overlay",
            onClick: function (e) { if (e.target === e.currentTarget) setFormatHelp(false); },
          },
            h("div", { className: "ac-modal", onClick: function (e) { e.stopPropagation(); } },
              h("div", { className: "ac-row" },
                h("h3", null, "内置匹配方式（contract_v2）"),
                h("span", { style: { flex: 1 } }),
                h(Btn, { small: true, variant: "ghost", onClick: function () { setFormatHelp(false); } }, "关闭"),
              ),
              h("p", null, "按「标题 → 可选尺寸 / 原文锚点 → 正面 → 负面」顺序读取。每一套以圈码标题行开始，例如 ①；标题下面可以写 size 和 anchor，然后跟一个 ```text 代码块写正面提示词。"),
              h("pre", { className: "ac-helpcode" }, "① 窗边的少女\nsize: 832x1216\nanchor: 她站在窗边，回头看了一眼。\n```text\n1girl, solo, white dress, standing, window\n\nA girl stands by the window. Soft light falls on her face.\n```"),
              h("p", null, "识别规则：① 标题行去掉圈码后作为标题；② size 写成 宽x高；③ ```text 围栏里第一段是 Danbooru 标签，空行后是英文自然语言；④ 负面不写就留空，保留工作流自己的负面。"),
              h("p", null, "一套回复最多切 3 套；没有标题或没有围栏的闲聊不会出图。anchor 可选，用来让图片跟着这段原文滚动；也兼容中文 `原文：` / `原文:`（全角冒号不报警）。"),
              h("div", { className: "ac-actions", style: { marginTop: 10 } },
                h(Btn, {
                  small: true, variant: "ghost", title: "打开格式要求文件所在的文件夹",
                  onClick: function () {
                    api.formatReference().then(function () {
                      props.toast("已打开格式参考所在文件夹", "ok");
                    }).catch(function (e) {
                      props.toast("打开失败：" + (e.message || e), "err");
                    });
                  },
                }, h(Ico, { name: "folder", size: 13 }), "格式要求文件参考"),
              ),
              h("div", { className: "ac-hint", style: { marginTop: 6 } },
                "`PROMPT_FORMAT_REFERENCE.md` 只是随插件附带，插件不会读取、也不会用它解析；点按钮只打开它所在的文件夹。",
              ),
              h("div", { className: "ac-actions" },
                h(Btn, { small: true, variant: "primary", onClick: function () { setFormatHelp(false); } }, "知道了"),
              ),
            ),
          )) : null,
        );
      }

      /* ===================================================================
       * 日志
       * =================================================================== */
      function LogsPage(props) {
        var [filter, setFilter] = useState("all");
        var logs = (props.logs || []).filter(function (l) { return filter === "all" || l.level === filter; });
        return h("div", { className: "ac-stack" },
          h("div", { className: "ac-row" },
            h("div", { className: "ac-tabs" },
              [["all", "全部"], ["info", "信息"], ["warn", "警告"], ["error", "错误"]].map(function (k) {
                return h("button", { key: k[0], className: cls("ac-tab", filter === k[0] && "on"), onClick: function () { setFilter(k[0]); } }, k[1]);
              }),
            ),
            h("span", { style: { flex: 1 } }),
            h(Btn, { small: true, variant: "ghost", onClick: function () { props.refresh().then(function () { props.toast("已刷新日志", "ok"); }).catch(function (e) { props.toast("刷新失败：" + (e.message || e), "err"); }); } }, "刷新"),
          ),
          h(Card, { title: "运行日志" },
            !logs.length ? h(Empty) : h("div", { className: "ac-log" }, logs.map(function (l, i) {
              return h("div", { key: i, className: "l" },
                h("span", { className: "t" }, fmtTime(l.at).slice(-8)),
                h("span", { className: "lv-" + (l.level || "info") + " m" }, l.message),
              );
            })),
          ),
        );
      }

      /* ===================================================================
       * 右侧栏标签 / 开始菜单
       * =================================================================== */
      function PaletteGlyph(props) {
        var s = (props && props.size) || 20;
        return h("svg", {
          width: s, height: s, viewBox: "0 0 24 24", fill: "none",
          stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round",
          "aria-hidden": "true",
        },
          h("path", { d: "M12 3a9 9 0 1 0 0 18h1.1a1.8 1.8 0 0 0 1.2-3.15 1.8 1.8 0 0 1 1.2-3.15H18a3 3 0 0 0 3-3A9 9 0 0 0 12 3z" }),
          h("circle", { cx: "7.6", cy: "10.4", r: "1.05", fill: "currentColor", stroke: "none" }),
          h("circle", { cx: "10.2", cy: "6.8", r: "1.05", fill: "currentColor", stroke: "none" }),
          h("circle", { cx: "14.6", cy: "6.6", r: "1.05", fill: "currentColor", stroke: "none" }),
          h("circle", { cx: "7.9", cy: "14.6", r: "1.05", fill: "currentColor", stroke: "none" }),
        );
      }

      function TabTitle() {
        return h("span", { className: "ac-tabtitle" },
          h("span", { className: "ac-dot ok" }),
          h("span", null, TAB_LABEL),
        );
      }

      function apply(ctx) {
        var disposers = [];
        clientCtx = ctx;
        try { injectStyle(); } catch (e) { /* ignore */ }

        var slots = null;
        try { slots = ctx && ctx.slots ? ctx.slots : ctx && ctx.get ? ctx.get("slots") : null; } catch (e) { slots = null; }
        if (!slots || typeof slots.register !== "function") {
          try { console.error("[airp-comfy] 找不到 slots 服务，右侧栏不会挂载"); } catch (e2) { /* ignore */ }
          return function () {};
        }

        var pushDispose = function (d) {
          if (typeof d === "function") disposers.push(d);
          else if (d && typeof d.dispose === "function") disposers.push(function () { d.dispose(); });
        };
        var effect = function (fn, label) {
          try {
            if (ctx && typeof ctx.effect === "function") {
              pushDispose(ctx.effect(fn, label));
              return;
            }
          } catch (e) {
            try { console.error("[airp-comfy] effect " + label + " 失败：", e); } catch (e2) { /* ignore */ }
          }
          try { pushDispose(fn()); } catch (e2) {
            try { console.error("[airp-comfy] " + label + " 失败：", e2); } catch (e3) { /* ignore */ }
          }
        };
        var register = function (name, options, component) {
          try {
            var doRegister = function () { return slots.register(Object.assign({ name: name }, options), component); };
            if (typeof slots.inject === "function") {
              pushDispose(slots.inject(name, doRegister));
            } else {
              pushDispose(doRegister());
            }
          } catch (e) {
            try { console.error("[airp-comfy] 注册 " + name + " 失败：", e); } catch (e2) { /* ignore */ }
          }
        };

        // 右侧栏类型 + 开始菜单卡片：点卡片会把 ComfyRP 作为 tab 打开
        var tabs = null;
        var tabRegistered = false;
        var registerTabType = function (service) {
          if (tabRegistered || !service || typeof service.register !== "function") return;
          tabRegistered = true;
          effect(function () {
            return service.register({
              id: TAB_ID,
              kind: TAB_KIND,
              priority: "extension",
              title: function () { return TAB_LABEL; },
              guide: [{
                id: "airp",
                order: 30,
                title: function () { return TAB_LABEL; },
                description: function () { return "为本会话抓正文、出图、看图"; },
                icon: PaletteGlyph,
              }],
            });
          }, "airp:right-tab-type");
        };
        try { tabs = ctx && (ctx.sidebarRightTabs || (ctx.get && ctx.get("sidebarRightTabs"))); } catch (e) { tabs = null; }
        registerTabType(tabs);
        if (!tabRegistered) {
          // 兼容旧启动图 / 服务晚挂：先等 ctx.inject，再短轮询兜底（只在前 10 秒跑）。
          try {
            if (ctx && typeof ctx.inject === "function") {
              pushDispose(ctx.inject(["sidebarRightTabs"], function (child) {
                var svc = child && (child.sidebarRightTabs || (child.get && child.get("sidebarRightTabs")));
                registerTabType(svc);
              }));
            }
          } catch (e) { /* 下面轮询兜底 */ }
          var tries = 0;
          var wait = setInterval(function () {
            tries += 1;
            var svc = null;
            try { svc = clientCtx && (clientCtx.sidebarRightTabs || (clientCtx.get && clientCtx.get("sidebarRightTabs"))); } catch (e) { svc = null; }
            if (svc) {
              clearInterval(wait);
              registerTabType(svc);
            } else if (tries >= 40) {
              clearInterval(wait);
              try { console.error("[airp-comfy] 等不到 sidebarRightTabs，右侧栏标签未注册"); } catch (e) { /* ignore */ }
            }
          }, 250);
          disposers.push(function () { clearInterval(wait); });
        }

        // 右侧栏正文 / 标签标题
        register("sidebar.right.pane.tab", {
          key: TAB_ID,
          inject: function (sessionId) { return { sessionId: typeof sessionId === "string" ? sessionId : "" }; },
        }, BridgePanel);
        register("sidebar.right.pane.tab.title", { key: TAB_ID }, TabTitle);

        // 悬浮球
        register("shell.overlay", { id: TAB_ID + "-ball" }, FloatBall);
        // 当前会话上报（隐形）
        register("conversation.input.dock", { id: TAB_ID + "-active", order: 60 }, SessionReporter);

        try {
          var logger = ctx && ctx.get ? ctx.get("logger") : null;
          if (logger && logger.info) logger.info("[airp-comfy] client applied: tab=" + TAB_KIND);
          else console.log("[airp-comfy] client applied: tab=" + TAB_KIND);
        } catch (e) { /* ignore */ }

        return function () {
          for (var i = 0; i < disposers.length; i += 1) {
            try { disposers[i](); } catch (e) { /* ignore */ }
          }
          var st = document.getElementById("airp-comfy-style");
          if (st && st.parentNode && typeof st.parentNode.removeChild === "function") st.parentNode.removeChild(st);
          styleInjected = false;
        };
      }

      exports.name = "dsh-comfyui-rp-client";
      // 右侧栏类型 / 正文 / 开始菜单；悬浮球仍只依赖 slots。
      exports.inject = ["slots", "sidebarRightTabs", "sidebarRight", "layout"];
      exports.apply = apply;
      // 离线冒烟用（不可枚举，不影响正常加载）
      try {
        Object.defineProperty(exports, "__test", {
          enumerable: false,
          value: {
            BridgePanel: BridgePanel,
            FloatBall: FloatBall,
            FrameTools: FrameTools,
            DashboardPage: DashboardPage,
            WorkbenchPage: WorkbenchPage,
            WorkflowsPage: WorkflowsPage,
            ConnectionsPage: ConnectionsPage,
            LogsPage: LogsPage,
            ImagesPage: ImagesPage,
            Lightbox: Lightbox,
            LoraPage: LoraPage,
            SessionReporter: SessionReporter,
            PaletteGlyph: PaletteGlyph,
            TabTitle: TabTitle,
            readWorkbenchDraft: readWorkbenchDraft,
            writeWorkbenchDraft: writeWorkbenchDraft,
            loadTheme: loadTheme,
            saveTheme: saveTheme,
            readFloatHidden: readFloatHidden,
            writeFloatHidden: writeFloatHidden,
            loadFloatPrefs: loadFloatPrefs,
          },
        });
      } catch (e) { /* ignore */ }
    } catch (e) {
      try { console.error("[airp-comfy] client 加载失败，本插件本次禁用：", (e && e.message) || e); } catch (e2) { /* ignore */ }
      exports.name = "dsh-comfyui-rp-client";
      exports.inject = [];
      exports.apply = function () {};
    }
    return module.exports;
  },
});
