import { initializeApp } from "firebase/app";
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signOut
} from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getDatabase } from "firebase/database";
import { getFunctions, httpsCallable } from "firebase/functions";

const runtimeConfig = window.ALWAYS_ON_CONFIG ?? {};
const firebaseConfig = runtimeConfig.firebase ?? {};

export const config = runtimeConfig;
export const configReady = Boolean(
  firebaseConfig.apiKey &&
  firebaseConfig.projectId &&
  !String(firebaseConfig.apiKey).includes("your-web-api-key")
);

export let app = null;
export let auth = null;
export let db = null;
export let rtdb = null;
export let functions = null;
export let authReady = Promise.resolve();

if (configReady) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  rtdb = getDatabase(app);
  functions = getFunctions(app, runtimeConfig.functionsRegion || "us-central1");
  authReady = setPersistence(auth, browserLocalPersistence);
}

function ensureConfigured() {
  if (!configReady || !auth || !db || !rtdb || !functions) {
    throw new Error("Firebase is not configured yet. Update web/public/config.js first.");
  }
}

export function observeAuth(callback) {
  if (!auth) {
    callback(null);
    return () => {};
  }

  return onAuthStateChanged(auth, callback);
}

export async function signInUser(email, password) {
  ensureConfigured();
  await authReady;
  return signInWithEmailAndPassword(auth, email, password);
}

export async function signUpUser(email, password) {
  ensureConfigured();
  await authReady;
  return createUserWithEmailAndPassword(auth, email, password);
}

export async function signOutUser() {
  ensureConfigured();
  return signOut(auth);
}

export async function callFunction(name, payload) {
  ensureConfigured();
  const callable = httpsCallable(functions, name);
  const result = await callable(payload);
  return result.data;
}
