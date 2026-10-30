// File: modules/firebase-config.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { 
    getFirestore, collection, addDoc, doc, updateDoc, onSnapshot, 
    query, where, orderBy, setDoc, getDoc, getDocs, limit, startAfter, Timestamp, serverTimestamp 
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { 
    getAuth, signInWithEmailAndPassword, sendPasswordResetEmail, GoogleAuthProvider, 
    signInWithPopup, onAuthStateChanged, signOut 
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-analytics.js";

// ==========================================
// FIREBASE CONFIGURATION
// ==========================================
const firebaseConfig = {
  apiKey: "AIzaSyASYcouPGDMx5_V9ZUZ3RcFifCxcbpcst8",
  authDomain: "spidy-book-dbe32.firebaseapp.com",
  projectId: "spidy-book-dbe32",
  storageBucket: "spidy-book-dbe32.firebasestorage.app",
  messagingSenderId: "681583149252",
  appId: "1:681583149252:web:f679d1847cd749d0a7c991",
  measurementId: "G-DKH77K3KEH"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();
const analytics = getAnalytics(app);

// User Profile Database Sync Helper
async function syncUserProfileToFirestore(user, defaultAvatar = "https://i.postimg.cc/D0BF1b77/file-00000000e847207a64f6711d825a859.png") {
    if (!user || !user.uid) return;
    try {
        const cleanEmail = user.email ? user.email.toLowerCase().trim() : "";
        const userRef = doc(db, "users", user.uid);
        const userSnap = await getDoc(userRef);

        const userData = {
            uid: user.uid,
            name: user.displayName || (user.email ? user.email.split('@')[0] : "User"),
            email: cleanEmail,
            photoURL: user.photoURL || defaultAvatar,
            lastLoginTime: Date.now(),
            status: "Active"
        };

        if (!userSnap.exists()) {
            userData.createdAt = serverTimestamp();
            userData.role = "user";
        }

        await setDoc(userRef, userData, { merge: true });
    } catch (err) {
        console.error("Firestore user sync error:", err);
    }
}

export { 
    app, db, auth, provider, analytics, syncUserProfileToFirestore,
    collection, addDoc, doc, updateDoc, onSnapshot, query, where, orderBy, 
    setDoc, getDoc, getDocs, limit, startAfter, Timestamp, serverTimestamp,
    signInWithEmailAndPassword, sendPasswordResetEmail, signInWithPopup, 
    onAuthStateChanged, signOut 
};
