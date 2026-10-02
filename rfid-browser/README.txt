RFID Browser Shortcut

Upload index.html to a NEW GitHub Pages folder:
rfid-browser/index.html

Do not add manifest.webmanifest or sw.js to this folder.

Open:
https://jame023.github.io/work-calendar-pages/rfid-browser/

Android Chrome:
1) Confirm "เชื่อมต่อสำเร็จ".
2) Chrome menu (⋮) -> Add to Home screen / เพิ่มไปยังหน้าจอหลัก.
3) Choose Create shortcut / สร้างทางลัด if shown.
4) The icon should open the page in Chrome, not standalone PWA.

This keeps the V4 Apps Script connection behavior:
- credentials: omit
- CORS first
- JSONP fallback
- canonical Apps Script /exec URL
