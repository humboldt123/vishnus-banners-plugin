const { Plugin, MarkdownView, TFile, Modal, FuzzySuggestModal, Setting, Notice, setIcon } = require("obsidian");

// Frontmatter:
//   banner: <Set/codename>                       a banner from the library (Assets/Attachments/Banners)
//   banner: <url | [[image]] | vault/path.jpg>   use this image
//   banner: auto                                 automatic cover, even outside the auto folders
//   banner: none                                 no banner
//   banner_y: 0–100                                      vertical crop position (also reads banner-y)

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"];

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

module.exports = class VishnusBanners extends Plugin {
  async onload() {
    await this.reloadCoversIfChanged();

    const refresh = () => this.refreshAll();
    this.registerEvent(this.app.workspace.on("layout-change", refresh));
    this.registerEvent(this.app.workspace.on("file-open", async () => {
      await this.reloadCoversIfChanged();
      await this.rescanLibrary();
      refresh();
    }));
    this.registerEvent(this.app.metadataCache.on("changed", refresh));
    this.registerEvent(this.app.vault.on("rename", refresh));
    // Keep each image's .banner file (invisible in Obsidian) in step with it
    this.registerEvent(this.app.vault.on("delete", (f) => this.onLibraryImageDeleted(f)));
    this.registerEvent(this.app.vault.on("rename", (f, oldPath) => this.onLibraryImageRenamed(f, oldPath)));
    this.app.workspace.onLayoutReady(refresh);

    this.addCommand({
      id: "change-banner",
      name: "Change banner",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) new BannerModal(this, file).open();
        return true;
      },
    });
  }

  // Re-fit banners when a pane is resized
  observe(scroller) {
    this.observed ??= new WeakSet();
    if (this.observed.has(scroller)) return;
    this.observed.add(scroller);
    this.resizeObserver ??= new ResizeObserver(() => this.refreshAll());
    this.resizeObserver.observe(scroller);
  }

  onunload() {
    this.resizeObserver?.disconnect();
    document.querySelectorAll(".vb-banner").forEach((el) => el.remove());
  }

  // covers.json lives in the plugin folder, outside vault events: check its mtime instead
  async reloadCoversIfChanged() {
    const stat = await this.app.vault.adapter.stat(`${this.manifest.dir}/covers.json`);
    if (stat && stat.mtime !== this.coversMtime) {
      this.coversMtime = stat.mtime;
      await this.loadCovers();
    }
  }

  async loadCovers() {
    this.wordCache = new Map();
    this.pendingCounts = new Set();
    let data = null;
    try {
      data = JSON.parse(await this.app.vault.adapter.read(`${this.manifest.dir}/covers.json`));
      this.collections = data.collections ?? [];
    } catch (e) {
      console.error("Vishnu's Banners: couldn't read covers.json", e);
      this.collections = [];
    }
    this.autoRules = data?.auto ?? {};
    this.libraryConf = data?.library ?? {};
    await this.loadLibrary();
    this.buildAutoPool();
  }

  // autoSets are folder-name patterns: "Notion *", "Pomological", "*"
  buildAutoPool() {
    const pats = (this.libraryConf.autoSets ?? []).map((p) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"));
    const fromLibrary = this.library.filter((e) => e.src && pats.some((re) => re.test(e.set))).map((e) => e.src);
    // Fall back to the plain URL list when the library isn't there (e.g. a fresh device)
    this.autoPool = fromLibrary.length ? fromLibrary : this.collections.filter((c) => c.auto).flatMap((c) => c.covers);
  }

  // Rescan the library at most every 30s, so banners added or deleted by hand show up
  async rescanLibrary() {
    if (Date.now() - (this.lastScan ?? 0) < 30000) return;
    this.lastScan = Date.now();
    await this.loadLibrary();
    this.buildAutoPool();
  }

  // "<root>/Set/x.banner.jpg" -> "<root>/Set/x.banner", or null if it isn't a library image
  metaPathFor(imagePath) {
    const root = (this.libraryConf?.path ?? "Assets/Attachments/Banners") + "/";
    const m = imagePath.match(/^(.*\.banner)\.[A-Za-z0-9]+$/);
    return imagePath.startsWith(root) && m ? m[1] : null;
  }

  async onLibraryImageDeleted(file) {
    const meta = this.metaPathFor(file.path);
    if (meta && (await this.app.vault.adapter.exists(meta))) {
      await this.app.vault.adapter.trashLocal(meta); // into the vault's .trash, recoverable
      this.lastScan = 0;
    }
  }

  async onLibraryImageRenamed(file, oldPath) {
    const oldMeta = this.metaPathFor(oldPath);
    if (!oldMeta || !(await this.app.vault.adapter.exists(oldMeta))) return;
    // New name keeps the codename.banner.<ext> shape: move the metadata with it.
    // Renamed to something else (or out of the library): leave the metadata where it is.
    const newMeta = this.metaPathFor(file.path);
    if (newMeta && !(await this.app.vault.adapter.exists(newMeta))) await this.app.vault.adapter.rename(oldMeta, newMeta);
    this.lastScan = 0;
  }

  // Library: <root>/<Set>/<codename>.banner (metadata) + <codename>.banner.<ext> (image, optional)
  async loadLibrary() {
    this.library = [];
    const root = this.libraryConf.path ?? "Assets/Attachments/Banners";
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(root))) return;
    for (const dir of (await adapter.list(root)).folders) {
      const set = dir.split("/").pop();
      const files = (await adapter.list(dir)).files;
      for (const f of files.filter((f) => f.endsWith(".banner"))) {
        const meta = {};
        for (const line of (await adapter.read(f)).split("\n")) {
          const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
          if (!m) continue;
          try { meta[m[1]] = JSON.parse(m[2]); } catch { meta[m[1]] = m[2]; }
        }
        const image = files.find((x) => x.startsWith(f + ".") && IMAGE_EXTS.includes(x.split(".").pop().toLowerCase()));
        const code = f.split("/").pop().replace(/\.banner$/, "");
        this.library.push({ set, code, key: `${set}/${code}`, meta, src: image ? adapter.getResourcePath(image) : meta.url ?? null });
      }
    }
    this.libraryIndex = new Map(this.library.map((e) => [e.key, e]));
  }

  // Word count (frontmatter excluded), cached by mtime; null until first read
  words(file) {
    const hit = this.wordCache.get(file.path);
    if (hit && hit.mtime === file.stat.mtime) return hit.words;
    if (!this.pendingCounts.has(file.path)) {
      this.pendingCounts.add(file.path);
      this.app.vault.cachedRead(file).then((text) => {
        const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
        this.wordCache.set(file.path, { mtime: file.stat.mtime, words: body.split(/\s+/).filter(Boolean).length });
        this.pendingCounts.delete(file.path);
        this.refreshAll();
      });
    }
    return null;
  }

  // Whether a note without its own `banner:` gets an automatic cover
  wantsAuto(file) {
    if (file.extension !== "md") return false;
    const { folders = [], minWords = {} } = this.autoRules;
    if (!folders.some((f) => file.path.startsWith(f))) return false;
    for (const [folder, min] of Object.entries(minWords)) {
      if (!file.path.startsWith(folder)) continue;
      const n = this.words(file);
      return n !== null && n >= min;
    }
    return true;
  }

  frontmatter(file) {
    return this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
  }

  // Turns a `banner:` value into something usable as a CSS url()
  toSrc(value, file) {
    const v = String(value).trim().replace(/^!?\[\[|\]\]$/g, "").split("|")[0];
    if (/^(https?:|data:|app:)/.test(v)) return v;
    const entry = this.libraryIndex?.get(v);
    if (entry) return entry.src;
    const dest = this.app.metadataCache.getFirstLinkpathDest(v, file.path) ?? this.app.vault.getAbstractFileByPath(v);
    return dest instanceof TFile ? this.app.vault.getResourcePath(dest) : null;
  }

  autoCover(file) {
    return this.autoPool.length ? this.autoPool[hash(file.basename) % this.autoPool.length] : null;
  }

  resolve(file) {
    const fm = this.frontmatter(file);
    const value = fm.banner;
    if (value === "none" || value === false) return null;
    const own = typeof value === "string" && value.trim();
    const src = own === "auto" ? this.autoCover(file)
      : own ? this.toSrc(value, file)
      : this.wantsAuto(file) ? this.autoCover(file) : null;
    const entry = own && this.libraryIndex?.get(own);
    let y = parseFloat(fm.banner_y ?? fm["banner-y"] ?? entry?.meta?.crop?.y);
    if (isNaN(y)) y = 50;
    else if (y <= 1) y *= 100; // old Banners plugin stored 0–1
    return src ? { src, y } : null;
  }

  async setBanner(file, value) {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (value === undefined) delete fm.banner;
      else fm.banner = value;
      delete fm["banner-y"];
      delete fm.banner_y;
    });
  }

  async setY(file, y) {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      delete fm["banner-y"];
      fm.banner_y = Math.round(y);
    });
  }

  refreshAll() {
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) return;
      const banner = this.resolve(view.file);
      const hosts = [
        { el: view.contentEl.querySelector(".markdown-source-view .cm-sizer"), editable: true },
        { el: view.contentEl.querySelector(".markdown-reading-view .markdown-preview-sizer"), editable: false },
      ];
      for (const host of hosts) {
        if (!host.el) continue;
        let el = host.el.querySelector(":scope > .vb-banner");
        if (!banner) { el?.remove(); continue; }
        if (!el) {
          el = createDiv({ cls: "vb-banner" });
          host.el.prepend(el);
          if (host.editable) this.addControls(el, view);
        }
        if (el.dataset.repositioning) continue;
        el.style.backgroundImage = `url("${banner.src}")`;
        el.style.backgroundPosition = `50% ${banner.y}%`;
        // Bleed out to the scroll area's edges (top, left, right), past its padding
        const scroller = host.el.closest(".cm-scroller, .markdown-preview-view");
        if (scroller && el.offsetParent) {
          this.observe(scroller);
          el.style.margin = "0 0 1.5rem 0";
          el.style.width = "";
          const s = scroller.getBoundingClientRect();
          const b = el.getBoundingClientRect();
          el.style.marginTop = `-${b.top - s.top - scroller.clientTop + scroller.scrollTop}px`;
          el.style.marginLeft = `-${b.left - s.left - scroller.clientLeft}px`;
          el.style.width = `${scroller.clientWidth}px`;
        }
      }
    });
  }

  addControls(el, view) {
    this.fillControls(el.createDiv({ cls: "vb-controls" }), el, () => view.file);
  }

  fillControls(bar, el, getFile) {
    bar.empty();
    const button = (label, icon, onClick) => {
      const b = bar.createEl("button", { cls: "vb-button", attr: { "aria-label": label } });
      setIcon(b, icon);
      b.createSpan({ text: label });
      b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
    };
    button("Change", "image", () => getFile() && new BannerModal(this, getFile()).open());
    button("Reposition", "move-vertical", () => getFile() && this.reposition(el, bar, getFile, getFile()));
  }

  // Notion-style: drag the image up/down, then save or cancel
  reposition(el, bar, getFile, file) {
    const start = this.resolve(file);
    if (!start) return;
    let y = start.y;
    el.dataset.repositioning = "1";
    el.addClass("is-repositioning");
    bar.empty();

    const hint = el.createDiv({ cls: "vb-hint", text: "Drag image to reposition" });
    let dragging = null;
    const onDown = (e) => { dragging = { startY: e.clientY, startPos: y }; e.preventDefault(); };
    const onMove = (e) => {
      if (!dragging) return;
      const delta = ((e.clientY - dragging.startY) / el.clientHeight) * 100;
      y = Math.min(100, Math.max(0, dragging.startPos - delta));
      el.style.backgroundPosition = `50% ${y}%`;
    };
    const onUp = () => { dragging = null; };
    el.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    const finish = async (save) => {
      el.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      hint.remove();
      el.removeClass("is-repositioning");
      delete el.dataset.repositioning;
      this.fillControls(bar, el, getFile);
      if (save) await this.setY(file, y);
      this.refreshAll();
    };
    const save = bar.createEl("button", { cls: "vb-button mod-cta", text: "Save position" });
    const cancel = bar.createEl("button", { cls: "vb-button", text: "Cancel" });
    save.addEventListener("click", (e) => { e.stopPropagation(); finish(true); });
    cancel.addEventListener("click", (e) => { e.stopPropagation(); finish(false); });
  }
};

class BannerModal extends Modal {
  constructor(plugin, file) {
    super(plugin.app);
    this.plugin = plugin;
    this.file = file;
  }

  async onOpen() {
    const { contentEl, plugin, file } = this;
    await plugin.loadLibrary(); // pick up banners added since startup
    this.modalEl.addClass("vb-modal");
    this.setTitle("Banner");

    const current = plugin.frontmatter(file).banner;
    const choose = async (value) => {
      await plugin.setBanner(file, value);
      this.close();
    };

    new Setting(contentEl)
      .setName("Link")
      .setDesc("Paste an image URL.")
      .addText((t) => {
        t.setPlaceholder("https://…");
        if (typeof current === "string" && /^https?:/.test(current)) t.setValue(current);
        t.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && t.getValue().trim()) choose(t.getValue().trim()); });
        this.linkInput = t;
      })
      .addButton((b) => b.setButtonText("Use").onClick(() => {
        const v = this.linkInput.getValue().trim();
        if (v) choose(v);
      }));

    new Setting(contentEl)
      .setName("From vault")
      .setDesc("Pick an image file in this vault.")
      .addButton((b) => b.setButtonText("Browse…").onClick(() => {
        new ImageSuggest(plugin.app, async (img) => choose(`[[${img.path}]]`)).open();
      }));

    new Setting(contentEl)
      .setName("Automatic")
      .setDesc("A cover picked from this note's filename. “Default” follows the folder rules in covers.json.")
      .addButton((b) => b.setButtonText("Always on").onClick(() => choose("auto")))
      .addButton((b) => b.setButtonText("Default").onClick(() => choose(undefined)))
      .addButton((b) => b.setButtonText("No banner").setWarning().onClick(() => choose("none")));

    // Library sets, one heading each
    const gallery = contentEl.createDiv({ cls: "vb-gallery" });
    const sets = [...new Set(plugin.library.map((e) => e.set))].sort();
    for (const set of sets) {
      gallery.createEl("h6", { text: set });
      const grid = gallery.createDiv({ cls: "vb-grid" });
      for (const e of plugin.library.filter((x) => x.set === set && x.src)) {
        const tile = grid.createEl("button", { cls: "vb-tile", attr: { title: e.meta.title ?? e.code } });
        tile.createEl("img", { attr: { src: e.src, loading: "lazy", alt: "" } });
        if (e.key === current) tile.addClass("is-selected");
        tile.addEventListener("click", () => choose(e.key));
      }
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ImageSuggest extends FuzzySuggestModal {
  constructor(app, onPick) {
    super(app);
    this.onPick = onPick;
    this.setPlaceholder("Search images…");
  }
  getItems() {
    return this.app.vault.getFiles().filter((f) => IMAGE_EXTS.includes(f.extension.toLowerCase()));
  }
  getItemText(f) {
    return f.path;
  }
  renderSuggestion(match, el) {
    el.addClass("vb-suggestion");
    el.createEl("img", { attr: { src: this.app.vault.getResourcePath(match.item), loading: "lazy" } });
    el.createSpan({ text: match.item.path });
  }
  onChooseItem(f) {
    this.onPick(f);
  }
}
