PWA Mobile V1

ไฟล์ที่เปลี่ยน:
- index.html
- manifest.webmanifest
- sw.js

ใช้ไอคอนเดิมใน repo:
- icon-192.png
- icon-512.png

ความสามารถ:
- Android/Chrome: ปุ่ม "ติดตั้งแอป" เรียก native install prompt เมื่อ browser รองรับ
- iPhone/iPad: แสดงคำแนะนำ Safari > Share > Add to Home Screen
- standalone display
- portrait orientation
- Apple mobile web app metadata
- cache หน้าเว็บ/manifest/icons สำหรับ offline shell
- ไม่เปลี่ยน Apps Script URL, RFID API, Gateway หรือข้อมูล attendance

หลังอัปโหลด GitHub Pages ให้ refresh 1 ครั้งเพื่อให้ service worker v2 เข้าควบคุม
