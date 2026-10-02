RFID PWA Mobile Fix V4

Purpose:
- Fix Apps Script access on Android/Chrome when multiple Google accounts are signed in.
- PWA now tries a credentialless CORS GET first:
    credentials: "omit"
    mode: "cors"
    redirect: "follow"
    cache: "no-store"
- This prevents Google account cookies from being sent with the API request.
- JSONP remains as fallback.
- Existing canonical /macros/s/.../exec URL cleanup remains.
- Service Worker cache bumped to rfid-audit-mobile-v4.

Replace in:
jame023/work-calendar-pages/rfid-transparency-pwa/

Files:
1) index.html
2) sw.js

After upload:
1) Open GitHub Pages URL in Chrome.
2) Refresh twice.
3) Confirm the web page itself shows "เชื่อมต่อสำเร็จ" BEFORE installing.
4) Then install the PWA.
