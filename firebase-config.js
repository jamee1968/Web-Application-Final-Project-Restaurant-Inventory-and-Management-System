// Import Firebase core and Firestore modules via CDN (so no npm required!)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { 
    getFirestore, 
    doc, 
    getDoc, 
    updateDoc, 
    increment, 
    onSnapshot 
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// Your Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyDy0RF454Cwt5hdoQ5rCy_e3bRFFBPp8as",
    authDomain: "restaurant-inventory-app-f609c.firebaseapp.com",
    projectId: "restaurant-inventory-app-f609c",
    storageBucket: "restaurant-inventory-app-f609c.firebasestorage.app",
    messagingSenderId: "165151669087",
    appId: "1:165151669087:web:ca5b3194caef31048954ea"
};

// Initialize Firebase & Firestore
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// firebase-config.js — add this at the bottom, alongside your existing export
export { db, doc, getDoc, updateDoc, increment, onSnapshot, firebaseConfig };