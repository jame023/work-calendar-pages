# RFID Transparency PWA v2

รุ่นนี้ไม่ใช้ iframe กับ Apps Script แล้ว

## ต้องอัปเดต 2 ส่วน

1. Apps Script: ใช้ `Code_PHASE2B_JSONP_READY.gs` แล้ว Deploy เป็น New version บน deployment เดิม
2. GitHub Pages: แทนไฟล์ในโฟลเดอร์ PWA ด้วยไฟล์ชุด v2

## PWA อ่านข้อมูลอย่างไร

PWA เรียก Apps Script แบบ read-only JSONP:
`?api=transparency&token=...&date=...&callback=...`

Gateway route `?data=...` ไม่เปลี่ยนและไม่ต้อง flash

## ไฟล์ GitHub Pages

- index.html
- manifest.webmanifest
- sw.js
- icon-192.png
- icon-512.png

หลังอัปโหลด ให้ hard refresh หรือปิด/เปิด PWA ใหม่เพื่อให้ service worker v2 ทำงาน
