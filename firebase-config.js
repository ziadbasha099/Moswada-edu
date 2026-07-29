/* ============================================================
   Firebase configuration — shared by downloads.html و admin.html
   ------------------------------------------------------------
   عدّل القيم بالأسفل بإعدادات مشروعك في Firebase:
   Firebase Console → Project settings → General → Your apps
   → SDK setup and configuration → Config

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
