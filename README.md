# Vishnu's Banners

<img width="557" height="446" alt="image" src="https://github.com/user-attachments/assets/0f01241a-9fd7-4ef4-a5ec-81af0264c1ba" />


Notion-style banners for Obsidian. Every note gets one:

- `banner:` in frontmatter wins: a URL, `[[image.jpg]]`, a vault path, or `none`.
- Otherwise a cover is picked from `covers.json` by hashing the note's filename (same note → same cover).
- `banner_y: 0–100` sets the vertical crop.

In edit mode, hover the banner for **Change** and **Reposition**. There's also a **Change banner** command.

`covers.json` lists Notion's built-in covers grouped by collection; collections with `"auto": true` feed the automatic pick.

Run `./deploy.sh` to copy the plugin into the vault.
