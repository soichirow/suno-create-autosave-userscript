# Suno Create Autosave (Tampermonkey Userscript)

Saves and restores **Lyrics / Style / Song Title** on `https://suno.com/create`  
Data is stored **per workspace id (`wid`)** via Tampermonkey `GM_setValue`.

## Features
- Autosave & restore:
  - Lyrics (empty -> inserts `[Instrumental]` automatically)
  - Style text
  - Song Title (auto appends `_YYMMDD` on blur / save)
- Workspace separation using URL parameter: `?wid=<id>`
- Adds a small `TM Clear` button for Lyrics:
  - Clears lyrics and allows keeping it empty for that `wid`

## Install
1. Install Tampermonkey (Chrome/Edge/Firefox).
2. Open the userscript:
   - **Click this**: `Suno-Create-Autosave.user.js` (raw view)
3. Tampermonkey will prompt installation → Install.

## Notes
- This is an unofficial script. Use at your own risk.
- Saved data stays in your browser/Tampermonkey storage.

## License
MIT
