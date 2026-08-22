/* ============================================================
   Firebase configuration — shared by index.html, app.html,
   downloads.html و admin.html
   ------------------------------------------------------------
   عدّل القيم بالأسفل بإعدادات مشروعك في Firebase:
   Firebase Console → Project settings → General → Your apps
   → SDK setup and configuration → Config

   يُستورد هذا الملف من shared.js (المشترك بين index.html و
   app.html) — استيراد مفقود لهذا الملف يمنع تشغيل كل JavaScript
   في الموقع، فتأكد إن اسمه "firebase-config.js" بالظبط (بدون
   أي رقم أو نص إضافي في الاسم).

   تأكد أيضاً من Firebase Console → Authentication → Sign-in method
   إنك فعّلت:
     - Email/Password
     - Google

   وإن قواعد أمان Firestore (تبويب Rules) بتقيّد كل مستخدم على
   بياناته فقط:

     rules_version = '2';
     service cloud.firestore {
       match /databases/{database}/documents {
         match /users/{uid}/{document=**} {
           allow read, write: if request.auth != null
                               && request.auth.uid == uid;
         }
       }
     }

   راجع ملف README-Firebase-Setup.md لخطوات الإعداد كاملة
   (إنشاء المشروع، تفعيل Authentication و Firestore، وإنشاء
   حساب المدير).
   ============================================================ */

export const firebaseConfig = {
  apiKey: "AIzaSyAMp9O6tStKSXr3fLfY944ic2kYHk1o3Ew",
  authDomain: "moswada-10955.firebaseapp.com",
  projectId: "moswada-10955",
  storageBucket: "moswada-10955.firebasestorage.app",
  messagingSenderId: "304820382713",
  appId: "1:304820382713:web:a8ba37a0b579da23beab28",
  measurementId: "G-6DK191VFN4"
};

/* اسم مجموعة (collection) الروابط في Firestore — لا تغيّره إلا إذا
   غيّرته في القاعدة أيضاً */
export const DOWNLOADS_COLLECTION = "downloads";

/* البريد الإلكتروني المسموح له بدخول لوحة الأدمن. لازم يكون
   نفس القيمة المكتوبة في firestore.rules بالظبط (وإلا هتلاقي
   نفسك عدّيت من شاشة الدخول بس الكتابة في Firestore هترفض). */
export const ADMIN_EMAIL = "ziadbasha099@gmail.com";

/* ============================================================
   FIREBASE APP CHECK — reCAPTCHA v3 (حماية من البوتات)
   ------------------------------------------------------------
   هذا هو "الـ reCAPTCHA" اللي بيحمي تسجيل الدخول/التسجيل وكل
   كتابة على Firestore (Auth + Firestore + Storage) من البوتات
   والسكريبتات الآلية، من غير ما يطلب من المستخدم الحقيقي يعمل
   أي حاجة إضافية (يشتغل في الخلفية تلقائياً).

   خطوات التفعيل (لازم تتعمل قبل ما القيمة دي تشتغل):
   1) Firebase Console → مشروعك → App Check (من القائمة الجانبية،
      تحت Build).
   2) "Get started" → اختر تطبيق الويب بتاعك → المزوّد
      "reCAPTCHA v3" → اضغط Save. فايربيز هيولّد مفتاح reCAPTCHA
      تلقائياً ويوريك الـ Site Key.
   3) انسخ الـ Site Key والصقه بدل القيمة تحت.
   4) بعد ما تتأكد إن الموقع شغال تمام بالمفتاح الجديد، ارجع لتبويب
      App Check → لكل من Firestore و Authentication → فعّل
      "Enforce" (بدون تفعيل enforce، Firebase بس بيراقب من غير
      ما يمنع حد فعلياً — التفعيل هو اللي بيحوّلها لحماية حقيقية).

   ملاحظة للتطوير المحلي (localhost): App Check بيرفض localhost
   افتراضياً. عشان تجرب محلياً بس، حط السطر ده في الـ console قبل
   تحميل الصفحة (Debug Token)، وسجّله في Firebase Console →
   App Check → Manage debug tokens:
     self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
   لا تسيب السطر ده في كود الإنتاج أبداً.
   ============================================================ */
export const RECAPTCHA_V3_SITE_KEY = "6Lcg8ootAAAAAJ-Q58iOltqowG3dELsdv6DTLbe1";

export const SHARED_FOLDERS_COLLECTION = "sharedFolders";
