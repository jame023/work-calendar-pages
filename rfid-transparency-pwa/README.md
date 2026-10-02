# RFID Transparency PWA

โฟลเดอร์นี้เป็น Phase 2B สำหรับติดตั้งหน้า "ตรวจสอบการสแกนบัตร" ลงหน้าจอโทรศัพท์/คอมพิวเตอร์

## ไม่กระทบระบบเดิม

- ไม่แก้ Gateway
- ไม่แก้ H2/C6
- ไม่เขียน RFID_Log
- ไม่เขียน RFID_Audit_Log
- หน้า Apps Script Secure เดิมยังเป็น backend/viewer หลัก
- PWA นี้เป็น shell สำหรับเปิดหน้า viewer แบบติดตั้งได้

## ไฟล์

- index.html
- manifest.webmanifest
- sw.js
- icon-192.png
- icon-512.png

## ติดตั้งบน GitHub Pages

ให้อัปโหลดทั้ง 5 ไฟล์ไปไว้ในโฟลเดอร์เดียวกัน เช่น:

rfid-transparency-pwa/

ถ้าใช้ repository `work-calendar-pages` URL จะมีรูปแบบประมาณ:

https://<user>.github.io/work-calendar-pages/rfid-transparency-pwa/

## เปิดครั้งแรก

1. เปิด URL PWA
2. ใส่ Apps Script Web App URL ตัวเดิมที่ลงท้าย `/exec`
3. ใส่ `RFID_TRANSPARENCY_VIEW_TOKEN`
4. กด "บันทึกและเปิดหน้า"

ค่า 2 อย่างนี้เก็บใน localStorage ของเครื่องที่เปิด PWA เท่านั้น

## การติดตั้ง

Android/Chrome:
- เปิดเมนู Chrome
- เลือก Install app / Add to Home screen

Windows/Chrome หรือ Edge:
- เปิด URL PWA
- เลือก Install app จากเมนู browser

## Offline

ตัว shell ของ PWA เปิดได้เมื่อออฟไลน์ แต่ข้อมูล RFID สดมาจาก Apps Script ดังนั้นต้องมีอินเทอร์เน็ตจึงจะโหลด/รีเฟรชข้อมูลจริงได้
