const { Plugin, MarkdownView, TFile, Modal, FuzzySuggestModal, Setting, Notice, setIcon } = require("obsidian");

// Frontmatter:
//   banner: <url | [[image]] | vault/path.jpg | none>   override the automatic cover
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
    await this.loadCovers();

    const refresh = () => this.refreshAll();
    this.registerEvent(this.app.workspace.on("layout-change", refresh));
    this.registerEvent(this.app.workspace.on("file-open", refresh));
    this.registerEvent(this.app.metadataCache.on("changed", refresh));
    this.registerEvent(this.app.vault.on("rename", refresh));
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

  async loadCovers() {
    try {
      const data = JSON.parse(await this.app.vault.adapter.read(`${this.manifest.dir}/covers.json`));
      this.collections = data.collections ?? [];
    } catch (e) {
      console.error("Vishnu's Banners: couldn't read covers.json", e);
      this.collections = [];
    }
    this.autoPool = this.collections.filter((c) => c.auto).flatMap((c) => c.covers);
  }

  frontmatter(file) {
    return this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
  }

  // Turns a `banner:` value into something usable as a CSS url()
  toSrc(value, file) {
    const v = String(value).trim().replace(/^!?\[\[|\]\]$/g, "").split("|")[0];
    if (/^(https?:|data:|app:)/.test(v)) return v;
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
    const src = typeof value === "string" && value.trim() ? this.toSrc(value, file) : this.autoCover(file);
    let y = parseFloat(fm.banner_y ?? fm["banner-y"]);
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

  onOpen() {
    const { contentEl, plugin, file } = this;
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
      .setDesc("Use the cover picked from this note's filename.")
      .addButton((b) => b.setButtonText("Reset").onClick(() => choose(undefined)))
      .addButton((b) => b.setButtonText("No banner").setWarning().onClick(() => choose("none")));

    const gallery = contentEl.createDiv({ cls: "vb-gallery" });
    for (const col of plugin.collections) {
      gallery.createEl("h6", { text: col.name });
      const grid = gallery.createDiv({ cls: "vb-grid" });
      for (const url of col.covers) {
        const tile = grid.createEl("button", { cls: "vb-tile" });
        tile.createEl("img", { attr: { src: url, loading: "lazy", alt: "" } });
        if (url === current) tile.addClass("is-selected");
        tile.addEventListener("click", () => choose(url));
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
