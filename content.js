(function uxlyAnalyze() {
  "use strict";

  // Remove previous overlay highlights
  document.querySelectorAll("[data-uxly-highlight]").forEach((el) => el.remove());

  const IGNORED_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "META", "LINK", "HEAD", "HTML", "BR", "HR",
    "SVG", "PATH", "CIRCLE", "RECT", "LINE", "POLYGON", "POLYLINE", "ELLIPSE",
    "G", "DEFS", "CLIPPATH", "USE", "SYMBOL", "TEXT", "TSPAN",
  ]);

  const EDGE_TOLERANCE = 2;
  const INTERACTIVE_TAGS = new Set(["button", "a", "input", "select", "textarea"]);
  const INTERACTIVE_ROLES = new Set(["button", "link", "tab", "menuitem", "checkbox", "radio", "switch"]);

  // ─── Utility ──────────────────────────────────────────────

  function isVisible(el) {
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
    return true;
  }

  function getSelector(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    let path = el.tagName.toLowerCase();
    if (el.className && typeof el.className === "string") {
      const cls = el.className.trim().split(/\s+/).slice(0, 2).map(c => "." + CSS.escape(c)).join("");
      path += cls;
    }
    return path;
  }

  function roundRect(r) {
    return {
      top: Math.round(r.top), left: Math.round(r.left),
      bottom: Math.round(r.bottom), right: Math.round(r.right),
      width: Math.round(r.width), height: Math.round(r.height),
    };
  }

  function rectsOverlapOrAdjacent(a, b, tol) {
    return !(a.right + tol < b.left || b.right + tol < a.left ||
             a.bottom + tol < b.top || b.bottom + tol < a.top);
  }

  function mergeRects(a, b) {
    return {
      top: Math.min(a.top, b.top), left: Math.min(a.left, b.left),
      bottom: Math.max(a.bottom, b.bottom), right: Math.max(a.right, b.right),
      width: Math.max(a.right, b.right) - Math.min(a.left, b.left),
      height: Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top),
    };
  }

  function median(arr) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function hasDirectText(el) {
    for (const node of el.childNodes) {
      if (node.nodeType === 3 && node.textContent.trim().length > 0) return true;
    }
    return false;
  }

  // ─── Color Parsing & WCAG ─────────────────────────────────

  function parseColor(str) {
    if (!str) return null;
    let m = str.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
    if (m) return { r: parseFloat(m[1]), g: parseFloat(m[2]), b: parseFloat(m[3]) };
    m = str.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
    if (m) return { r: parseFloat(m[1]) * 255, g: parseFloat(m[2]) * 255, b: parseFloat(m[3]) * 255 };
    return null;
  }

  function colorDistance(c1, c2) {
    const dr = c1.r - c2.r, dg = c1.g - c2.g, db = c1.b - c2.b;
    return Math.sqrt(dr * dr * 2 + dg * dg * 4 + db * db * 3);
  }

  function isTransparent(str) {
    if (!str) return true;
    if (str === "transparent" || str === "rgba(0, 0, 0, 0)") return true;
    const m = str.match(/rgba\([^)]*,\s*([\d.]+)\s*\)/);
    if (m && parseFloat(m[1]) === 0) return true;
    const m2 = str.match(/\/\s*([\d.]+)\s*\)/);
    if (m2 && parseFloat(m2[1]) === 0) return true;
    return false;
  }

  function sRGBtoLinear(c) {
    c = c / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function relativeLuminance(rgb) {
    return 0.2126 * sRGBtoLinear(rgb.r) + 0.7152 * sRGBtoLinear(rgb.g) + 0.0722 * sRGBtoLinear(rgb.b);
  }

  function contrastRatio(l1, l2) {
    const lighter = Math.max(l1, l2), darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function parseAlpha(str) {
    if (!str) return 1;
    let m = str.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)/);
    if (m) return parseFloat(m[1]);
    m = str.match(/\/\s*([\d.]+)\s*\)/);
    if (m) return parseFloat(m[1]);
    return 1;
  }

  function compositeOver(fg, fgAlpha, bg) {
    const a = fgAlpha;
    return {
      r: fg.r * a + bg.r * (1 - a),
      g: fg.g * a + bg.g * (1 - a),
      b: fg.b * a + bg.b * (1 - a),
    };
  }

  function getEffectiveBackgroundColor(el) {
    // Walk up the tree collecting backgrounds, then composite from bottom up
    const layers = [];
    let current = el;
    while (current && current !== document.documentElement) {
      const bg = getComputedStyle(current).backgroundColor;
      if (bg && !isTransparent(bg)) {
        const parsed = parseColor(bg);
        if (parsed) {
          const alpha = parseAlpha(bg);
          if (alpha >= 0.99) {
            // Fully opaque — no need to go further
            layers.push({ color: parsed, alpha: 1 });
            break;
          }
          layers.push({ color: parsed, alpha });
        }
      }
      current = current.parentElement;
    }

    // Start from white (page default) and composite each layer on top
    let result = { r: 255, g: 255, b: 255 };
    for (let i = layers.length - 1; i >= 0; i--) {
      result = compositeOver(layers[i].color, layers[i].alpha, result);
    }
    return result;
  }

  // ─── Collect Elements ─────────────────────────────────────

  function collectElements() {
    const all = document.body.querySelectorAll("*");
    const elements = [];

    for (const el of all) {
      if (IGNORED_TAGS.has(el.tagName)) continue;
      if (!isVisible(el)) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;

      const cs = getComputedStyle(el);
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role");

      elements.push({
        el, tag,
        rect: roundRect(rect),
        styles: {
          color: cs.color,
          backgroundColor: cs.backgroundColor,
          fontFamily: cs.fontFamily,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          lineHeight: cs.lineHeight,
          paddingTop: cs.paddingTop,
          paddingRight: cs.paddingRight,
          paddingBottom: cs.paddingBottom,
          paddingLeft: cs.paddingLeft,
          marginTop: cs.marginTop,
          marginRight: cs.marginRight,
          marginBottom: cs.marginBottom,
          marginLeft: cs.marginLeft,
          borderTopWidth: cs.borderTopWidth,
          borderTopColor: cs.borderTopColor,
          borderTopStyle: cs.borderTopStyle,
          borderRadius: cs.borderRadius,
          boxShadow: cs.boxShadow,
          overflow: cs.overflow,
          overflowX: cs.overflowX,
          overflowY: cs.overflowY,
          textOverflow: cs.textOverflow,
          zIndex: cs.zIndex,
          position: cs.position,
          display: cs.display,
        },
        selector: getSelector(el),
        scrollWidth: el.scrollWidth,
        scrollHeight: el.scrollHeight,
        clientWidth: el.clientWidth,
        clientHeight: el.clientHeight,
        isInteractive: INTERACTIVE_TAGS.has(tag) ||
          INTERACTIVE_ROLES.has(role) ||
          el.hasAttribute("tabindex"),
      });
    }
    return elements;
  }

  // ─── Consistency Analysis ─────────────────────────────────

  function classifyRole(item) {
    const t = item.tag;
    const el = item.el;
    const role = el.getAttribute("role");
    if (t === "button" || role === "button" || el.type === "button" || el.type === "submit") return "button";
    if (t === "a") return "link";
    if (t === "input" || t === "textarea" || role === "textbox") return "input";
    if (t === "select" || role === "listbox" || role === "combobox") return "select";
    if (/^h[1-6]$/.test(t)) return t;
    if (t === "p" || t === "span" || t === "li" || t === "td" || t === "label") return "text";
    if (t === "img" || t === "picture" || t === "video") return "media";
    if (t === "table") return "table";
    return null;
  }

  // Normalize CSS values before comparison to reduce false positives
  function normalizeValue(prop, value, item) {
    if (!value) return value;

    // Normalize font-family: case-insensitive, trim quotes
    if (prop === "fontFamily") {
      return value.toLowerCase().replace(/['"]/g, "");
    }

    // Normalize border-radius: treat percentage circles and large px as "pill/circle" category
    if (prop === "borderRadius") {
      if (value === "50%") return "50%"; // circle
      const px = parseFloat(value);
      if (px >= 999) return "pill"; // 9999px, 100px for pill shapes → same bucket
      return value;
    }

    // Skip border color/width when border-style is none — invisible borders aren't inconsistent
    if ((prop === "borderTopColor" || prop === "borderTopWidth") &&
        item && item.styles.borderTopStyle === "none") {
      return "__no-border__";
    }

    return value;
  }

  // Classify button sub-type to allow intentional variants
  function classifyButtonVariant(item) {
    const bg = item.styles.backgroundColor;
    const hasText = hasDirectText(item.el);
    const isSmall = item.rect.width < 44 && item.rect.height < 44;

    if (isTransparent(bg) && !hasText) return "icon-button";
    if (isTransparent(bg)) return "ghost-button";
    return "filled-button";
  }

  // Classify link sub-type by context
  function classifyLinkContext(item) {
    const ancestor = item.el.closest("nav, header, footer, [role=navigation], [role=banner], [role=contentinfo]");
    if (ancestor) {
      const tag = ancestor.tagName.toLowerCase();
      const role = ancestor.getAttribute("role");
      if (tag === "nav" || role === "navigation") return "nav-link";
      if (tag === "footer" || role === "contentinfo") return "footer-link";
      if (tag === "header" || role === "banner") return "header-link";
    }
    return "body-link";
  }

  // Classify heading sub-type by landmark context
  function classifyHeadingContext(item) {
    const tag = item.tag; // h1, h2, etc.
    const landmark = item.el.closest("nav, aside, header, footer, [role=navigation], [role=complementary], [role=banner], [role=contentinfo]");
    if (landmark) {
      const lt = landmark.tagName.toLowerCase();
      const lr = landmark.getAttribute("role");
      if (lt === "nav" || lr === "navigation") return `nav-${tag}`;
      if (lt === "aside" || lr === "complementary") return `sidebar-${tag}`;
      if (lt === "header" || lr === "banner") return `header-${tag}`;
      if (lt === "footer" || lr === "contentinfo") return `footer-${tag}`;
    }
    return tag;
  }

  function analyzeConsistency(elements) {
    const groups = {};
    for (const item of elements) {
      const role = classifyRole(item);
      if (!role) continue;

      // Sub-group buttons, links, and headings by variant/context
      let key = role;
      if (role === "button") key = classifyButtonVariant(item);
      else if (role === "link") key = classifyLinkContext(item);
      else if (/^h[1-6]$/.test(role)) key = classifyHeadingContext(item);

      if (!groups[key]) groups[key] = [];
      groups[key].push(item);
    }

    const report = {};
    const propsToCheck = [
      "color", "backgroundColor", "fontFamily", "fontSize", "fontWeight",
      "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
      "borderRadius", "borderTopWidth", "borderTopColor", "borderTopStyle", "boxShadow",
    ];

    for (const [role, items] of Object.entries(groups)) {
      if (items.length < 2) continue;
      const properties = {};

      for (const prop of propsToCheck) {
        const counts = {};
        for (const item of items) {
          const val = normalizeValue(prop, item.styles[prop], item);
          counts[val] = (counts[val] || 0) + 1;
        }

        // Remove the synthetic no-border bucket from display
        delete counts["__no-border__"];

        const variants = Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .map(([value, count]) => ({ value, count }));

        if (variants.length === 0) {
          properties[prop] = { variants: [], dominant: "", totalElements: items.length, isConsistent: true };
        } else {
          properties[prop] = {
            variants,
            dominant: variants[0].value,
            totalElements: items.length,
            isConsistent: variants.length <= 1,
          };
        }
      }

      const inconsistentCount = Object.values(properties).filter((p) => !p.isConsistent).length;
      report[role] = {
        elementCount: items.length,
        properties,
        inconsistentCount,
        severity: inconsistentCount === 0 ? "ok" : inconsistentCount <= 3 ? "warn" : "error",
      };
    }
    return report;
  }

  // ─── Visual Unit Detection (Union-Find) ───────────────────

  class UnionFind {
    constructor(n) {
      this.parent = Array.from({ length: n }, (_, i) => i);
      this.rank = new Array(n).fill(0);
    }
    find(x) {
      if (this.parent[x] !== x) this.parent[x] = this.find(this.parent[x]);
      return this.parent[x];
    }
    union(a, b) {
      const ra = this.find(a), rb = this.find(b);
      if (ra === rb) return;
      if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb;
      else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra;
      else { this.parent[rb] = ra; this.rank[ra]++; }
    }
  }

  function hasContinuousBorder(el) {
    const cs = getComputedStyle(el);
    const bw = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderRightWidth) +
               parseFloat(cs.borderBottomWidth) + parseFloat(cs.borderLeftWidth);
    if (bw > 0 && cs.borderTopStyle !== "none") return true;
    const bg = cs.backgroundColor;
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return true;
    if (cs.boxShadow && cs.boxShadow !== "none") return true;
    if (parseFloat(cs.outlineWidth) > 0 && cs.outlineStyle !== "none") return true;
    return false;
  }

  function isAncestor(a, b) {
    let node = b.parentElement;
    while (node) {
      if (node === a) return true;
      node = node.parentElement;
    }
    return false;
  }

  function detectVisualUnits(elements) {
    const candidates = elements.filter((item) => {
      return hasContinuousBorder(item.el) ||
             INTERACTIVE_TAGS.has(item.tag) ||
             item.el.getAttribute("role");
    });
    if (candidates.length === 0) return [];

    const uf = new UnionFind(candidates.length);

    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i], b = candidates[j];
        if (!rectsOverlapOrAdjacent(a.rect, b.rect, EDGE_TOLERANCE)) continue;
        if (isAncestor(a.el, b.el) || isAncestor(b.el, a.el)) {
          uf.union(i, j);
        } else if (a.el.parentElement === b.el.parentElement && hasContinuousBorder(a.el.parentElement)) {
          uf.union(i, j);
        }
      }
    }

    const groupMap = {};
    for (let i = 0; i < candidates.length; i++) {
      const root = uf.find(i);
      if (!groupMap[root]) groupMap[root] = [];
      groupMap[root].push(candidates[i]);
    }

    const units = [];
    for (const members of Object.values(groupMap)) {
      let groupRect = { ...members[0].rect };
      for (let i = 1; i < members.length; i++) groupRect = mergeRects(groupRect, members[i].rect);

      let outermost = members[0];
      for (const m of members) {
        if (m.rect.width * m.rect.height >= outermost.rect.width * outermost.rect.height) outermost = m;
      }

      units.push({
        type: classifyComponent(members, groupRect),
        rect: groupRect,
        memberCount: members.length,
        selector: outermost.selector,
        members: members.map((m) => ({ tag: m.tag, selector: m.selector, rect: m.rect })),
        outerElement: outermost.el,
      });
    }

    const filtered = units
      .filter((u) => u.rect.width > 5 && u.rect.height > 5)
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);

    // Decompose large units into children
    for (const unit of filtered) {
      unit.children = decomposeUnit(unit, elements);
    }

    return filtered;
  }

  function decomposeUnit(unit, allElements) {
    // Only decompose units with enough members to have meaningful sub-structure
    if (unit.memberCount < 6) return [];
    if (!unit.outerElement) return [];

    // Find direct child containers of the outermost element
    const outerEl = unit.outerElement;
    const directChildren = Array.from(outerEl.children).filter((child) => {
      if (IGNORED_TAGS.has(child.tagName)) return false;
      if (!isVisible(child)) return false;
      const r = child.getBoundingClientRect();
      if (r.width < 20 || r.height < 20) return false;
      return true;
    });

    if (directChildren.length < 2) return [];

    const subUnits = [];

    for (const child of directChildren) {
      // Collect all analysis elements that are inside this child
      const childMembers = allElements.filter((item) =>
        child === item.el || child.contains(item.el)
      );
      if (childMembers.length === 0) continue;

      const childRect = roundRect(child.getBoundingClientRect());
      const type = classifyComponent(childMembers, childRect);

      // Skip trivially small children
      if (childRect.width < 30 || childRect.height < 20) continue;

      subUnits.push({
        type,
        rect: childRect,
        memberCount: childMembers.length,
        selector: getSelector(child),
        members: childMembers.slice(0, 20).map((m) => ({ tag: m.tag, selector: m.selector, rect: m.rect })),
      });
    }

    return subUnits;
  }

  // ─── Component Classification ─────────────────────────────

  function classifyComponent(members, groupRect) {
    const tags = new Set(members.map((m) => m.tag));
    const roles = new Set(members.map((m) => m.el.getAttribute("role")).filter(Boolean));
    const types = new Set(members.filter((m) => m.el.type).map((m) => m.el.type));

    const isLargeGroup = groupRect && (groupRect.width > 500 || groupRect.height > 500 || members.length > 10);

    // Landmark/container types take priority when the group is large
    if (roles.has("navigation") || tags.has("nav")) return "navigation";
    if (roles.has("dialog") || roles.has("alertdialog")) return "dialog";
    if (roles.has("toolbar")) return "toolbar";
    if (roles.has("menu") || roles.has("menubar")) return "menu";
    if (roles.has("tablist")) return "tab-bar";
    if (tags.has("table") || roles.has("grid") || roles.has("table")) return "table";

    // For large groups, use spatial/semantic heuristics instead of generic "container"
    if (isLargeGroup) {
      if (tags.has("ul") || tags.has("ol")) return "list";

      // Check semantic tags — but only if the semantic element is the dominant member
      // (covers >60% of the group's area), not just a small child
      const groupArea = groupRect.width * groupRect.height;
      const semanticChecks = [
        [["header"], ["banner"], "header"],
        [["footer"], ["contentinfo"], "footer"],
        [["aside"], ["complementary"], "sidebar"],
        [["main"], ["main"], "main-content"],
        [["form"], [], "form"],
        [["article"], [], "article"],
        [["section"], ["region"], "section"],
      ];
      for (const [semTags, semRoles, label] of semanticChecks) {
        const match = members.find((m) =>
          semTags.includes(m.tag) || (semRoles.length && semRoles.includes(m.el.getAttribute("role")))
        );
        if (match) {
          const memberArea = match.rect.width * match.rect.height;
          if (memberArea > groupArea * 0.6) return label;
        }
      }

      // Spatial heuristics based on position and aspect ratio
      return classifyByLayout(groupRect, members);
    }

    // Small/focused groups — classify by content
    if (tags.has("input") || tags.has("textarea") || roles.has("textbox")) {
      if (members.some((m) => m.tag === "button" || m.el.getAttribute("role") === "button")) return "input-group";
      if (types.has("checkbox")) return "checkbox";
      if (types.has("radio")) return "radio";
      if (types.has("range")) return "slider";
      if (types.has("search")) return "search-input";
      return "text-input";
    }
    if (tags.has("select") || roles.has("listbox") || roles.has("combobox")) return "dropdown";
    if (roles.has("progressbar")) return "progress-bar";
    if (roles.has("switch") || roles.has("toggle")) return "toggle";
    if (tags.has("button") || roles.has("button")) return members.length > 2 ? "button-group" : "button";
    if (tags.has("a")) return members.length >= 3 ? "link-list" : "link";
    if (tags.has("img") || tags.has("picture") || tags.has("video")) {
      if (members.some((m) => ["p", "span", "h1", "h2", "h3"].includes(m.tag))) return "card";
      return "media";
    }
    if (tags.has("ul") || tags.has("ol")) return "list";
    if (members.length >= 3) return classifyByLayout(groupRect, members);
    if (members.length === 1 && hasContinuousBorder(members[0].el)) return "panel";
    return classifyByLayout(groupRect, members);
  }

  function classifyByLayout(rect, members) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const widthRatio = rect.width / vw;
    const heightRatio = rect.height / vh;
    const aspectRatio = rect.width / Math.max(rect.height, 1);
    const atTop = rect.top < 10;
    const atBottom = rect.bottom > vh - 10;
    const atLeft = rect.left < 10;
    const atRight = rect.right > vw - 10;
    const spansFullWidth = widthRatio > 0.85;
    const spansFullHeight = heightRatio > 0.7;

    // Top navbar / header bar: wide, short, pinned to top
    if (atTop && spansFullWidth && rect.height < 80) return "top-bar";
    if (atTop && spansFullWidth && rect.height < 200) return "header";

    // Footer: wide, short, pinned to bottom
    if (atBottom && spansFullWidth && rect.height < 200) return "footer";

    // Sidebar: tall, narrow, anchored to left or right edge
    if (spansFullHeight && rect.width < 350 && (atLeft || atRight)) return "sidebar";

    // Main content area: large, not at edges, or the dominant center area
    if (widthRatio > 0.5 && heightRatio > 0.5) {
      // If it doesn't touch left edge, it's probably the main area next to a sidebar
      if (!atLeft && rect.left > 100) return "main-content";
      if (spansFullWidth) return "main-content";
    }

    // Toolbar: wide, short, but not at very top (below header)
    if (spansFullWidth && rect.height < 60 && rect.top > 40) return "toolbar";

    // Card: medium-sized bordered element, clearly contained
    if (widthRatio < 0.6 && heightRatio < 0.5 && members.length <= 15) {
      const hasVisualBoundary = members.some((m) => {
        const s = m.styles;
        const hasBorder = s.borderTopWidth && parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== "none";
        const hasBg = !isTransparent(s.backgroundColor);
        const hasShadow = s.boxShadow && s.boxShadow !== "none";
        return hasBorder || hasBg || hasShadow;
      });
      if (hasVisualBoundary) return "card";
    }

    // Panel: single-column vertical layout, reasonably tall
    if (aspectRatio < 0.8 && rect.height > 200) return "panel";

    return "container";
  }

  // ─── Chart Detection ─────────────────────────────────────

  function detectCharts() {
    const CHART_KEYWORDS = /chart|graph|plot|series|axis|legend|tick|grid|recharts|apexcharts|highcharts|d3|vizualization|sparkline/i;
    const svgs = document.querySelectorAll("svg");
    const charts = [];

    for (const svg of svgs) {
      if (!isVisible(svg)) continue;
      const rect = svg.getBoundingClientRect();
      // Charts are large — skip icon-sized SVGs
      if (rect.width < 100 || rect.height < 60) continue;

      let score = 0;

      // Check class/id on SVG or ancestors (up to 3 levels)
      let el = svg;
      for (let i = 0; i < 4 && el; i++) {
        const cls = (el.className && typeof el.className === "string") ? el.className : "";
        const id = el.id || "";
        if (CHART_KEYWORDS.test(cls) || CHART_KEYWORDS.test(id)) { score += 3; break; }
        el = el.parentElement;
      }

      // Check for data attributes with chart keywords
      for (const attr of svg.attributes) {
        if (CHART_KEYWORDS.test(attr.name) || CHART_KEYWORDS.test(attr.value)) { score += 2; break; }
      }

      // Has <text> elements (axis labels, tick marks)
      const textEls = svg.querySelectorAll("text");
      if (textEls.length >= 2) score += 2;
      if (textEls.length >= 6) score += 1; // many labels = likely axis ticks

      // Has many paths/rects/lines (data visualization)
      const shapes = svg.querySelectorAll("path, rect, line, circle, polyline");
      if (shapes.length >= 5) score += 1;
      if (shapes.length >= 15) score += 1;

      // Has <g> groups (chart layers)
      const groups = svg.querySelectorAll("g");
      if (groups.length >= 3) score += 1;

      // Size heuristic: larger SVGs more likely charts
      if (rect.width > 200 && rect.height > 150) score += 1;

      if (score >= 3) {
        charts.push({
          el: svg,
          selector: getSelector(svg),
          rect: roundRect(rect),
          textCount: textEls.length,
          shapeCount: shapes.length,
          confidence: Math.min(score, 10),
        });
      }
    }
    return charts;
  }

  // ─── Analysis: Spacing ────────────────────────────────────

  function analyzeSpacing(elements) {
    const textEls = elements.filter((item) => {
      return ["p", "li", "td", "label", "h1", "h2", "h3", "h4", "h5", "h6", "div"].includes(item.tag) &&
        item.el.childNodes.length > 0 && item.el.textContent.trim().length > 0;
    });
    textEls.sort((a, b) => a.rect.top - b.rect.top);

    const issues = [];
    for (let i = 0; i < textEls.length - 1; i++) {
      const a = textEls[i], b = textEls[i + 1];
      const xOverlap = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
      if (xOverlap < Math.min(a.rect.width, b.rect.width) * 0.5) continue;
      if (isAncestor(a.el, b.el) || isAncestor(b.el, a.el)) continue;
      const gap = b.rect.top - a.rect.bottom;
      const avgFontSize = (parseFloat(a.styles.fontSize) + parseFloat(b.styles.fontSize)) / 2;
      if (gap >= 0 && gap < avgFontSize * 0.25 && gap < 4) {
        if (a.tag === "span" || b.tag === "span") continue;
        issues.push({
          elementA: { selector: a.selector, tag: a.tag, fontSize: a.styles.fontSize },
          elementB: { selector: b.selector, tag: b.tag, fontSize: b.styles.fontSize },
          gap: Math.round(gap), avgFontSize: Math.round(avgFontSize),
        });
      }
    }
    return issues;
  }

  // ─── Analysis: WCAG Contrast ──────────────────────────────

  function analyzeContrast(elements) {
    const issues = [];
    for (const item of elements) {
      if (!hasDirectText(item.el)) continue;
      const fg = parseColor(item.styles.color);
      if (!fg) continue;
      const bg = getEffectiveBackgroundColor(item.el);
      const ratio = contrastRatio(relativeLuminance(fg), relativeLuminance(bg));
      const fontSize = parseFloat(item.styles.fontSize);
      const fontWeight = parseInt(item.styles.fontWeight) || 400;
      const isLarge = fontSize >= 18 || (fontSize >= 14 && fontWeight >= 700);
      const required = isLarge ? 3 : 4.5;
      if (ratio < required) {
        issues.push({
          selector: item.selector, tag: item.tag,
          fontSize: item.styles.fontSize, fontWeight: item.styles.fontWeight,
          fgColor: item.styles.color, bgColor: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
          ratio: Math.round(ratio * 100) / 100, required, isLarge,
        });
      }
    }
    return issues;
  }

  // ─── Analysis: Tap Targets ────────────────────────────────

  function analyzeTapTargets(elements) {
    const interactive = elements.filter((item) => item.isInteractive);

    // Only flag truly tiny targets (< 24px) — 44px is a mobile guideline, not a desktop rule.
    // 24-44px is noted as info only if there are many.
    const tooSmall = [];
    let smallCount = 0; // 24-44px range
    for (const item of interactive) {
      if (item.rect.width <= 0 || item.rect.height <= 0) continue;
      const minDim = Math.min(item.rect.width, item.rect.height);
      if (minDim < 24) {
        tooSmall.push({
          selector: item.selector, tag: item.tag,
          width: item.rect.width, height: item.rect.height,
        });
      } else if (minDim < 44) {
        smallCount++;
      }
    }

    const tooCrowded = [];
    interactive.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    for (let i = 0; i < interactive.length; i++) {
      for (let j = i + 1; j < interactive.length; j++) {
        const a = interactive[i], b = interactive[j];
        if (b.rect.top - a.rect.bottom > 60) break;
        const hGap = Math.max(0, Math.max(a.rect.left - b.rect.right, b.rect.left - a.rect.right));
        const vGap = Math.max(0, Math.max(a.rect.top - b.rect.bottom, b.rect.top - a.rect.bottom));
        const gap = Math.max(hGap, vGap);
        if (gap > 0 && gap < 8) {
          tooCrowded.push({
            selectorA: a.selector, selectorB: b.selector, gap: Math.round(gap),
          });
        }
      }
    }
    return { tooSmall, tooCrowded, smallCount };
  }

  // ─── Analysis: Sibling Alignment ──────────────────────────

  function analyzeSiblingAlignment(elements) {
    const byParent = new Map();
    for (const item of elements) {
      const parent = item.el.parentElement;
      if (!parent) continue;
      // Skip SVG internals — parent or child inside an SVG context
      if (parent.closest("svg")) continue;
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(item);
    }

    const issues = [];
    for (const [parent, children] of byParent) {
      if (children.length < 2) continue;

      // Check row peers (overlapping Y ranges)
      for (let i = 0; i < children.length; i++) {
        for (let j = i + 1; j < children.length; j++) {
          const a = children[i], b = children[j];
          const minH = Math.min(a.rect.height, b.rect.height);
          const yOverlap = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);

          if (yOverlap >= minH * 0.5) {
            const topDiff = Math.abs(a.rect.top - b.rect.top);
            const bottomDiff = Math.abs(a.rect.bottom - b.rect.bottom);
            // If top and bottom are off by similar amounts, element is vertically centered — not misaligned
            const isCentered = topDiff > 0 && bottomDiff > 0 && Math.abs(topDiff - bottomDiff) <= 1;
            if (topDiff >= 1 && topDiff <= 3 && !isCentered) {
              issues.push({
                parentSelector: getSelector(parent),
                childA: a.selector, childB: b.selector,
                axis: "top", offset: topDiff,
              });
            }
          }

          const minW = Math.min(a.rect.width, b.rect.width);
          const xOverlap = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
          if (xOverlap >= minW * 0.5) {
            const leftDiff = Math.abs(a.rect.left - b.rect.left);
            const rightDiff = Math.abs(a.rect.right - b.rect.right);
            // If left and right are off by similar amounts, element is horizontally centered
            const isCentered = leftDiff > 0 && rightDiff > 0 && Math.abs(leftDiff - rightDiff) <= 1;
            if (leftDiff >= 1 && leftDiff <= 3 && !isCentered) {
              issues.push({
                parentSelector: getSelector(parent),
                childA: a.selector, childB: b.selector,
                axis: "left", offset: leftDiff,
              });
            }
          }
        }
      }
    }
    return issues;
  }

  // ─── Analysis: Repeated Item Gaps ─────────────────────────

  function analyzeRepeatedItemGaps(elements) {
    const byParent = new Map();
    for (const item of elements) {
      const parent = item.el.parentElement;
      if (!parent) continue;
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(item);
    }

    const issues = [];
    for (const [parent, children] of byParent) {
      if (children.length < 3) continue;

      // Group by tag
      const byTag = {};
      for (const c of children) {
        if (!byTag[c.tag]) byTag[c.tag] = [];
        byTag[c.tag].push(c);
      }

      for (const [tag, group] of Object.entries(byTag)) {
        if (group.length < 3) continue;

        // Check size similarity (within 20%)
        const avgW = group.reduce((s, c) => s + c.rect.width, 0) / group.length;
        const avgH = group.reduce((s, c) => s + c.rect.height, 0) / group.length;
        const similar = group.filter((c) =>
          Math.abs(c.rect.width - avgW) < avgW * 0.2 &&
          Math.abs(c.rect.height - avgH) < avgH * 0.2
        );
        if (similar.length < 3) continue;

        // Determine layout direction
        const sortedY = [...similar].sort((a, b) => a.rect.top - b.rect.top);
        const sortedX = [...similar].sort((a, b) => a.rect.left - b.rect.left);
        const ySpread = sortedY[sortedY.length - 1].rect.top - sortedY[0].rect.top;
        const xSpread = sortedX[sortedX.length - 1].rect.left - sortedX[0].rect.left;

        const sorted = ySpread >= xSpread ? sortedY : sortedX;
        const isVertical = ySpread >= xSpread;

        const gaps = [];
        for (let i = 0; i < sorted.length - 1; i++) {
          const gap = isVertical
            ? sorted[i + 1].rect.top - sorted[i].rect.bottom
            : sorted[i + 1].rect.left - sorted[i].rect.right;
          gaps.push(gap);
        }

        if (gaps.length < 2) continue;
        const med = median(gaps);
        const maxDev = Math.max(...gaps.map((g) => Math.abs(g - med)));

        // Skip if gaps are huge — these aren't a real list, just same-tag siblings in a layout container
        if (med > 100) continue;
        // Skip if any gap is negative (overlapping items)
        if (gaps.some((g) => g < -5)) continue;
        // Only flag if items are actually adjacent siblings (no other elements between them)
        const allSiblings = Array.from(parent.children);
        const indices = similar.map((s) => allSiblings.indexOf(s.el)).filter((i) => i >= 0).sort((a, b) => a - b);
        const areConsecutive = indices.length >= 3 && indices.every((idx, i) => i === 0 || idx - indices[i - 1] <= 2);
        if (!areConsecutive) continue;

        if (maxDev > 2 && med > 0) {
          issues.push({
            parentSelector: getSelector(parent),
            gaps: gaps.map(Math.round),
            meanGap: Math.round(med),
            maxDeviation: Math.round(maxDev),
            childCount: similar.length,
            direction: isVertical ? "vertical" : "horizontal",
          });
        }
      }
    }
    return issues;
  }

  // ─── Analysis: Text Truncation ────────────────────────────

  function analyzeTextTruncation(elements) {
    const issues = [];
    for (const item of elements) {
      if (!hasDirectText(item.el)) continue;
      const s = item.styles;
      const hasHiddenOverflow = s.overflow.includes("hidden") ||
        s.overflowX === "hidden" || s.overflowY === "hidden";
      if (!hasHiddenOverflow) continue;

      const hClipped = item.scrollWidth > item.clientWidth + 1;
      const vClipped = item.scrollHeight > item.clientHeight + 1;
      if (!hClipped && !vClipped) continue;

      issues.push({
        selector: item.selector, tag: item.tag,
        type: s.textOverflow === "ellipsis" ? "ellipsis" : "clipped",
        scrollWidth: item.scrollWidth, clientWidth: item.clientWidth,
        scrollHeight: item.scrollHeight, clientHeight: item.clientHeight,
      });
    }
    return issues;
  }

  // ─── Analysis: Z-Index Issues ─────────────────────────────

  function analyzeZIndex(elements) {
    const excessiveZIndex = [];
    const positioned = [];

    for (const item of elements) {
      const z = parseInt(item.styles.zIndex);
      if (isNaN(z)) continue;
      if (item.styles.position === "static") continue;

      if (z > 100 && !item.isInteractive) {
        excessiveZIndex.push({ selector: item.selector, zIndex: z });
      }
      positioned.push({ ...item, z });
    }

    const blockedInteractive = [];
    const interactiveEls = positioned.filter((p) => p.isInteractive);
    const nonInteractiveEls = positioned.filter((p) => !p.isInteractive && p.z > 0);

    for (const interactive of interactiveEls) {
      for (const blocker of nonInteractiveEls) {
        if (blocker.z <= interactive.z) continue;
        // Check if blocker fully covers the interactive element
        if (blocker.rect.left <= interactive.rect.left &&
            blocker.rect.top <= interactive.rect.top &&
            blocker.rect.right >= interactive.rect.right &&
            blocker.rect.bottom >= interactive.rect.bottom) {
          blockedInteractive.push({
            blockedSelector: interactive.selector,
            blockerSelector: blocker.selector,
            blockerZ: blocker.z, interactiveZ: interactive.z,
          });
          break;
        }
      }
    }

    return { excessiveZIndex, blockedInteractive };
  }

  // ─── Analysis: Section Spacing ────────────────────────────

  function analyzeSectionSpacing(elements) {
    const landmarkTags = new Set(["header", "main", "footer", "nav", "aside", "section"]);
    const landmarkRoles = new Set(["region", "banner", "main", "contentinfo", "navigation", "complementary"]);

    const landmarks = elements.filter((item) =>
      landmarkTags.has(item.tag) || landmarkRoles.has(item.el.getAttribute("role"))
    );

    if (landmarks.length < 3) return [];

    landmarks.sort((a, b) => a.rect.top - b.rect.top);

    const gaps = [];
    for (let i = 0; i < landmarks.length - 1; i++) {
      const a = landmarks[i], b = landmarks[i + 1];
      const gap = b.rect.top - a.rect.bottom;
      // Skip side-by-side landmarks (horizontally arranged, not stacked)
      // If they overlap vertically significantly, they're side-by-side
      const yOverlap = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
      const minH = Math.min(a.rect.height, b.rect.height);
      if (minH > 0 && yOverlap > minH * 0.3) continue;
      // Skip negative gaps (overlapping) and absurdly large gaps (> 200px likely different layout zones)
      if (gap < 0 || gap > 200) continue;

      gaps.push({
        sectionA: a.selector,
        sectionB: b.selector,
        gap,
      });
    }

    const gapValues = gaps.map((g) => g.gap);
    if (gapValues.length < 2) return [];
    const med = median(gapValues);
    if (med === 0) return [];

    return gaps.filter((g) => Math.abs(g.gap - med) > med * 0.5)
      .map((g) => ({ ...g, gap: Math.round(g.gap), medianGap: Math.round(med) }));
  }

  // ─── Analysis: Icon Consistency ───────────────────────────

  function analyzeIconConsistency() {
    const selectorStr = [
      "button svg", "a svg", "[role=button] svg",
      "button img", "a img", "[role=button] img",
    ].join(", ");
    const iconEls = document.querySelectorAll(selectorStr);
    const icons = [];

    for (const el of iconEls) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1 || rect.width > 48 || rect.height > 48) continue;

      // Determine context region for grouping
      const landmark = el.closest("nav, header, footer, main, aside, section, [role=navigation], [role=banner], [role=contentinfo], table, [role=grid]");
      const context = landmark ? (landmark.tagName.toLowerCase() + ":" + getSelector(landmark)) : "page";

      icons.push({
        el, selector: getSelector(el),
        width: Math.round(rect.width), height: Math.round(rect.height),
        centerY: rect.top + rect.height / 2,
        context,
      });
    }

    if (icons.length < 2) return { inconsistentWithinContext: [], misaligned: [] };

    // Group by context, check consistency within each group
    const byContext = {};
    for (const icon of icons) {
      if (!byContext[icon.context]) byContext[icon.context] = [];
      byContext[icon.context].push(icon);
    }

    const inconsistentWithinContext = [];
    for (const [context, group] of Object.entries(byContext)) {
      if (group.length < 2) continue;

      const sizeCounts = {};
      for (const icon of group) {
        const key = `${icon.width}x${icon.height}`;
        sizeCounts[key] = (sizeCounts[key] || 0) + 1;
      }
      const sorted = Object.entries(sizeCounts).sort((a, b) => b[1] - a[1]);
      if (sorted.length <= 1) continue;

      const dominant = sorted[0][0];
      const [domW, domH] = dominant.split("x").map(Number);

      for (const icon of group) {
        if (Math.abs(icon.width - domW) > 2 || Math.abs(icon.height - domH) > 2) {
          inconsistentWithinContext.push({
            selector: icon.selector, width: icon.width, height: icon.height,
            dominantSize: dominant, context,
          });
        }
      }
    }

    // Check icon-text vertical alignment
    const misaligned = [];
    for (const icon of icons) {
      const parent = icon.el.closest("button, a, [role=button]");
      if (!parent) continue;
      for (const child of parent.querySelectorAll("span, p, label")) {
        if (child.textContent.trim() && !child.contains(icon.el)) {
          const tRect = child.getBoundingClientRect();
          const textCenterY = tRect.top + tRect.height / 2;
          const offset = Math.abs(icon.centerY - textCenterY);
          if (offset > 2) {
            misaligned.push({
              iconSelector: icon.selector,
              textSelector: getSelector(child),
              offset: Math.round(offset),
            });
          }
          break;
        }
      }
    }

    return { inconsistentWithinContext, misaligned };
  }

  // ─── Analysis: Nested Scrolling ───────────────────────────

  function analyzeNestedScrolling(elements) {
    const scrollable = elements.filter((item) => {
      const s = item.styles;
      return (s.overflow === "auto" || s.overflow === "scroll" ||
              s.overflowX === "auto" || s.overflowX === "scroll" ||
              s.overflowY === "auto" || s.overflowY === "scroll");
    });

    const issues = [];
    for (const item of scrollable) {
      let ancestor = item.el.parentElement;
      while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
        const cs = getComputedStyle(ancestor);
        if (cs.overflow === "auto" || cs.overflow === "scroll" ||
            cs.overflowX === "auto" || cs.overflowX === "scroll" ||
            cs.overflowY === "auto" || cs.overflowY === "scroll") {
          issues.push({
            innerSelector: item.selector,
            outerSelector: getSelector(ancestor),
          });
          break;
        }
        ancestor = ancestor.parentElement;
      }
    }
    return issues;
  }

  // ─── Analysis: Cramped Padding ──────────────────────────

  function analyzeCrampedPadding(elements) {
    const issues = [];
    for (const item of elements) {
      // Only check elements with visible boundaries (border or non-transparent bg)
      const s = item.styles;
      const hasBorder = s.borderTopWidth && parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== "none";
      const hasBg = !isTransparent(s.backgroundColor);
      if (!hasBorder && !hasBg) continue;

      // Must contain text
      if (!item.el.textContent.trim()) continue;
      // Skip tiny elements, inline tags, and form controls
      if (item.rect.width < 60 || item.rect.height < 20) continue;
      if (["span", "a", "button", "input", "select", "textarea", "label", "th", "td", "li"].includes(item.tag)) continue;

      const pt = parseFloat(s.paddingTop) || 0;
      const pr = parseFloat(s.paddingRight) || 0;
      const pb = parseFloat(s.paddingBottom) || 0;
      const pl = parseFloat(s.paddingLeft) || 0;
      const fontSize = parseFloat(s.fontSize) || 14;

      // Padding should be at least ~50% of font size on all sides for comfortable reading
      const minPadding = Math.max(6, fontSize * 0.5);
      const cramped = [];
      if (pt < minPadding) cramped.push(`top:${Math.round(pt)}px`);
      if (pr < minPadding) cramped.push(`right:${Math.round(pr)}px`);
      if (pb < minPadding) cramped.push(`bottom:${Math.round(pb)}px`);
      if (pl < minPadding) cramped.push(`left:${Math.round(pl)}px`);

      if (cramped.length >= 2) {
        issues.push({
          selector: item.selector,
          padding: `${Math.round(pt)} ${Math.round(pr)} ${Math.round(pb)} ${Math.round(pl)}`,
          fontSize: Math.round(fontSize),
          crampedSides: cramped,
          minRecommended: Math.round(minPadding),
        });
      }
    }
    return issues;
  }

  // ─── Analysis: Form Labels ────────────────────────────────

  function analyzeFormLabels(elements) {
    const inputs = elements.filter((item) => {
      if (!["input", "select", "textarea"].includes(item.tag)) return false;
      const type = item.el.type;
      if (type === "hidden" || type === "submit" || type === "button") return false;
      return true;
    });

    const issues = [];
    for (const item of inputs) {
      const el = item.el;
      // Check label[for]
      if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) continue;
      // Check wrapping label
      if (el.closest("label")) continue;
      // Check aria attributes
      if (el.getAttribute("aria-label")) continue;
      if (el.getAttribute("aria-labelledby")) continue;
      if (el.getAttribute("title")) continue;

      issues.push({
        selector: item.selector, tag: item.tag,
        type: el.type || item.tag,
      });
    }
    return issues;
  }

  // ─── Analysis: Nested Panels ─────────────────────────────

  function analyzeNestedPanels(elements) {
    const LAYOUT_TAGS = new Set(["header", "footer", "nav", "aside", "main", "section", "article"]);
    const LAYOUT_ROLES = new Set(["banner", "main", "contentinfo", "navigation", "complementary", "region"]);

    // Find elements that look like panels/cards: have visible background or border,
    // reasonable size, and are containers (not inline text)
    function isPanel(item) {
      const s = item.styles;
      const hasBg = !isTransparent(s.backgroundColor);
      const hasBorder = s.borderTopWidth && parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== "none";
      const hasShadow = s.boxShadow && s.boxShadow !== "none";
      if (!hasBg && !hasBorder && !hasShadow) return false;
      // Must be at least 50x50 to be a "panel"
      if (item.rect.width < 50 || item.rect.height < 50) return false;
      // Skip inline text elements
      if (["span", "a", "button", "input", "select", "textarea", "label"].includes(item.tag)) return false;
      return true;
    }

    function isLayoutElement(item) {
      if (LAYOUT_TAGS.has(item.tag)) return true;
      const role = item.el.getAttribute("role");
      if (role && LAYOUT_ROLES.has(role)) return true;
      return false;
    }

    function isAppShellWrapper(item) {
      // Full-width or near-full-viewport containers are layout wrappers, not visual panels
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      return item.rect.width > vw * 0.9 && item.rect.height > vh * 0.8;
    }

    const panels = elements.filter(isPanel);
    const issues = [];

    for (const inner of panels) {
      // Skip layout elements (header, nav, aside, main inside a layout div is normal)
      if (isLayoutElement(inner)) continue;

      let ancestor = inner.el.parentElement;
      let depth = 0;
      while (ancestor && ancestor !== document.body && ancestor !== document.documentElement && depth < 10) {
        depth++;
        const ancestorPanel = panels.find((p) => p.el === ancestor);
        if (ancestorPanel) {
          // Skip if outer is an app shell wrapper (near-full viewport)
          if (isAppShellWrapper(ancestorPanel)) break;
          // Skip if outer is a layout element (standard app structure)
          if (isLayoutElement(ancestorPanel)) break;
          // Skip if inner is nearly the same size (just a wrapper)
          const areaRatio = (inner.rect.width * inner.rect.height) /
            (ancestorPanel.rect.width * ancestorPanel.rect.height);
          if (areaRatio < 0.85) {
            issues.push({
              innerSelector: inner.selector,
              outerSelector: ancestorPanel.selector,
              innerSize: `${inner.rect.width}x${inner.rect.height}`,
              outerSize: `${ancestorPanel.rect.width}x${ancestorPanel.rect.height}`,
            });
          }
          break;
        }
        ancestor = ancestor.parentElement;
      }
    }
    return issues;
  }

  // ─── Analysis: Rounded Border Sprawl ───────────────────────

  function analyzeRoundedBorderSprawl(elements) {
    // Collect distinct border-radius values on "panel-like" elements (>= 80px on any side)
    const panelRadii = {}; // radius value → count
    const MIN_PANEL_SIZE = 80;

    for (const item of elements) {
      const br = item.styles.borderRadius;
      if (!br || br === "0px") continue;
      // Only care about sizable containers
      if (item.rect.width < MIN_PANEL_SIZE || item.rect.height < MIN_PANEL_SIZE) continue;
      if (["span", "a", "button", "input", "select", "textarea", "label", "img"].includes(item.tag)) continue;

      // Parse the radius — normalize pill values
      let normalized = br;
      const parsed = parseFloat(br);
      if (parsed >= 100) normalized = "pill";

      if (!panelRadii[normalized]) panelRadii[normalized] = 0;
      panelRadii[normalized]++;
    }

    const distinctValues = Object.keys(panelRadii);
    const totalRounded = Object.values(panelRadii).reduce((a, b) => a + b, 0);

    return {
      distinctRadii: distinctValues,
      radiusCounts: panelRadii,
      totalRoundedPanels: totalRounded,
      tooManyVariants: distinctValues.length > 4,
      overuse: totalRounded > 20,
    };
  }

  // ─── Findings Engine ──────────────────────────────────────

  function generateFindings(consistency, elements, analyses) {
    const findings = [];

    const EXPECTED_VARIANTS = {
      "filled-button": { fontSize: 3, fontWeight: 2, borderRadius: 2, backgroundColor: 3, color: 3, paddingTop: 3, paddingBottom: 3, paddingLeft: 3, paddingRight: 3 },
      "ghost-button": { fontSize: 3, fontWeight: 2, borderRadius: 2, color: 3, paddingTop: 3, paddingBottom: 3, paddingLeft: 3, paddingRight: 3 },
      "icon-button": { fontSize: 3, fontWeight: 2, borderRadius: 2, paddingTop: 2, paddingBottom: 2, paddingLeft: 2, paddingRight: 2 },
      input: { fontSize: 2, fontWeight: 1, borderRadius: 1, backgroundColor: 2, paddingTop: 2, paddingBottom: 2, paddingLeft: 2, paddingRight: 2 },
      "nav-link": { fontSize: 2, fontWeight: 2, color: 2, paddingTop: 2, paddingBottom: 2, paddingLeft: 2, paddingRight: 2 },
      "footer-link": { fontSize: 2, fontWeight: 2, color: 2, paddingTop: 2, paddingBottom: 2, paddingLeft: 2, paddingRight: 2 },
      "header-link": { fontSize: 2, fontWeight: 2, color: 2, paddingTop: 2, paddingBottom: 2, paddingLeft: 2, paddingRight: 2 },
      "body-link": { fontSize: 2, fontWeight: 2, color: 3, paddingTop: 2, paddingBottom: 2, paddingLeft: 2, paddingRight: 2 },
      text: { fontFamily: 2, fontSize: 6, fontWeight: 4 },
    };

    const ROLE_LABELS = {
      "filled-button": "Filled buttons", "ghost-button": "Ghost buttons", "icon-button": "Icon buttons",
      "nav-link": "Nav links", "footer-link": "Footer links", "header-link": "Header links", "body-link": "Links",
      input: "Inputs", select: "Dropdowns",
      text: "Text elements", h1: "H1 headings", h2: "H2 headings", h3: "H3 headings",
      h4: "H4 headings", h5: "H5 headings", h6: "H6 headings", table: "Tables",
    };

    function getRoleLabel(role) {
      if (ROLE_LABELS[role]) return ROLE_LABELS[role];
      // Handle context-prefixed headings like "sidebar-h3", "nav-h2"
      const m = role.match(/^(\w+)-(h[1-6])$/);
      if (m) return `${m[1].charAt(0).toUpperCase() + m[1].slice(1)} ${m[2].toUpperCase()} headings`;
      return role;
    }

    // ── Existing consistency findings ──
    for (const [role, group] of Object.entries(consistency)) {
      const label = getRoleLabel(role);
      const expected = EXPECTED_VARIANTS[role] || {};

      for (const [prop, data] of Object.entries(group.properties)) {
        if (data.isConsistent) continue;

        const variants = data.variants;
        const nonTransparent = variants.filter((v) => !isTransparent(v.value));
        const isColorProp = prop.toLowerCase().includes("color") || prop === "backgroundColor";

        if (isColorProp && nonTransparent.length >= 2) {
          const parsed = nonTransparent.map((v) => ({ ...v, rgb: parseColor(v.value) })).filter((v) => v.rgb);
          for (let i = 0; i < parsed.length; i++) {
            for (let j = i + 1; j < parsed.length; j++) {
              const dist = colorDistance(parsed[i].rgb, parsed[j].rgb);
              if (dist > 0 && dist < 15) {
                findings.push({ severity: "error", category: "near-miss-color",
                  message: `${label}: Near-identical ${prop} values that should be the same design token. "${parsed[i].value}" (${parsed[i].count}x) and "${parsed[j].value}" (${parsed[j].count}x) differ by only ~${Math.round(dist)} units. Unify them.` });
              } else if (dist >= 15 && dist < 35) {
                findings.push({ severity: "warn", category: "similar-color",
                  message: `${label}: Suspiciously similar ${prop} values. "${parsed[i].value}" (${parsed[i].count}x) and "${parsed[j].value}" (${parsed[j].count}x) are close (delta ~${Math.round(dist)}). Verify these are intentionally different tokens.` });
              }
            }
          }
          if (nonTransparent.length > 4 && (role.includes("button") || role === "input")) {
            findings.push({ severity: "warn", category: "too-many-colors",
              message: `${label}: ${nonTransparent.length} distinct ${prop} values across ${group.elementCount} elements. A design system typically uses 2-3 variants. Consider consolidating.` });
          }
        }

        if (prop === "fontSize") {
          const maxExpected = expected.fontSize || 3;
          if (variants.length > maxExpected) {
            findings.push({ severity: variants.length > maxExpected + 2 ? "error" : "warn", category: "too-many-sizes",
              message: `${label}: ${variants.length} different font sizes (${variants.map((v) => v.value).join(", ")}). Expected at most ${maxExpected}. Reduce to a consistent scale.` });
          }
        }

        if (prop === "fontWeight") {
          const maxExpected = expected.fontWeight || 2;
          if (variants.length > maxExpected) {
            findings.push({ severity: "warn", category: "too-many-weights",
              message: `${label}: ${variants.length} different font weights (${variants.map((v) => `${v.value} (${v.count}x)`).join(", ")}). Typically use ${maxExpected} weights.` });
          }
        }

        if (prop === "borderRadius") {
          const meaningful = variants.filter((v) => v.value !== "0px");
          if (meaningful.length > 2) {
            findings.push({ severity: "warn", category: "inconsistent-rounding",
              message: `${label}: ${meaningful.length} distinct border-radius values (${meaningful.map((v) => v.value).join(", ")}). Pick a consistent rounding scale.` });
          }
        }

        if (prop.startsWith("padding")) {
          const nonZero = variants.filter((v) => v.value !== "0px");
          if (nonZero.length > 3 && (role.includes("button") || role === "input" || role.includes("link"))) {
            findings.push({ severity: "warn", category: "inconsistent-padding",
              message: `${label}: ${nonZero.length} different ${prop} values (${nonZero.map((v) => v.value).join(", ")}). Padding should follow a spacing scale.` });
          }
        }

        // Outlier detection is done after the property loop (see below)

        if (/(?:^|-)h[1-6]$/.test(role) && group.elementCount >= 2) {
          if ((prop === "fontSize" || prop === "color" || prop === "fontWeight") && variants.length > 1) {
            findings.push({ severity: "error", category: "heading-inconsistency",
              message: `${label}: Same heading level but different ${prop} (${variants.map((v) => `${v.value} x${v.count}`).join(", ")}). All ${role.toUpperCase()} should look identical.` });
          }
        }
      }

      // ── Outlier detection: find single-element outliers, but skip active/selected states ──
      // First, identify which elements are outliers on which properties
      const outlierProps = []; // { prop, dominant, outlierValue }
      for (const [prop, data] of Object.entries(group.properties)) {
        if (data.isConsistent) continue;
        const variants = data.variants;
        if (variants.length < 2 || variants[0].count < 3) continue;
        const outlierTotal = variants.slice(1).reduce((sum, v) => sum + v.count, 0);
        if (outlierTotal !== 1 || group.elementCount < 4) continue;
        const isColorProp = prop.toLowerCase().includes("color") || prop === "backgroundColor";
        if (isColorProp && isTransparent(variants[1].value)) continue;
        outlierProps.push({ prop, dominant: variants[0].value, outlierValue: variants[1].value });
      }

      // If the same element is the outlier on 2+ properties, it's likely an intentional
      // variant (active state, badge, tag, avatar, etc.) — not a bug
      if (outlierProps.length >= 2) {
        const hasVisualOutlier = outlierProps.some((o) =>
          o.prop.toLowerCase().includes("color") || o.prop === "backgroundColor" || o.prop === "borderRadius"
        );
        if (hasVisualOutlier) {
          // Skip — likely active/selected state, badge, or intentional accent element
        } else {
          findings.push({ severity: "info", category: "outlier",
            message: `${label}: 1 element differs from the other ${group.elementCount - 1} on ${outlierProps.length} properties (${outlierProps.map((o) => o.prop).join(", ")}). May be an intentional variant.` });
        }
      } else if (outlierProps.length === 1) {
        const o = outlierProps[0];
        const isTextGroup = role === "text";
        const isVisualProp = o.prop === "backgroundColor" || o.prop === "borderRadius" || o.prop === "boxShadow";
        const isColorProp = o.prop === "color" || o.prop === "backgroundColor";
        const isInteractiveRole = role.includes("button") || role.includes("link") || role === "tab";
        if (isTextGroup && isVisualProp) {
          // Skip — single text element with different bg/radius is a badge or accent
        } else if (isInteractiveRole && isColorProp) {
          // Skip — single button/link/tab with different color is likely active/selected state
        } else {
          findings.push({ severity: "warn", category: "outlier",
            message: `${label}: ${group.elementCount - 1}/${group.elementCount} elements use ${o.prop}: ${o.dominant}, but 1 uses ${o.outlierValue}. Likely a bug — should match the others.` });
        }
      }

      const ffProp = group.properties.fontFamily;
      if (ffProp && !ffProp.isConsistent) {
        // Values are already case-normalized by normalizeValue, filter icon fonts and monospace
        const MONO_KEYWORDS = /\b(mono|monospace|sf mono|cascadia|fira code|jetbrains|consolas|menlo|courier)\b/i;
        const realFonts = ffProp.variants.filter((v) =>
          !v.value.match(/\b(icon|lucide|fontawesome|material|symbol|glyph)\b/i) &&
          !v.value.match(MONO_KEYWORDS)
        );
        // Also dedupe by primary font name (first in the list)
        const primaryFonts = new Set(realFonts.map((v) => v.value.split(",")[0].trim()));
        if (primaryFonts.size > 1) {
          findings.push({ severity: "warn", category: "mixed-fonts",
            message: `${label}: ${primaryFonts.size} different font families (${[...primaryFonts].join(", ")}). Mixing fonts within the same role is inconsistent.` });
        }
      }
    }

    // ── Spacing ──
    const spacing = analyses.spacing;
    if (spacing.length > 5) {
      findings.push({ severity: "warn", category: "cramped-text",
        message: `${spacing.length} pairs of text blocks are too close together relative to font size. Add more vertical margin.` });
    }
    for (const issue of spacing.slice(0, 3)) {
      findings.push({ severity: "info", category: "cramped-text-detail",
        message: `"${issue.elementA.selector}" (${issue.elementA.fontSize}) and "${issue.elementB.selector}" (${issue.elementB.fontSize}) are only ${issue.gap}px apart. Need at least ${Math.round(issue.avgFontSize * 0.5)}px.` });
    }

    // ── Color palette (dedupe near-identical colors) ──
    const colorList = [];
    for (const item of elements) {
      for (const cStr of [item.styles.color, item.styles.backgroundColor]) {
        if (!cStr || isTransparent(cStr)) continue;
        const rgb = parseColor(cStr);
        if (!rgb) continue;
        // Check if this color is near-identical to one already collected
        const isDupe = colorList.some((existing) => colorDistance(existing, rgb) < 10);
        if (!isDupe) colorList.push(rgb);
      }
    }
    if (colorList.length > 20) {
      findings.push({ severity: "warn", category: "color-sprawl",
        message: `Page uses ~${colorList.length} perceptually distinct colors. A well-constrained system uses 8-15. Colors may be set ad-hoc instead of from a token palette.` });
    }

    // ── WCAG Contrast ──
    const contrast = analyses.contrast;
    if (contrast.length > 0) {
      const count = contrast.length;
      const shown = contrast.slice(0, 5);
      for (const c of shown) {
        findings.push({ severity: "error", category: "low-contrast",
          message: `"${c.selector}" has contrast ratio ${c.ratio}:1 (requires ${c.required}:1 for ${c.isLarge ? "large" : "normal"} text). Foreground: ${c.fgColor}, background: ${c.bgColor}. Increase the contrast to meet WCAG AA.` });
      }
      if (count > 5) {
        findings.push({ severity: "error", category: "low-contrast",
          message: `${count - 5} more elements fail WCAG AA contrast requirements. Review all text elements for sufficient color contrast.` });
      }
    }

    // ── Tap Targets ──
    const taps = analyses.tapTargets;
    if (taps.tooSmall.length > 0) {
      const shown = taps.tooSmall.slice(0, 3);
      for (const t of shown) {
        findings.push({ severity: "warn", category: "tiny-tap-target",
          message: `"${t.selector}" is ${t.width}x${t.height}px. Interactive elements smaller than 24x24px are very difficult to click/tap.` });
      }
      if (taps.tooSmall.length > 3) {
        findings.push({ severity: "warn", category: "tiny-tap-target",
          message: `${taps.tooSmall.length - 3} more interactive elements are smaller than 24x24px.` });
      }
    }
    if (taps.tooCrowded.length > 0) {
      const shown = taps.tooCrowded.slice(0, 3);
      for (const t of shown) {
        findings.push({ severity: "info", category: "crowded-tap-targets",
          message: `"${t.selectorA}" and "${t.selectorB}" are only ${t.gap}px apart. Adjacent tap targets should have at least 8px spacing.` });
      }
      if (taps.tooCrowded.length > 3) {
        findings.push({ severity: "info", category: "crowded-tap-targets",
          message: `${taps.tooCrowded.length - 3} more pairs of interactive elements are too close together.` });
      }
    }

    // ── Sibling Misalignment ──
    const alignment = analyses.alignment;
    if (alignment.length > 0) {
      const shown = alignment.slice(0, 5);
      for (const a of shown) {
        findings.push({ severity: "info", category: "misaligned-siblings",
          message: `"${a.childA}" and "${a.childB}" (in "${a.parentSelector}") have ${a.axis} edges ${a.offset}px off. Siblings in the same row/column should align exactly.` });
      }
      if (alignment.length > 5) {
        findings.push({ severity: "info", category: "misaligned-siblings",
          message: `${alignment.length - 5} more sibling element pairs are slightly misaligned (1-3px off).` });
      }
    }

    // ── Inconsistent Gaps ──
    const gaps = analyses.gaps;
    for (const g of gaps.slice(0, 5)) {
      findings.push({ severity: "warn", category: "inconsistent-gap",
        message: `"${g.parentSelector}": ${g.childCount} repeated items have inconsistent ${g.direction} gaps (${g.gaps.join(", ")}px). Median is ${g.meanGap}px, max deviation is ${g.maxDeviation}px. Gaps should be uniform.` });
    }

    // ── Line Length ──
    const textLikeTags = new Set(["p", "li", "div", "blockquote", "dd"]);
    for (const item of elements) {
      if (!textLikeTags.has(item.tag)) continue;
      if (!hasDirectText(item.el)) continue;
      if (item.rect.width < 200) continue;
      const fontSize = parseFloat(item.styles.fontSize);
      if (fontSize < 10) continue;
      const estimatedChars = item.rect.width / (fontSize * 0.5);
      if (estimatedChars > 75) {
        findings.push({ severity: "info", category: "line-too-long",
          message: `"${item.selector}" has ~${Math.round(estimatedChars)} characters per line (${item.rect.width}px wide at ${item.styles.fontSize}). Optimal line length is 45-75 characters for readability.` });
      }
    }
    // Cap line-length findings
    const lineLengthFindings = findings.filter((f) => f.category === "line-too-long");
    if (lineLengthFindings.length > 5) {
      const excess = lineLengthFindings.slice(5);
      for (const f of excess) findings.splice(findings.indexOf(f), 1);
      findings.push({ severity: "info", category: "line-too-long",
        message: `${lineLengthFindings.length - 5} more text blocks exceed the recommended 75-character line length.` });
    }

    // ── Line-Height Too Tight ──
    const blockTags = new Set(["p", "li", "div", "td", "dd", "blockquote"]);
    const tightLineHeightFound = [];
    for (const item of elements) {
      if (!blockTags.has(item.tag)) continue;
      if (!hasDirectText(item.el)) continue;
      const fontSize = parseFloat(item.styles.fontSize);
      let lineHeight = parseFloat(item.styles.lineHeight);
      if (item.styles.lineHeight === "normal") lineHeight = fontSize * 1.2;
      if (isNaN(lineHeight) || lineHeight === 0) continue;
      const ratio = lineHeight / fontSize;
      // Only flag multi-line elements
      if (item.rect.height > lineHeight * 1.5 && ratio < 1.2) {
        tightLineHeightFound.push(item);
      }
    }
    for (const item of tightLineHeightFound.slice(0, 5)) {
      const ratio = (parseFloat(item.styles.lineHeight) / parseFloat(item.styles.fontSize)).toFixed(2);
      findings.push({ severity: "warn", category: "tight-line-height",
        message: `"${item.selector}" has line-height ratio of ${ratio} (${item.styles.lineHeight} / ${item.styles.fontSize}). Multi-line text should have at least 1.2x line-height for readability. WCAG recommends 1.5x for body text.` });
    }
    if (tightLineHeightFound.length > 5) {
      findings.push({ severity: "warn", category: "tight-line-height",
        message: `${tightLineHeightFound.length - 5} more text blocks have line-height below 1.2x their font size.` });
    }

    // ── Text Truncation ──
    const truncation = analyses.truncation;
    const ellipsis = truncation.filter((t) => t.type === "ellipsis");
    const clipped = truncation.filter((t) => t.type === "clipped");

    for (const t of clipped.slice(0, 5)) {
      findings.push({ severity: "warn", category: "text-clipped",
        message: `"${t.selector}" has text silently clipped without ellipsis (overflow:hidden). Content is ${t.scrollWidth}px wide but container is ${t.clientWidth}px. Add text-overflow:ellipsis or increase container size.` });
    }
    if (clipped.length > 5) {
      findings.push({ severity: "warn", category: "text-clipped",
        message: `${clipped.length - 5} more elements have silently clipped text.` });
    }
    if (ellipsis.length > 3) {
      findings.push({ severity: "info", category: "text-truncated",
        message: `${ellipsis.length} elements are showing ellipsis (text-overflow). Verify the truncated content isn't critical information.` });
    }

    // ── Z-Index Issues ──
    const zIndex = analyses.zIndex;
    if (zIndex.blockedInteractive.length > 0) {
      for (const b of zIndex.blockedInteractive.slice(0, 3)) {
        findings.push({ severity: "error", category: "blocked-interactive",
          message: `"${b.blockedSelector}" (z-index:${b.interactiveZ}) is covered by "${b.blockerSelector}" (z-index:${b.blockerZ}). Users cannot click this element.` });
      }
    }
    if (zIndex.excessiveZIndex.length > 3) {
      findings.push({ severity: "info", category: "excessive-z-index",
        message: `${zIndex.excessiveZIndex.length} non-interactive elements have z-index > 100 (up to ${Math.max(...zIndex.excessiveZIndex.map((z) => z.zIndex))}). High z-index values indicate stacking context issues. Simplify the z-index scale.` });
    }

    // ── Section Spacing ──
    const sectionSpacing = analyses.sectionSpacing;
    for (const s of sectionSpacing.slice(0, 3)) {
      findings.push({ severity: "warn", category: "inconsistent-section-spacing",
        message: `Gap between "${s.sectionA}" and "${s.sectionB}" is ${s.gap}px but the median section gap is ${s.medianGap}px. Section spacing should be consistent for visual rhythm.` });
    }

    // ── Icon Consistency (within same context) ──
    const icons = analyses.icons;
    if (icons.inconsistentWithinContext.length > 0) {
      const shown = icons.inconsistentWithinContext.slice(0, 5);
      for (const i of shown) {
        findings.push({ severity: "warn", category: "inconsistent-icon-size",
          message: `Icon "${i.selector}" is ${i.width}x${i.height}px but other icons in the same area are ${i.dominantSize}. Icons within the same context should be a consistent size.` });
      }
    }
    if (icons.misaligned.length > 0) {
      for (const i of icons.misaligned.slice(0, 3)) {
        findings.push({ severity: "info", category: "misaligned-icon",
          message: `Icon "${i.iconSelector}" is ${i.offset}px off-center from adjacent text "${i.textSelector}". Icons should be vertically centered with their label.` });
      }
    }

    // ── Nested Scrolling ──
    const nested = analyses.nestedScroll;
    for (const n of nested.slice(0, 3)) {
      findings.push({ severity: "warn", category: "nested-scroll",
        message: `"${n.innerSelector}" is a scrollable container nested inside "${n.outerSelector}" (also scrollable). Nested scrollable areas create scroll traps that confuse users.` });
    }
    if (nested.length > 3) {
      findings.push({ severity: "warn", category: "nested-scroll",
        message: `${nested.length - 3} more nested scrollable containers detected.` });
    }

    // ── Form Labels ──
    const labels = analyses.labels;
    if (labels.length > 0) {
      for (const l of labels.slice(0, 5)) {
        findings.push({ severity: "error", category: "missing-label",
          message: `"${l.selector}" (${l.type}) has no visible label, aria-label, aria-labelledby, or title. Screen readers and users cannot identify this field. Add a <label> or aria-label.` });
      }
      if (labels.length > 5) {
        findings.push({ severity: "error", category: "missing-label",
          message: `${labels.length - 5} more form fields are missing accessible labels.` });
      }
    }

    // ── Cramped Padding ──
    const cramped = analyses.crampedPadding;
    if (cramped.length > 0) {
      for (const c of cramped.slice(0, 5)) {
        findings.push({ severity: "warn", category: "cramped-padding",
          message: `"${c.selector}" has text (${c.fontSize}px) pressed against its borders (padding: ${c.padding}px). Cramped sides: ${c.crampedSides.join(", ")}. Use at least ${c.minRecommended}px padding for comfortable reading.` });
      }
      if (cramped.length > 5) {
        findings.push({ severity: "warn", category: "cramped-padding",
          message: `${cramped.length - 5} more containers have insufficient padding around their text content.` });
      }
    }

    // ── Nested Panels ──
    const nestedPanels = analyses.nestedPanels;
    if (nestedPanels.length > 0) {
      const shown = nestedPanels.slice(0, 5);
      for (const p of shown) {
        findings.push({ severity: "warn", category: "nested-panel",
          message: `"${p.innerSelector}" (${p.innerSize}) is a bordered/shadowed panel nested inside "${p.outerSelector}" (${p.outerSize}). Panel-in-panel creates visual clutter — consider flattening the hierarchy or removing the inner container's border/background.` });
      }
      if (nestedPanels.length > 5) {
        findings.push({ severity: "warn", category: "nested-panel",
          message: `${nestedPanels.length - 5} more nested panel-in-panel instances detected. Excessive nesting adds visual weight and reduces content hierarchy clarity.` });
      }
    }

    // ── Rounded Border Sprawl ──
    const roundedSprawl = analyses.roundedBorderSprawl;
    if (roundedSprawl.tooManyVariants) {
      const radii = roundedSprawl.distinctRadii.map((r) => `${r} (${roundedSprawl.radiusCounts[r]}x)`).join(", ");
      findings.push({ severity: "warn", category: "border-radius-sprawl",
        message: `${roundedSprawl.distinctRadii.length} distinct border-radius values on large containers: ${radii}. A design system typically uses 2-3 radius values. Consolidate to a consistent rounding scale.` });
    }
    if (roundedSprawl.overuse) {
      findings.push({ severity: "info", category: "rounded-panel-overuse",
        message: `${roundedSprawl.totalRoundedPanels} large containers have rounded corners. Excessive rounding can make the UI feel cluttered — consider using sharp corners for outer containers and reserving rounding for inner cards/components.` });
    }

    // Sort: errors first, then warns, then info
    const severityOrder = { error: 0, warn: 1, info: 2 };
    findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    return findings;
  }

  // ─── Scoring ──────────────────────────────────────────────

  function computeScore(findings) {
    // Group findings by category — diminishing penalty for repeat issues in same category
    const byCategory = {};
    for (const f of findings) {
      if (!byCategory[f.category]) byCategory[f.category] = [];
      byCategory[f.category].push(f);
    }

    let deductions = 0;
    const severityBase = { error: 10, warn: 4, info: 1 };

    for (const [category, items] of Object.entries(byCategory)) {
      // First finding in a category gets full weight, subsequent get diminishing
      for (let i = 0; i < items.length; i++) {
        const base = severityBase[items[i].severity] || 1;
        const diminish = 1 / (1 + i * 0.7); // 1st: 100%, 2nd: 59%, 3rd: 42%, etc.
        deductions += base * diminish;
      }
    }

    return Math.max(0, Math.min(100, Math.round(100 - deductions)));
  }

  // ─── Run ──────────────────────────────────────────────────

  const elements = collectElements();
  const consistency = analyzeConsistency(elements);
  const visualUnits = detectVisualUnits(elements);
  const detectedCharts = detectCharts();

  // Add detected charts as visual units (they're SVGs, so not in the element pipeline)
  for (const chart of detectedCharts) {
    visualUnits.push({
      type: "chart",
      rect: chart.rect,
      memberCount: chart.shapeCount,
      selector: chart.selector,
      members: [{ tag: "svg", selector: chart.selector, rect: chart.rect }],
    });
  }

  const analyses = {
    spacing: analyzeSpacing(elements),
    contrast: analyzeContrast(elements),
    tapTargets: analyzeTapTargets(elements),
    alignment: analyzeSiblingAlignment(elements),
    gaps: analyzeRepeatedItemGaps(elements),
    truncation: analyzeTextTruncation(elements),
    zIndex: analyzeZIndex(elements),
    sectionSpacing: analyzeSectionSpacing(elements),
    icons: analyzeIconConsistency(),
    nestedScroll: analyzeNestedScrolling(elements),
    labels: analyzeFormLabels(elements),
    crampedPadding: analyzeCrampedPadding(elements),
    nestedPanels: analyzeNestedPanels(elements),
    roundedBorderSprawl: analyzeRoundedBorderSprawl(elements),
    charts: detectedCharts,
  };

  const findings = generateFindings(consistency, elements, analyses);
  const score = computeScore(findings);

  const result = {
    url: location.href,
    title: document.title,
    timestamp: new Date().toISOString(),
    score,
    totalElementsAnalyzed: elements.length,
    findings,
    consistency,
    analyses,
    visualUnits: visualUnits.map((u) => ({
      type: u.type, rect: u.rect, memberCount: u.memberCount,
      selector: u.selector, members: u.members,
      children: (u.children || []).map((c) => ({
        type: c.type, rect: c.rect, memberCount: c.memberCount,
        selector: c.selector,
      })),
    })),
    summary: {
      componentCounts: {},
      findingCounts: { error: 0, warn: 0, info: 0 },
    },
  };

  for (const u of visualUnits) {
    result.summary.componentCounts[u.type] = (result.summary.componentCounts[u.type] || 0) + 1;
  }
  for (const f of findings) {
    result.summary.findingCounts[f.severity]++;
  }

  // When loaded via script tag, expose result globally for test pages
  if (typeof window !== 'undefined') window.uxlyResult = result;

  return result;
})();
